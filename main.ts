import { cert, initializeApp } from "npm:firebase-admin/app";
import { getFirestore } from "npm:firebase-admin/firestore";
import { getAuth } from "npm:firebase-admin/auth";

const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
const firebaseServiceAccount = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
const webhookSecret = Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET");

const LIMITE_INGRESSOS = 500;
const TEMPO_RESERVA_MINUTOS = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://fea-eventos.web.app",
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
    return await firebaseAuth.verifyIdToken(idToken);
  } catch (erro) {
    console.warn("Token Firebase inválido:", erro);
    return null;
  }
}

async function obterVendedorAutorizado(
  uid: string,
  vendedorIdRecebido: number,
) {
  if (!db) {
    throw new Error("Firestore não inicializado.");
  }

  const perfilSnapshot =
    await db.collection("usuarios").doc(uid).get();

  if (!perfilSnapshot.exists) {
    throw new Error("Perfil do usuário não encontrado.");
  }

  const perfil = perfilSnapshot.data() ?? {};
  const papel = String(perfil.papel ?? "").trim();

  if (papel === "portaria") {
    throw new Error(
      "Usuário da portaria não pode criar pagamentos.",
    );
  }

  if (papel !== "admin" && papel !== "vendedor") {
    throw new Error(
      "Perfil sem permissão para criar pagamentos.",
    );
  }

  if (papel === "vendedor") {
    const vendedorIdDoPerfil = Number(perfil.vendedorId);

    if (
      !Number.isFinite(vendedorIdDoPerfil) ||
      vendedorIdDoPerfil !== vendedorIdRecebido
    ) {
      throw new Error(
        "Vendedor não autorizado para esta operação.",
      );
    }
  }

  const vendedoresSnapshot =
    await db
      .collection("vendedores")
      .where("id", "==", vendedorIdRecebido)
      .limit(1)
      .get();

  if (vendedoresSnapshot.empty) {
    throw new Error("Vendedor não encontrado.");
  }

  const vendedor = vendedoresSnapshot.docs[0].data();

  if (vendedor.ativo === false) {
    throw new Error("Vendedor inativo.");
  }

  const vendedorNome =
    String(vendedor.nome ?? "").trim();

  if (!vendedorNome) {
    throw new Error("Vendedor sem nome cadastrado.");
  }

  return {
    id: vendedorIdRecebido,
    nome: vendedorNome,
  };
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
    console.error(
      "MERCADO_PAGO_WEBHOOK_SECRET não configurado.",
    );
    return false;
  }

  const assinaturaHeader =
    req.headers.get("x-signature");

  const requestId =
    req.headers.get("x-request-id");

  if (!assinaturaHeader || !requestId) {
    return false;
  }

  let ts = "";
  let v1 = "";

  for (const parte of assinaturaHeader.split(",")) {
    const [chave, valor] =
      parte.trim().split("=");

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

  const assinaturaCalculada =
    await gerarHmacSha256(
      webhookSecret,
      manifesto,
    );

  return compararSeguro(
    assinaturaCalculada.toLowerCase(),
    v1.toLowerCase(),
  );
}

async function limparReservasExpiradas() {
  if (!db) {
    throw new Error("Firestore não inicializado.");
  }

  const agoraMs = Date.now();

  // Consulta somente por status para não depender de índice composto.
  // A comparação da expiração é feita no servidor.
  const aguardando =
    await db
      .collection("pedidosPagamento")
      .where("status", "==", "aguardando")
      .limit(LIMITE_INGRESSOS)
      .get();

  for (const documento of aguardando.docs) {
    const dados = documento.data() ?? {};
    const expiraEmMs = Date.parse(String(dados.expiraEm ?? ""));

    if (!Number.isFinite(expiraEmMs) || expiraEmMs > agoraMs) {
      continue;
    }

    const pedidoRef = documento.ref;
    const contadorRef =
      db.collection("config").doc("contadorIngressos");

    try {
      await db.runTransaction(async (transaction) => {
        const pedidoSnapshot =
          await transaction.get(pedidoRef);

        const contadorSnapshot =
          await transaction.get(contadorRef);

        if (!pedidoSnapshot.exists) return;

        const pedido = pedidoSnapshot.data() ?? {};

        if (pedido.status !== "aguardando") {
          return;
        }

        const expiraAtualMs =
          Date.parse(String(pedido.expiraEm ?? ""));

        if (
          !Number.isFinite(expiraAtualMs) ||
          expiraAtualMs > Date.now()
        ) {
          return;
        }

        if (!contadorSnapshot.exists) {
          throw new Error(
            "Contador de ingressos não encontrado.",
          );
        }

        const reservasAtivas = Number(
          contadorSnapshot.data()?.reservasAtivas ?? 0,
        );

        transaction.update(contadorRef, {
          reservasAtivas:
            Math.max(0, reservasAtivas - 1),
        });

        transaction.update(pedidoRef, {
          status: "expirada",
          atualizadoEm: new Date().toISOString(),
        });
      });
    } catch (erro) {
      console.warn(
        "Não foi possível liberar reserva expirada:",
        documento.id,
        erro,
      );
    }
  }
}

async function garantirContadorInicializado() {
  if (!db) {
    throw new Error("Firestore não inicializado.");
  }

  const contadorRef =
    db.collection("config").doc("contadorIngressos");

  const contadorSnapshot = await contadorRef.get();

  if (!contadorSnapshot.exists) {
    throw new Error(
      "Contador de ingressos não encontrado.",
    );
  }

  const dadosContador = contadorSnapshot.data() ?? {};
  const vendasAtivasAtual = Number(
    dadosContador.vendasAtivas,
  );

  if (Number.isFinite(vendasAtivasAtual)) {
    return;
  }

  const vendasSnapshot =
    await db
      .collection("vendas")
      .where("cancelado", "==", false)
      .limit(LIMITE_INGRESSOS)
      .get();

  const quantidadeAtivas = vendasSnapshot.size;

  await db.runTransaction(async (transaction) => {
    const atual = await transaction.get(contadorRef);

    if (!atual.exists) {
      throw new Error(
        "Contador de ingressos não encontrado.",
      );
    }

    const valorExistente = Number(
      atual.data()?.vendasAtivas,
    );

    if (Number.isFinite(valorExistente)) {
      return;
    }

    transaction.update(contadorRef, {
      vendasAtivas: quantidadeAtivas,
    });
  });
}

async function reservarVaga(
  externalReference: string,
  dados: {
    comprador: string;
    telefone: string;
    pagamento: string;
    vendedorId: number;
    vendedorNome: string;
    usuarioUid: string;
  },
) {
  if (!db) {
    throw new Error("Firestore não inicializado.");
  }

  const contadorRef =
    db.collection("config").doc("contadorIngressos");

  const pedidoRef =
    db
      .collection("pedidosPagamento")
      .doc(externalReference);

  const agora = new Date();

  const expiracao =
    new Date(
      agora.getTime() +
        TEMPO_RESERVA_MINUTOS * 60 * 1000,
    );

  await db.runTransaction(async (transaction) => {
    const contadorSnapshot =
      await transaction.get(contadorRef);

    if (!contadorSnapshot.exists) {
      throw new Error(
        "Contador de ingressos não encontrado.",
      );
    }

    const vendasAtivas = Number(
      contadorSnapshot.data()?.vendasAtivas ?? 0,
    );

    const reservasAtivas = Number(
      contadorSnapshot.data()?.reservasAtivas ?? 0,
    );

    if (
      !Number.isFinite(vendasAtivas) ||
      !Number.isFinite(reservasAtivas)
    ) {
      throw new Error(
        "Contador de ingressos inválido.",
      );
    }

    if (
      vendasAtivas + reservasAtivas >=
      LIMITE_INGRESSOS
    ) {
      throw new Error("INGRESSOS_ESGOTADOS");
    }

    transaction.update(contadorRef, {
      reservasAtivas: reservasAtivas + 1,
    });

    transaction.set(pedidoRef, {
      externalReference,
      comprador: dados.comprador,
      telefone: dados.telefone,
      pagamento: dados.pagamento,
      vendedorId: dados.vendedorId,
      vendedorNome: dados.vendedorNome,
      usuarioUid: dados.usuarioUid,
      valorEsperado: 15,
      moedaEsperada: "BRL",
      status: "aguardando",
      criadoEm: agora.toISOString(),
      atualizadoEm: agora.toISOString(),
      expiraEm: expiracao.toISOString(),
    });
  });

  return {
    inicio: agora,
    expiracao,
  };
}

async function liberarReserva(
  externalReference: string,
  novoStatus: string,
) {
  if (!db) return;

  const pedidoRef =
    db
      .collection("pedidosPagamento")
      .doc(externalReference);

  const contadorRef =
    db.collection("config").doc("contadorIngressos");

  await db.runTransaction(async (transaction) => {
    const pedidoSnapshot =
      await transaction.get(pedidoRef);

    if (!pedidoSnapshot.exists) {
      return;
    }

    const pedido = pedidoSnapshot.data() ?? {};

    const reservaContabilizada =
      pedido.status === "aguardando" ||
      pedido.status === "pendente";

    if (!reservaContabilizada) {
      return;
    }

    const contadorSnapshot =
      await transaction.get(contadorRef);

    if (!contadorSnapshot.exists) {
      throw new Error(
        "Contador de ingressos não encontrado.",
      );
    }

    const reservasAtivas = Number(
      contadorSnapshot.data()?.reservasAtivas ?? 0,
    );

    transaction.update(contadorRef, {
      reservasAtivas:
        Math.max(0, reservasAtivas - 1),
    });

    transaction.update(pedidoRef, {
      status: novoStatus,
      atualizadoEm: new Date().toISOString(),
    });
  });
}

async function marcarReservaPendente(
  externalReference: string,
  pagamentoId: string,
  statusPagamento: string,
) {
  if (!db || !externalReference) return;

  const pedidoRef =
    db
      .collection("pedidosPagamento")
      .doc(externalReference);

  await db.runTransaction(async (transaction) => {
    const pedidoSnapshot =
      await transaction.get(pedidoRef);

    if (!pedidoSnapshot.exists) {
      return;
    }

    const pedido = pedidoSnapshot.data() ?? {};

    if (
      pedido.status !== "aguardando" &&
      pedido.status !== "pendente"
    ) {
      return;
    }

    transaction.update(pedidoRef, {
      status: "pendente",
      statusPagamento,
      mercadoPagoId: pagamentoId,
      atualizadoEm: new Date().toISOString(),
    });
  });
}

async function registrarIncidentePagamento(
  pagamentoId: string,
  motivo: string,
  dados: Record<string, unknown>,
) {
  if (!db) return;

  await db
    .collection("incidentesPagamento")
    .doc(pagamentoId)
    .set(
      {
        pagamentoId,
        motivo,
        ...dados,
        atualizadoEm: new Date().toISOString(),
      },
      { merge: true },
    );
}

async function marcarVendaRevertida(
  pagamentoId: string,
  pagamento: Record<string, unknown>,
  status: string,
) {
  if (!db) {
    throw new Error("Firestore não inicializado.");
  }

  const externalReference =
    String(
      pagamento.external_reference ?? "",
    ).trim();

  const statusDetail =
    String(
      pagamento.status_detail ?? "",
    ).trim();

  const vendaRef =
    db.collection("vendas").doc(pagamentoId);

  const contadorRef =
    db.collection("config").doc("contadorIngressos");

  const pedidoRef = externalReference
    ? db
      .collection("pedidosPagamento")
      .doc(externalReference)
    : null;

  await db.runTransaction(async (transaction) => {
    const vendaSnapshot =
      await transaction.get(vendaRef);

    const contadorSnapshot =
      await transaction.get(contadorRef);

    const pedidoSnapshot = pedidoRef
      ? await transaction.get(pedidoRef)
      : null;

    if (!contadorSnapshot.exists) {
      throw new Error(
        "Contador de ingressos não encontrado.",
      );
    }

    const vendasAtivas = Number(
      contadorSnapshot.data()?.vendasAtivas ?? 0,
    );

    if (!Number.isFinite(vendasAtivas)) {
      throw new Error(
        "Contador de ingressos inválido.",
      );
    }

    if (vendaSnapshot.exists) {
      const venda = vendaSnapshot.data() ?? {};
      const jaCancelada = venda.cancelado === true;

      if (!jaCancelada) {
        transaction.update(contadorRef, {
          vendasAtivas:
            Math.max(0, vendasAtivas - 1),
        });
      }

      transaction.update(vendaRef, {
        cancelado: true,
        statusPagamento: status,
        statusDetalhe: statusDetail,
        estornado: status === "refunded",
        chargeback: status === "charged_back",
        atualizadoEm: new Date().toISOString(),
      });
    }

    if (
      pedidoRef &&
      pedidoSnapshot &&
      pedidoSnapshot.exists
    ) {
      transaction.update(pedidoRef, {
        status,
        statusPagamento: status,
        statusDetalhe: statusDetail,
        atualizadoEm: new Date().toISOString(),
      });
    }
  });
}

async function cancelarVendaAdministrativamente(
  uid: string,
  pagamentoId: string,
) {
  if (!db) {
    throw new Error("Firestore não inicializado.");
  }

  const perfilSnapshot =
    await db.collection("usuarios").doc(uid).get();

  if (!perfilSnapshot.exists) {
    throw new Error("PERFIL_NAO_ENCONTRADO");
  }

  const papel =
    String(perfilSnapshot.data()?.papel ?? "").trim();

  if (papel !== "admin") {
    throw new Error("SEM_PERMISSAO");
  }

  const vendaRef =
    db.collection("vendas").doc(pagamentoId);

  const contadorRef =
    db.collection("config").doc("contadorIngressos");

  return await db.runTransaction(
    async (transaction) => {
      const vendaSnapshot =
        await transaction.get(vendaRef);

      const contadorSnapshot =
        await transaction.get(contadorRef);

      if (!vendaSnapshot.exists) {
        throw new Error("VENDA_NAO_ENCONTRADA");
      }

      if (!contadorSnapshot.exists) {
        throw new Error(
          "Contador de ingressos não encontrado.",
        );
      }

      const venda = vendaSnapshot.data() ?? {};

      if (venda.cancelado === true) {
        return {
          cancelada: false,
          jaCancelada: true,
        };
      }

      const vendasAtivas = Number(
        contadorSnapshot.data()?.vendasAtivas ?? 0,
      );

      if (!Number.isFinite(vendasAtivas)) {
        throw new Error(
          "Contador de ingressos inválido.",
        );
      }

      transaction.update(contadorRef, {
        vendasAtivas:
          Math.max(0, vendasAtivas - 1),
      });

      transaction.update(vendaRef, {
        cancelado: true,
        canceladaManualmente: true,
        canceladoPorUid: uid,
        canceladoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
      });

      return {
        cancelada: true,
        jaCancelada: false,
      };
    },
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

  const comprador =
    String(metadata.comprador ?? "").trim();

  const telefone =
    String(metadata.telefone ?? "").trim();

  const vendedorNome =
    String(metadata.vendedor_nome ?? "").trim();

  const vendedorIdTexto =
    String(metadata.vendedor_id ?? "").trim();

  const vendedorId =
    Number(vendedorIdTexto);

  const externalReference =
    String(
      pagamento.external_reference ?? "",
    ).trim();

  const paymentMethodId =
    String(
      pagamento.payment_method_id ?? "",
    ).trim();

  const paymentTypeId =
    String(
      pagamento.payment_type_id ?? "",
    ).trim();

  const valorPagamento =
    Number(pagamento.transaction_amount);

  const moedaPagamento =
    String(pagamento.currency_id ?? "").trim();

  let pagamentoForma = "Mercado Pago";

  if (paymentMethodId === "pix") {
    pagamentoForma = "PIX";
  } else if (paymentTypeId === "credit_card") {
    pagamentoForma = "Cartão de crédito";
  } else if (paymentTypeId === "debit_card") {
    pagamentoForma = "Cartão de débito";
  } else if (paymentTypeId === "ticket") {
    pagamentoForma = "Boleto";
  } else if (paymentTypeId === "account_money") {
    pagamentoForma = "Saldo Mercado Pago";
  } else if (paymentTypeId === "bank_transfer") {
    pagamentoForma = "Transferência bancária";
  } else if (paymentMethodId) {
    pagamentoForma = paymentMethodId;
  } else if (paymentTypeId) {
    pagamentoForma = paymentTypeId;
  }

  if (
    !comprador ||
    !vendedorNome ||
    !vendedorIdTexto ||
    !Number.isFinite(vendedorId) ||
    !externalReference
  ) {
    throw new Error(
      "Pagamento aprovado sem dados completos da venda.",
    );
  }

  const id = Number(pagamentoId);

  if (!Number.isFinite(id)) {
    throw new Error("ID de pagamento inválido.");
  }

  const vendaRef =
    db.collection("vendas").doc(pagamentoId);

  const contadorRef =
    db.collection("config").doc("contadorIngressos");

  const pedidoRef =
    db
      .collection("pedidosPagamento")
      .doc(externalReference);

  return await db.runTransaction(
    async (transaction) => {
      const vendaExistente =
        await transaction.get(vendaRef);

      if (vendaExistente.exists) {
        return {
          criada: false,
          ingresso: String(
            vendaExistente.data()?.ingresso ?? "",
          ),
          revisaoManual: false,
        };
      }

      const contadorSnapshot =
        await transaction.get(contadorRef);

      const pedidoSnapshot =
        await transaction.get(pedidoRef);

      if (!contadorSnapshot.exists) {
        throw new Error(
          "Contador de ingressos não encontrado.",
        );
      }

      if (!pedidoSnapshot.exists) {
        throw new Error(
          "Reserva do pagamento não encontrada.",
        );
      }

      const ultimoNumero = Number(
        contadorSnapshot.data()?.ultimoNumero ?? 0,
      );

      const vendasAtivas = Number(
        contadorSnapshot.data()?.vendasAtivas ?? 0,
      );

      const reservasAtivas = Number(
        contadorSnapshot.data()?.reservasAtivas ?? 0,
      );

      if (
        !Number.isFinite(ultimoNumero) ||
        !Number.isFinite(vendasAtivas) ||
        !Number.isFinite(reservasAtivas)
      ) {
        throw new Error(
          "Contador de ingressos inválido.",
        );
      }

      const pedido = pedidoSnapshot.data() ?? {};

      const reservaContabilizada =
        pedido.status === "aguardando" ||
        pedido.status === "pendente";

      const valorEsperado =
        Number(pedido.valorEsperado ?? 15);

      const moedaEsperada =
        String(pedido.moedaEsperada ?? "BRL");

      if (
        !Number.isFinite(valorPagamento) ||
        valorPagamento !== valorEsperado ||
        moedaPagamento !== moedaEsperada
      ) {
        transaction.update(pedidoRef, {
          status: "approved_valor_invalido",
          statusPagamento: "approved",
          mercadoPagoId: pagamentoId,
          requerRevisaoManual: true,
          motivoRevisao: "valor_ou_moeda_invalido",
          atualizadoEm: new Date().toISOString(),
        });

        if (reservaContabilizada) {
          transaction.update(contadorRef, {
            reservasAtivas:
              Math.max(0, reservasAtivas - 1),
          });
        }

        return {
          criada: false,
          ingresso: "",
          revisaoManual: true,
          motivo: "valor_ou_moeda_invalido",
        };
      }

      // Se a reserva ainda está contabilizada, a vaga já estava protegida.
      // Se ela havia expirado/liberado, somente aceitamos a aprovação tardia
      // quando ainda há capacidade real disponível.
      if (
        !reservaContabilizada &&
        vendasAtivas + reservasAtivas >=
          LIMITE_INGRESSOS
      ) {
        transaction.update(pedidoRef, {
          status: "approved_sem_vaga",
          statusPagamento: "approved",
          mercadoPagoId: pagamentoId,
          requerRevisaoManual: true,
          motivoRevisao: "aprovacao_tardia_sem_vaga",
          pagamento: pagamentoForma,
          paymentMethodId,
          paymentTypeId,
          atualizadoEm: new Date().toISOString(),
        });

        return {
          criada: false,
          ingresso: "",
          revisaoManual: true,
          motivo: "aprovacao_tardia_sem_vaga",
        };
      }

      const proximoNumero =
        ultimoNumero + 1;

      const ingresso =
        `F&A-${String(proximoNumero).padStart(
          4,
          "0",
        )}`;

      transaction.update(contadorRef, {
        ultimoNumero: proximoNumero,
        vendasAtivas: vendasAtivas + 1,
        reservasAtivas: reservaContabilizada
          ? Math.max(0, reservasAtivas - 1)
          : reservasAtivas,
      });

      transaction.update(pedidoRef, {
        status: "approved",
        statusPagamento: "approved",
        mercadoPagoId: pagamentoId,
        ingresso,
        pagamento: pagamentoForma,
        paymentMethodId,
        paymentTypeId,
        atualizadoEm: new Date().toISOString(),
      });

      transaction.set(vendaRef, {
        id,
        comprador,
        telefone,
        pagamento: pagamentoForma,
        paymentMethodId,
        paymentTypeId,
        vendedorId,
        vendedorNome,
        ingresso,
        usado: false,
        cancelado: false,
        mercadoPagoId: pagamentoId,
        externalReference,
        statusPagamento: "approved",
        valor: valorPagamento,
        comissao: 5,
        criadoEm: new Date().toISOString(),
      });

      return {
        criada: true,
        ingresso,
        revisaoManual: false,
      };
    },
  );
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const url = new URL(req.url);

  if (
    req.method === "GET" &&
    url.pathname === "/"
  ) {
    return json({
      ok: true,
      servico: "F&A Eventos API",
    });
  }

  if (
    req.method === "POST" &&
    url.pathname === "/criar-pagamento"
  ) {
    let externalReference = "";

    try {
      if (!token) {
        return json({
          erro:
            "Serviço de pagamento não configurado.",
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

      const pagamento =
        String(corpo.pagamento ?? "").trim();

      if (
        !comprador ||
        !Number.isFinite(vendedorId)
      ) {
        return json({
          erro: "Dados da venda incompletos.",
        }, 400);
      }

      let vendedorAutorizado;

      try {
        vendedorAutorizado =
          await obterVendedorAutorizado(
            usuarioAutenticado.uid,
            vendedorId,
          );
      } catch (erro) {
        console.warn(
          "Operação de vendedor recusada:",
          erro,
        );

        return json({
          erro:
            "Você não tem permissão para registrar esta venda.",
        }, 403);
      }

      await garantirContadorInicializado();
      await limparReservasExpiradas();

      externalReference =
        crypto.randomUUID();

      let periodoReserva;

      try {
        periodoReserva =
          await reservarVaga(
            externalReference,
            {
              comprador,
              telefone,
              pagamento,
              vendedorId:
                vendedorAutorizado.id,
              vendedorNome:
                vendedorAutorizado.nome,
              usuarioUid:
                usuarioAutenticado.uid,
            },
          );
      } catch (erro) {
        if (
          erro instanceof Error &&
          erro.message ===
            "INGRESSOS_ESGOTADOS"
        ) {
          return json({
            erro:
              "Todos os 500 ingressos já foram vendidos.",
            esgotado: true,
          }, 409);
        }

        throw erro;
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
                id:
                  "INGRESSO-HALLOWEEN-2026",
                title:
                  "Halloween 2026 - A Noite das Almas",
                description:
                  "Ingresso individual",
                quantity: 1,
                currency_id: "BRL",
                unit_price: 15,
              },
            ],

            payer: {
              name: comprador,
            },

            external_reference:
              externalReference,

            notification_url:
              "https://fa-eventos-deno-teste.fa-producoes.deno.net/webhook",

            back_urls: {
              success:
                "https://fea-eventos.web.app/?pagamento=sucesso",
              failure:
                "https://fea-eventos.web.app/?pagamento=falha",
              pending:
                "https://fea-eventos.web.app/?pagamento=pendente",
            },

            auto_return: "approved",

            expires: true,

            expiration_date_from:
              periodoReserva.inicio.toISOString(),

            expiration_date_to:
              periodoReserva.expiracao.toISOString(),

            metadata: {
              comprador,
              telefone,
              vendedor_id:
                String(vendedorAutorizado.id),
              vendedor_nome:
                vendedorAutorizado.nome,
              pagamento,
              usuario_uid:
                usuarioAutenticado.uid,
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

        await liberarReserva(
          externalReference,
          "erro_criacao_pagamento",
        );

        return json({
          erro:
            "Não foi possível criar o pagamento.",
        }, 502);
      }

      if (db) {
        await db
          .collection("pedidosPagamento")
          .doc(externalReference)
          .set(
            {
              preferenceId:
                String(dados.id ?? ""),
              atualizadoEm:
                new Date().toISOString(),
            },
            { merge: true },
          );
      }

      return json({
        preferenceId: dados.id,
        initPoint: dados.init_point,
        externalReference,
      });
    } catch (erro) {
      console.error(
        "Erro em /criar-pagamento:",
        erro,
      );

      if (externalReference) {
        try {
          await liberarReserva(
            externalReference,
            "erro_interno",
          );
        } catch (erroLiberacao) {
          console.error(
            "Erro ao liberar reserva:",
            erroLiberacao,
          );
        }
      }

      return json({
        erro:
          "Erro interno ao criar pagamento.",
      }, 500);
    }
  }

  if (
    req.method === "POST" &&
    url.pathname === "/cancelar-venda"
  ) {
    try {
      const usuarioAutenticado =
        await validarUsuarioFirebase(req);

      if (!usuarioAutenticado) {
        return json({
          erro:
            "Usuário não autenticado ou sessão inválida.",
        }, 401);
      }

      await garantirContadorInicializado();

      const corpo = await req.json();

      const pagamentoId =
        String(corpo.pagamentoId ?? "").trim();

      if (!pagamentoId) {
        return json({
          erro: "Pagamento não informado.",
        }, 400);
      }

      try {
        const resultado =
          await cancelarVendaAdministrativamente(
            usuarioAutenticado.uid,
            pagamentoId,
          );

        return json({
          ok: true,
          ...resultado,
        });
      } catch (erro) {
        if (
          erro instanceof Error &&
          erro.message === "SEM_PERMISSAO"
        ) {
          return json({
            erro:
              "Você não tem permissão para cancelar vendas.",
          }, 403);
        }

        if (
          erro instanceof Error &&
          erro.message === "VENDA_NAO_ENCONTRADA"
        ) {
          return json({
            erro: "Venda não encontrada.",
          }, 404);
        }

        throw erro;
      }
    } catch (erro) {
      console.error(
        "Erro em /cancelar-venda:",
        erro,
      );

      return json({
        erro:
          "Erro interno ao cancelar a venda.",
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
          erro:
            "Serviço de pagamento não configurado.",
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
          ? corpo.data as Record<
            string,
            unknown
          >
          : {};

      const pagamentoId =
        url.searchParams.get("data.id") ??
        url.searchParams.get("data_id") ??
        String(data.id ?? "").trim();

      if (!pagamentoId) {
        return json({
          recebido: true,
        });
      }

      const respostaPagamento = await fetch(
        `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,
          },
        },
      );

      if (
        respostaPagamento.status === 400 ||
        respostaPagamento.status === 404
      ) {
        console.info(
          "Webhook recebido para pagamento inexistente:",
          pagamentoId,
        );

        return json({
          recebido: true,
          pagamentoId,
          ignorado: true,
          motivo: "pagamento_nao_encontrado",
        });
      }

      if (!respostaPagamento.ok) {
        console.error(
          "Não foi possível consultar o pagamento:",
          respostaPagamento.status,
        );

        return json({
          erro:
            "Não foi possível validar o pagamento.",
        }, 500);
      }

      const pagamento =
        await respostaPagamento.json();

      const status =
        String(
          pagamento.status ?? "",
        ).trim();

      const externalReference =
        String(
          pagamento.external_reference ?? "",
        ).trim();

      if (
        status === "pending" ||
        status === "in_process" ||
        status === "authorized"
      ) {
        if (externalReference) {
          await marcarReservaPendente(
            externalReference,
            pagamentoId,
            status,
          );
        }

        return json({
          recebido: true,
          pagamentoId,
          status,
        });
      }

      await garantirContadorInicializado();

      if (
        status === "rejected" ||
        status === "cancelled" ||
        status === "expired"
      ) {
        if (externalReference) {
          await liberarReserva(
            externalReference,
            status,
          );
        }

        return json({
          recebido: true,
          pagamentoId,
          status,
        });
      }

      if (
        status === "refunded" ||
        status === "charged_back"
      ) {
        if (externalReference) {
          await liberarReserva(
            externalReference,
            status,
          );
        }

        await marcarVendaRevertida(
          pagamentoId,
          pagamento,
          status,
        );

        return json({
          recebido: true,
          pagamentoId,
          status,
          vendaCancelada: true,
        });
      }

      if (status !== "approved") {
        return json({
          recebido: true,
          pagamentoId,
          status,
        });
      }

      const venda =
        await registrarVendaAprovada(
          pagamentoId,
          pagamento,
        );

      if (venda.revisaoManual) {
        await registrarIncidentePagamento(
          pagamentoId,
          String(venda.motivo ?? "revisao_manual"),
          {
            externalReference,
            statusPagamento: status,
            valor:
              Number(pagamento.transaction_amount ?? 0),
            moeda:
              String(pagamento.currency_id ?? ""),
          },
        );
      }

      return json({
        recebido: true,
        pagamentoId,
        status: "approved",
        vendaRegistrada: venda.criada,
        ingresso: venda.ingresso,
        revisaoManual: venda.revisaoManual,
      });
    } catch (erro) {
      console.error(
        "Erro no webhook:",
        erro,
      );

      return json({
        erro:
          "Erro interno ao processar webhook.",
      }, 500);
    }
  }

  return json({
    erro: "Rota não encontrada.",
  }, 404);
});
