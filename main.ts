const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");

const WEBHOOK_URL =
  "https://fa-eventos-deno-teste.fa-producoes.deno.net/webhook";

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

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Rota inicial
  if (url.pathname === "/" && req.method === "GET") {
    return json({
      ok: true,
      servico: "F&A Eventos API - Deno",
    });
  }

  // Teste do Access Token
  if (url.pathname === "/teste-token" && req.method === "GET") {
    if (!token) {
      return json(
        {
          ok: false,
          erro: "Token não configurado.",
        },
        500,
      );
    }

    try {
      const resposta = await fetch(
        "https://api.mercadopago.com/v1/payment_methods",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        },
      );

      const texto = await resposta.text();

      return json({
        ok: resposta.ok,
        status: resposta.status,
        statusText: resposta.statusText,
        resposta: texto.slice(0, 500),
      });
    } catch (erro) {
      return json(
        {
          ok: false,
          erro:
            erro instanceof Error
              ? erro.message
              : "Erro ao consultar Mercado Pago.",
        },
        500,
      );
    }
  }

  // Teste mínimo de criação de preferência
  if (
    url.pathname === "/teste-preferencia" &&
    req.method === "GET"
  ) {
    if (!token) {
      return json(
        {
          ok: false,
          erro: "Token não configurado.",
        },
        500,
      );
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
                id: "halloween-2026",
                title: "Halloween 2026 - A Noite das Almas",
                quantity: 1,
                currency_id: "BRL",
                unit_price: 15,
              },
            ],

            notification_url: WEBHOOK_URL,
          }),
        },
      );

      const texto = await resposta.text();

      return json({
        ok: resposta.ok,
        status: resposta.status,
        statusText: resposta.statusText,
        resposta: texto.slice(0, 1500),
      });
    } catch (erro) {
      return json(
        {
          ok: false,
          erro:
            erro instanceof Error
              ? erro.message
              : "Erro ao criar preferência de teste.",
        },
        500,
      );
    }
  }

  // Criação do pagamento usada pelo aplicativo
  if (
    url.pathname === "/criar-pagamento" &&
    req.method === "POST"
  ) {
    if (!token) {
      return json(
        {
          ok: false,
          erro: "Token do Mercado Pago não configurado.",
        },
        500,
      );
    }

    try {
      const body = await req.json();

      const comprador =
        typeof body.comprador === "string"
          ? body.comprador.trim()
          : "";

      if (!comprador) {
        return json(
          {
            ok: false,
            erro: "Nome do comprador é obrigatório.",
          },
          400,
        );
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

            // Cada pagamento já recebe explicitamente
            // a URL correta do webhook do Deno.
            notification_url: WEBHOOK_URL,

            metadata: {
              comprador,

              telefone:
                typeof body.telefone === "string"
                  ? body.telefone.trim()
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
          dados = JSON.parse(texto) as Record<string, unknown>;
        } catch {
          dados = {};
        }
      }

      if (!resposta.ok) {
        console.log(
          "Mercado Pago recusou preferência:",
          resposta.status,
          texto,
        );

        return json(
          {
            ok: false,
            erro: "Mercado Pago recusou a criação do pagamento.",
            statusMercadoPago: resposta.status,
          },
          502,
        );
      }

      const preferenceId =
        typeof dados.id === "string"
          ? dados.id
          : "";

      const initPoint =
        typeof dados.init_point === "string"
          ? dados.init_point
          : "";

      const sandboxInitPoint =
        typeof dados.sandbox_init_point === "string"
          ? dados.sandbox_init_point
          : "";

      if (!initPoint) {
        return json(
          {
            ok: false,
            erro:
              "Mercado Pago não retornou o endereço do checkout.",
          },
          502,
        );
      }

      return json({
        ok: true,
        preferenceId,
        initPoint,
        sandboxInitPoint,
        externalReference,
      });
    } catch (erro) {
      console.log("Erro em /criar-pagamento:", erro);

      return json(
        {
          ok: false,
          erro:
            erro instanceof Error
              ? erro.message
              : "Erro interno ao criar pagamento.",
        },
        500,
      );
    }
  }

  // Consulta manual de um pagamento.
  // Será útil para testes e para o retorno do aplicativo.
  if (
    url.pathname.startsWith("/status-pagamento/") &&
    req.method === "GET"
  ) {
    if (!token) {
      return json(
        {
          ok: false,
          erro: "Token não configurado.",
        },
        500,
      );
    }

    const pagamentoId =
      url.pathname.replace("/status-pagamento/", "").trim();

    if (!pagamentoId) {
      return json(
        {
          ok: false,
          erro: "ID do pagamento não informado.",
        },
        400,
      );
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

      let pagamento: Record<string, unknown> = {};

      if (texto.trim()) {
        try {
          pagamento =
            JSON.parse(texto) as Record<string, unknown>;
        } catch {
          pagamento = {};
        }
      }

      if (!resposta.ok) {
        return json(
          {
            ok: false,
            erro: "Pagamento não localizado.",
            statusMercadoPago: resposta.status,
          },
          resposta.status === 404 ? 404 : 502,
        );
      }

      return json({
        ok: true,
        pagamentoId,
        status: pagamento.status ?? null,
        externalReference:
          pagamento.external_reference ?? null,
        metadata:
          pagamento.metadata ?? null,
      });
    } catch (erro) {
      return json(
        {
          ok: false,
          erro:
            erro instanceof Error
              ? erro.message
              : "Erro ao consultar pagamento.",
        },
        500,
      );
    }
  }

  // Webhook do Mercado Pago
  if (
    url.pathname === "/webhook" &&
    req.method === "POST"
  ) {
    /*
      IMPORTANTE:

      O webhook NÃO considera o pagamento aprovado apenas
      porque recebeu uma notificação.

      O ID recebido é usado para consultar diretamente
      a API oficial do Mercado Pago.
    */

    try {
      let body: Record<string, unknown> = {};

      try {
        body =
          await req.json() as Record<string, unknown>;
      } catch {
        body = {};
      }

      console.log(
        "WEBHOOK RECEBIDO:",
        JSON.stringify(body),
      );

      const data =
        typeof body.data === "object" &&
        body.data !== null
          ? body.data as Record<string, unknown>
          : {};

      const pagamentoId = String(
        data.id ??
          body.id ??
          url.searchParams.get("data.id") ??
          url.searchParams.get("id") ??
          "",
      ).trim();

      /*
        O Mercado Pago espera uma resposta rápida.
        Se não houver ID utilizável, confirmamos o recebimento
        sem registrar pagamento.
      */
      if (!pagamentoId) {
        return json({
          ok: true,
          mensagem:
            "Notificação recebida sem ID de pagamento.",
        });
      }

      if (!token) {
        /*
          Não devolvemos 401 ao Mercado Pago.
          Registramos o problema no servidor e confirmamos
          o recebimento da notificação.
        */
        console.log(
          "Webhook recebeu notificação, mas o token não está configurado.",
        );

        return json({
          ok: true,
          mensagem:
            "Notificação recebida. Verificação pendente.",
        });
      }

      /*
        Agora verificamos o pagamento diretamente
        no Mercado Pago.
      */
      const respostaPagamento = await fetch(
        `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const textoPagamento =
        await respostaPagamento.text();

      console.log(
        "CONSULTA PAGAMENTO:",
        pagamentoId,
        respostaPagamento.status,
        textoPagamento.slice(0, 1000),
      );

      /*
        Mesmo se o Mercado Pago ainda não disponibilizar
        imediatamente o pagamento para consulta,
        confirmamos que o webhook foi recebido.
      */
      if (!respostaPagamento.ok) {
        return json({
          ok: true,
          pagamentoId,
          mensagem:
            "Notificação recebida. Pagamento ainda não localizado para verificação.",
          statusConsulta: respostaPagamento.status,
        });
      }

      let pagamento: Record<string, unknown> = {};

      if (textoPagamento.trim()) {
        try {
          pagamento =
            JSON.parse(
              textoPagamento,
            ) as Record<string, unknown>;
        } catch {
          pagamento = {};
        }
      }

      const status =
        typeof pagamento.status === "string"
          ? pagamento.status
          : "";

      const externalReference =
        typeof pagamento.external_reference === "string"
          ? pagamento.external_reference
          : "";

      const metadata =
        typeof pagamento.metadata === "object" &&
        pagamento.metadata !== null
          ? pagamento.metadata as Record<string, unknown>
          : {};

      if (status === "approved") {
        /*
          AQUI está a confirmação confiável.

          No próximo passo conectaremos esta confirmação
          ao Firebase para:

          1. registrar o ingresso como pago;
          2. impedir duplicidade;
          3. atribuir os R$ 5 de comissão ao vendedor;
          4. emitir/ativar o ingresso.
        */

        console.log(
          "PAGAMENTO APROVADO:",
          pagamentoId,
          externalReference,
          metadata,
        );

        return json({
          ok: true,
          confirmado: true,
          pagamentoId,
          status,
          externalReference,
          metadata,
          mensagem:
            "Pagamento aprovado e confirmado pelo Mercado Pago.",
        });
      }

      return json({
        ok: true,
        confirmado: false,
        pagamentoId,
        status,
        externalReference,
        mensagem:
          "Pagamento recebido, mas ainda não aprovado.",
      });
    } catch (erro) {
      /*
        O webhook não deve devolver erro de autenticação
        ao Mercado Pago por falha interna de processamento.
      */
      console.log("ERRO NO WEBHOOK:", erro);

      return json({
        ok: true,
        confirmado: false,
        mensagem:
          "Notificação recebida. O processamento será verificado.",
      });
    }
  }

  return json(
    {
      ok: false,
      erro: "Rota não encontrada.",
    },
    404,
  );
});
