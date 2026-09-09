import { cert, initializeApp } from "npm:firebase-admin/app";
import { getFirestore } from "npm:firebase-admin/firestore";
import { getAuth } from "npm:firebase-admin/auth";

const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
const firebaseServiceAccount = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
const webhookSecret = Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

let db: ReturnType<typeof getFirestore> | null = null;
let firebaseAuth: ReturnType<typeof getAuth> | null = null;

if (firebaseServiceAccount) {
  try {
    const serviceAccount = JSON.parse(firebaseServiceAccount);

    const firebaseApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });

    db = getFirestore(firebaseApp);
    firebaseAuth = getAuth(firebaseApp);
  } catch (erro) {
    console.error("Erro ao iniciar Firebase:", erro);
  }
}

async function validarUsuarioFirebase(req: Request) {
  if (!firebaseAuth) {
    throw new Error("Firebase Auth não inicializado.");
  }

  const authorization = req.headers.get("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }

  const idToken = authorization.substring(7).trim();

  if (!idToken) {
    return null;
  }

  try {
    const usuario = await firebaseAuth.verifyIdToken(idToken);
    return usuario;
  } catch (erro) {
    console.warn("Token Firebase inválido:", erro);
    return null;
  }
}

async function gerarHmacSha256(
  secret: string,
  mensagem: string,
) {
  const encoder = new TextEncoder();

  const chave = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const assinatura = await crypto.subtle.sign(
    "HMAC",
    chave,
    encoder.encode(mensagem),
  );

  return Array.from(new Uint8Array(assinatura))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function compararSeguro(a: string, b: string) {
  if (a.length !== b.length) return false;

  let resultado = 0;

  for (let i = 0; i < a.length; i++) {
    resultado |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return resultado === 0;
}

async function validarAssinaturaWebhook(req: Request) {
  if (!webhookSecret) {
    console.error("MERCADO_PAGO_WEBHOOK_SECRET não configurado.");
    return false;
  }

  const assinaturaHeader = req.headers.get("x-signature");
  const requestId = req.headers.get("x-request-id");

  if (!assinaturaHeader || !requestId) {
    return false;
  }

  const partes = assinaturaHeader.split(",");

  let ts = "";
  let v1 = "";

  for (const parte of partes) {
    const [chave, valor] = parte.trim().split("=");

    if (chave === "ts") ts = valor ?? "";
    if (chave === "v1") v1 = valor ?? "";
  }

  if (!ts || !v1) {
    return false;
  }

  const url = new URL(req.url);

  const dataId =
    url.searchParams.get("data.id") ??
    url.searchParams.get("data_id") ??
    "";

  if (!dataId) {
    return false;
  }

  const manifesto =
    `id:${dataId};request-id:${requestId};ts:${ts};`;

  const assinaturaCalculada = await gerarHmacSha256(
    webhookSecret,
    manifesto,
  );

  return compararSeguro(
    assinaturaCalculada.toLowerCase(),
    v1.toLowerCase(),
  );
}

async function registrarVendaAprovada(
  pagamentoId: string,
  pagamento: Record<string, unknown>,
) {
  if (!db) {
    throw new Error("Firestore não inicializado.");
  }

  const metadata =
    typeof pagamento.metadata === "object" &&
      pagamento.metadata !== null
      ? pagamento.metadata as Record<string, unknown>
      : {};

  const comprador = String(metadata.comprador ?? "").trim();
  const telefone = String(metadata.telefone ?? "").trim();
  const pagamentoForma = String(metadata.pagamento ?? "").trim();
  const vendedorNome = String(metadata.vendedor_nome ?? "").trim();

  const vendedorIdTexto = String(metadata.vendedor_id ?? "").trim();
  const vendedorId = Number(vendedorIdTexto);

  if (
    !comprador ||
    !vendedorNome ||
    !vendedorIdTexto ||
    !Number.isFinite(vendedorId)
  ) {
    throw new Error(
      "Pagamento aprovado sem dados completos da venda.",
    );
  }

  const id = Number(pagamentoId);

  if (!Number.isFinite(id)) {
    throw new Error("ID de pagamento inválido.");
  }

  const referenciaVenda =
    db.collection("vendas").doc(pagamentoId);

  const referenciaContador =
    db.collection("config").doc("contadorIngressos");

  const resultado = await db.runTransaction(
    async (transaction) => {
      const vendaExistente =
        await transaction.get(referenciaVenda);

      if (vendaExistente.exists) {
        return {
          criada: false,
          ingresso: String(
            vendaExistente.data()?.ingresso ?? pagamentoId,
          ),
        };
      }

      const contadorSnapshot =
        await transaction.get(referenciaContador);

      if (!contadorSnapshot.exists) {
        throw new Error(
          "Contador de ingressos não encontrado.",
        );
      }

      const ultimoNumero = Number(
        contadorSnapshot.data()?.ultimoNumero ?? 0,
      );

      if (!Number.isFinite(ultimoNumero)) {
        throw new Error(
          "Contador de ingressos inválido.",
        );
      }

      const proximoNumero = ultimoNumero + 1;

      if (proximoNumero > 500) {
        throw new Error(
          "Todos os 500 ingressos já foram vendidos.",
        );
      }

      const ingresso =
        `F&A-${String(proximoNumero).padStart(4, "0")}`;

      transaction.update(referenciaContador, {
        ultimoNumero: proximoNumero,
      });

      transaction.set(referenciaVenda, {
        id,
        comprador,
        telefone,
        pagamento: pagamentoForma,
        vendedorId,
        vendedorNome,
        ingresso,
        usado: false,
        cancelado: false,
        mercadoPagoId: pagamentoId,
        externalReference: String(
          pagamento.external_reference ?? "",
        ),
        statusPagamento: "approved",
        valor: Number(
          pagamento.transaction_amount ?? 15,
        ),
        comissao: 5,
        criadoEm: new Date().toISOString(),
      });

      return {
        criada: true,
        ingresso,
      };
    },
  );

  return resultado;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/") {
    return json({
      ok: true,
      servico: "F&A Eventos API - Deno",
      firestore: db ? "conectado" : "não conectado",
      autenticacao: firebaseAuth ? "conectada" : "não conectada",
    });
  }

  if (
    req.method === "GET" &&
    url.pathname === "/teste-token"
  ) {
    if (!token) {
      return json({
        ok: false,
        erro: "Token do Mercado Pago não configurado.",
      }, 500);
    }

    const resposta = await fetch(
      "https://api.mercadopago.com/users/me",
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const dados = await resposta.json();

    return json({
      status: resposta.status,
      dados,
    });
  }

  if (
    req.method === "GET" &&
    url.pathname === "/teste-preferencia"
  ) {
    if (!token) {
      return json({
        ok: false,
        erro: "Token do Mercado Pago não configurado.",
      }, 500);
    }

    const resposta = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [
            {
              title: "Ingresso F&A Eventos",
              quantity: 1,
              unit_price: 15,
              currency_id: "BRL",
            },
          ],
        }),
      },
    );

    const dados = await resposta.json();

    return json({
      status: resposta.status,
      dados,
    });
  }

  if (
    req.method === "POST" &&
    url.pathname === "/criar-pagamento"
  ) {
    try {
      if (!token) {
        return json({
          erro: "Token do Mercado Pago não configurado.",
        }, 500);
      }

      const usuarioAutenticado =
        await validarUsuarioFirebase(req);

      if (!usuarioAutenticado) {
        return json({
          erro:
            "Usuário não autenticado ou sessão inválida.",
        }, 401);
      }

      const corpo = await req.json();

      const comprador =
        String(corpo.comprador ?? "").trim();

      const telefone =
        String(corpo.telefone ?? "").trim();

      const vendedorId =
        Number(corpo.vendedorId);

      const vendedorNome =
        String(corpo.vendedorNome ?? "").trim();

      const pagamento =
        String(corpo.pagamento ?? "").trim();

      if (
        !comprador ||
        !vendedorNome ||
        !Number.isFinite(vendedorId)
      ) {
        return json({
          erro: "Dados da venda incompletos.",
        }, 400);
      }

      const externalReference = crypto.randomUUID();

      const resposta = await fetch(
        "https://api.mercadopago.com/checkout/preferences",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            items: [
              {
                id: "INGRESSO-HALLOWEEN-2026",
                title:
                  "Halloween 2026 - A Noite das Almas",
                description: "Ingresso individual",
                quantity: 1,
                currency_id: "BRL",
                unit_price: 15,
              },
            ],

            payer: {
              name: comprador,
            },

            external_reference: externalReference,

            notification_url:
              "https://fa-eventos-deno-teste.fa-producoes.deno.net/webhook",

            metadata: {
              comprador,
              telefone,
              vendedor_id: String(vendedorId),
              vendedor_nome: vendedorNome,
              pagamento,
              usuario_uid: usuarioAutenticado.uid,
            },
          }),
        },
      );

      const dados = await resposta.json();

      if (!resposta.ok) {
        console.error(
          "Erro Mercado Pago:",
          resposta.status,
          dados,
        );

        return json({
          erro: "Erro ao criar pagamento.",
          detalhe: dados,
        }, resposta.status);
      }

      return json({
        preferenceId: dados.id,
        initPoint: dados.init_point,
        sandboxInitPoint: dados.sandbox_init_point,
        externalReference,
      });
    } catch (erro) {
      console.error(
        "Erro em /criar-pagamento:",
        erro,
      );

      return json({
        erro: "Erro interno ao criar pagamento.",
      }, 500);
    }
  }

  if (
    req.method === "POST" &&
    url.pathname === "/webhook"
  ) {
    try {
      const assinaturaValida =
        await validarAssinaturaWebhook(req);

      if (!assinaturaValida) {
        console.warn(
          "Webhook recusado: assinatura inválida.",
        );

        return json({
          erro: "Assinatura inválida.",
        }, 401);
      }

      if (!token) {
        return json({
          erro: "Token do Mercado Pago não configurado.",
        }, 500);
      }

      let corpo: Record<string, unknown> = {};

      try {
        corpo = await req.json();
      } catch {
        corpo = {};
      }

      const data =
        typeof corpo.data === "object" &&
          corpo.data !== null
          ? corpo.data as Record<string, unknown>
          : {};

      const pagamentoId =
        url.searchParams.get("data.id") ??
        url.searchParams.get("data_id") ??
        String(data.id ?? "").trim();

      if (!pagamentoId) {
        return json({
          recebido: true,
          mensagem:
            "Notificação sem ID de pagamento.",
        });
      }

      const respostaPagamento = await fetch(
        `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!respostaPagamento.ok) {
        const detalhe =
          await respostaPagamento.text();

        console.error(
          "Erro ao consultar pagamento:",
          respostaPagamento.status,
          detalhe,
        );

        return json({
          erro:
            "Não foi possível validar o pagamento.",
        }, 500);
      }

      const pagamento =
        await respostaPagamento.json();

      if (pagamento.status !== "approved") {
        return json({
          recebido: true,
          pagamentoId,
          status: pagamento.status,
          mensagem:
            "Pagamento ainda não aprovado.",
        });
      }

      const venda =
        await registrarVendaAprovada(
          pagamentoId,
          pagamento,
        );

      return json({
        recebido: true,
        pagamentoId,
        status: "approved",
        vendaRegistrada: venda.criada,
        ingresso: venda.ingresso,
      });
    } catch (erro) {
      console.error("Erro no webhook:", erro);

      return json({
        erro:
          "Erro interno ao processar webhook.",
      }, 500);
    }
  }

  if (
    req.method === "GET" &&
    url.pathname.startsWith(
      "/status-pagamento/",
    )
  ) {
    try {
      if (!token) {
        return json({
          erro: "Token do Mercado Pago não configurado.",
        }, 500);
      }

      const pagamentoId =
        url.pathname.split("/").pop();

      if (!pagamentoId) {
        return json({
          erro: "ID de pagamento não informado.",
        }, 400);
      }

      const resposta = await fetch(
        `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const pagamento = await resposta.json();

      if (!resposta.ok) {
        return json({
          erro:
            "Não foi possível consultar o pagamento.",
          detalhe: pagamento,
        }, resposta.status);
      }

      return json({
        id: pagamento.id,
        status: pagamento.status,
        externalReference:
          pagamento.external_reference,
        metadata: pagamento.metadata,
      });
    } catch (erro) {
      console.error(
        "Erro ao consultar pagamento:",
        erro,
      );

      return json({
        erro:
          "Erro interno ao consultar pagamento.",
      }, 500);
    }
  }

  return json({
    erro: "Rota não encontrada.",
  }, 404);
});
