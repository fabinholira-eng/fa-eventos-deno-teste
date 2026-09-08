import { cert, initializeApp } from "npm:firebase-admin/app";
import { getFirestore } from "npm:firebase-admin/firestore";

const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
const firebaseServiceAccount = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");

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

// -------------------------------------------------------
// FIREBASE / FIRESTORE
// -------------------------------------------------------

let db: ReturnType<typeof getFirestore> | null = null;

if (firebaseServiceAccount) {
  try {
    const serviceAccount = JSON.parse(firebaseServiceAccount);

    const firebaseApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });

    db = getFirestore(firebaseApp);
  } catch (erro) {
    console.error("Erro ao iniciar Firebase:", erro);
  }
}

// -------------------------------------------------------
// REGISTRAR VENDA APROVADA
// -------------------------------------------------------

async function registrarVendaAprovada(
  pagamentoId: string,
  pagamento: Record<string, unknown>,
) {
  if (!db) {
    throw new Error("Firestore não inicializado.");
  }

  const metadata =
    typeof pagamento.metadata === "object" && pagamento.metadata !== null
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
    throw new Error("Pagamento aprovado sem dados completos da venda.");
  }

  // O ID do pagamento do Mercado Pago torna a operação idempotente:
  // se o webhook for reenviado, a mesma venda será atualizada,
  // e não será criada uma segunda venda.
  const id = Number(pagamentoId);

  if (!Number.isFinite(id)) {
    throw new Error("ID de pagamento inválido.");
  }

  const referenciaVenda = db.collection("vendas").doc(pagamentoId);

  const vendaExistente = await referenciaVenda.get();

  if (vendaExistente.exists) {
    return {
      criada: false,
      ingresso: vendaExistente.data()?.ingresso ?? pagamentoId,
    };
  }

  const ingresso = `FEA-${pagamentoId}`;

  await referenciaVenda.set({
    id,
    comprador,
    telefone,
    pagamento: pagamentoForma,
    vendedorId,
    vendedorNome,
    ingresso,
    usado: false,
    cancelado: false,

    // Dados adicionais de segurança e auditoria
    mercadoPagoId: pagamentoId,
    externalReference: String(pagamento.external_reference ?? ""),
    statusPagamento: "approved",
    valor: Number(pagamento.transaction_amount ?? 15),
    comissao: 5,
    criadoEm: new Date().toISOString(),
  });

  return {
    criada: true,
    ingresso,
  };
}

// -------------------------------------------------------
// SERVIDOR
// -------------------------------------------------------

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // -----------------------------------------------------
  // ROTA PRINCIPAL
  // -----------------------------------------------------

  if (url.pathname === "/" && req.method === "GET") {
    return json({
      ok: true,
      servico: "F&A Eventos API - Deno",
      firestore: db ? "conectado" : "não conectado",
    });
  }

  // -----------------------------------------------------
  // TESTE DO TOKEN
  // -----------------------------------------------------

  if (url.pathname === "/teste-token" && req.method === "GET") {
    if (!token) {
      return json({
        ok: false,
        erro: "MERCADO_PAGO_ACCESS_TOKEN não configurado.",
      }, 500);
    }

    try {
      const resposta = await fetch(
        "https://api.mercadopago.com/users/me",
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const texto = await resposta.text();

      let dados: unknown = {};

      if (texto.trim()) {
        try {
          dados = JSON.parse(texto);
        } catch {
          dados = texto;
        }
      }

      return json({
        ok: resposta.ok,
        status: resposta.status,
        dados,
      });
    } catch (erro) {
      return json({
        ok: false,
        erro: erro instanceof Error ? erro.message : String(erro),
      }, 500);
    }
  }

  // -----------------------------------------------------
  // TESTE DE PREFERÊNCIA
  // -----------------------------------------------------

  if (url.pathname === "/teste-preferencia" && req.method === "GET") {
    if (!token) {
      return json({
        ok: false,
        erro: "MERCADO_PAGO_ACCESS_TOKEN não configurado.",
      }, 500);
    }

    try {
      const resposta = await fetch(
        "https://api.mercadopago.com/checkout/preferences",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
          },
          body: JSON.stringify({
            items: [
              {
                id: "teste-fea",
                title: "Teste F&A Eventos",
                quantity: 1,
                currency_id: "BRL",
                unit_price: 15,
              },
            ],
          }),
        },
      );

      const texto = await resposta.text();

      let dados: unknown = {};

      if (texto.trim()) {
        try {
          dados = JSON.parse(texto);
        } catch {
          dados = texto;
        }
      }

      return json({
        ok: resposta.ok,
        status: resposta.status,
        dados,
      });
    } catch (erro) {
      return json({
        ok: false,
        erro: erro instanceof Error ? erro.message : String(erro),
      }, 500);
    }
  }

  // -----------------------------------------------------
  // CRIAR PAGAMENTO
  // -----------------------------------------------------

  if (url.pathname === "/criar-pagamento" && req.method === "POST") {
    if (!token) {
      return json({
        ok: false,
        erro: "MERCADO_PAGO_ACCESS_TOKEN não configurado.",
      }, 500);
    }

    try {
      const body = await req.json();

      const comprador =
        typeof body.comprador === "string"
          ? body.comprador.trim()
          : "";

      if (!comprador) {
        return json({
          ok: false,
          erro: "Nome do comprador é obrigatório.",
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
            "cache-control": "no-cache",
          },
          body: JSON.stringify({
            items: [
              {
                id: "halloween-2026",
                title: "Halloween 2026 - A Noite das Almas",
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
              telefone:
                typeof body.telefone === "string"
                  ? body.telefone
                  : "",

              vendedor_id:
                body.vendedorId !== undefined
                  ? String(body.vendedorId)
                  : "",

              vendedor_nome:
                typeof body.vendedorNome === "string"
                  ? body.vendedorNome
                  : "",

              pagamento:
                typeof body.pagamento === "string"
                  ? body.pagamento
                  : "",
            },
          }),
        },
      );

      const texto = await resposta.text();

      let dados: Record<string, unknown> = {};

      if (texto.trim()) {
        try {
          dados = JSON.parse(texto);
        } catch {
          dados = {};
        }
      }

      if (!resposta.ok) {
        return json({
          ok: false,
          erro: "Mercado Pago recusou a criação da preferência.",
          statusMercadoPago: resposta.status,
          detalhes: dados,
        }, 502);
      }

      return json({
        ok: true,
        preferenceId: dados.id ?? null,
        initPoint: dados.init_point ?? null,
        sandboxInitPoint: dados.sandbox_init_point ?? null,
        externalReference,
      });
    } catch (erro) {
      return json({
        ok: false,
        erro: erro instanceof Error ? erro.message : String(erro),
      }, 500);
    }
  }

  // -----------------------------------------------------
  // WEBHOOK MERCADO PAGO
  // -----------------------------------------------------

  if (url.pathname === "/webhook" && req.method === "POST") {
    if (!token) {
      return json({
        ok: false,
        erro: "MERCADO_PAGO_ACCESS_TOKEN não configurado.",
      }, 500);
    }

    try {
      let body: Record<string, unknown> = {};

      try {
        body = await req.json();
      } catch {
        body = {};
      }

      const data =
        typeof body.data === "object" && body.data !== null
          ? body.data as Record<string, unknown>
          : {};

      const pagamentoId = String(
        data.id ??
          body.id ??
          url.searchParams.get("data.id") ??
          url.searchParams.get("id") ??
          "",
      ).trim();

      if (!pagamentoId) {
        return json({
          ok: true,
          mensagem: "Notificação recebida sem ID de pagamento.",
        });
      }

      // Nunca confiamos apenas no conteúdo do webhook.
      // Consultamos o pagamento diretamente no Mercado Pago.
      const respostaPagamento = await fetch(
        `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!respostaPagamento.ok) {
        return json({
          ok: true,
          mensagem:
            "Notificação recebida. Pagamento ainda não localizado.",
          pagamentoId,
        });
      }

      const pagamento =
        await respostaPagamento.json() as Record<string, unknown>;

      if (pagamento.status !== "approved") {
        return json({
          ok: true,
          pagamentoId,
          status: pagamento.status ?? null,
          mensagem:
            "Pagamento recebido, mas ainda não aprovado.",
        });
      }

      // Somente aqui uma venda passa a existir.
      const resultadoVenda = await registrarVendaAprovada(
        pagamentoId,
        pagamento,
      );

      return json({
        ok: true,
        pagamentoId,
        status: "approved",
        externalReference:
          pagamento.external_reference ?? null,
        vendaRegistrada: resultadoVenda.criada,
        ingresso: resultadoVenda.ingresso,
        mensagem: resultadoVenda.criada
          ? "Pagamento aprovado. Venda registrada no Firestore."
          : "Pagamento aprovado. A venda já estava registrada.",
      });
    } catch (erro) {
      console.error("Erro no webhook:", erro);

      // Aqui devolvemos erro para que uma falha real de gravação
      // não seja silenciosamente considerada concluída.
      return json({
        ok: false,
        erro:
          erro instanceof Error
            ? erro.message
            : String(erro),
      }, 500);
    }
  }

  // -----------------------------------------------------
  // CONSULTAR PAGAMENTO
  // -----------------------------------------------------

  if (
    url.pathname.startsWith("/status-pagamento/") &&
    req.method === "GET"
  ) {
    if (!token) {
      return json({
        ok: false,
        erro: "MERCADO_PAGO_ACCESS_TOKEN não configurado.",
      }, 500);
    }

    const pagamentoId =
      url.pathname.split("/").pop()?.trim() ?? "";

    if (!pagamentoId) {
      return json({
        ok: false,
        erro: "ID do pagamento não informado.",
      }, 400);
    }

    try {
      const resposta = await fetch(
        `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const texto = await resposta.text();

      let dados: Record<string, unknown> = {};

      if (texto.trim()) {
        try {
          dados = JSON.parse(texto);
        } catch {
          dados = {};
        }
      }

      if (!resposta.ok) {
        return json({
          ok: false,
          erro: "Não foi possível consultar o pagamento.",
          statusMercadoPago: resposta.status,
        }, resposta.status === 404 ? 404 : 502);
      }

      return json({
        ok: true,
        pagamentoId,
        status: dados.status ?? null,
        externalReference:
          dados.external_reference ?? null,
        metadata: dados.metadata ?? {},
      });
    } catch (erro) {
      return json({
        ok: false,
        erro:
          erro instanceof Error
            ? erro.message
            : String(erro),
      }, 500);
    }
  }

  return json({
    ok: false,
    erro: "Rota não encontrada.",
  }, 404);
});
