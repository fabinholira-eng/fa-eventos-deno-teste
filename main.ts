const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");

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

  // Responde à verificação CORS feita pelo navegador
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

  // Teste de comunicação com o Mercado Pago
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
          erro: erro instanceof Error ? erro.message : String(erro),
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
          erro: erro instanceof Error ? erro.message : String(erro),
        },
        500,
      );
    }
  }

  // Rota utilizada pelo aplicativo para iniciar o pagamento
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
        typeof dados.id === "string" ? dados.id : "";

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
            erro: "Mercado Pago não retornou o endereço do checkout.",
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

  return json(
    {
      ok: false,
      erro: "Rota não encontrada.",
    },
    404,
  );
});
