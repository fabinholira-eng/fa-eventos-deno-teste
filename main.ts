const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Permite que o aplicativo acesse esta API
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (url.pathname === "/") {
    return Response.json(
      {
        ok: true,
        servico: "F&A Eventos API - Deno",
      },
      { headers: corsHeaders },
    );
  }

  // Cria o pagamento do ingresso
  if (url.pathname === "/criar-pagamento" && req.method === "POST") {
    if (!token) {
      return Response.json(
        {
          ok: false,
          erro: "Token do Mercado Pago não configurado.",
        },
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }

    try {
      const body = await req.json();

      const comprador = String(body.comprador ?? "").trim();
      const telefone = String(body.telefone ?? "").trim();
      const vendedorId = String(body.vendedorId ?? "");
      const vendedorNome = String(body.vendedorNome ?? "");

      if (!comprador) {
        return Response.json(
          {
            ok: false,
            erro: "Nome do comprador é obrigatório.",
          },
          {
            status: 400,
            headers: corsHeaders,
          },
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
              telefone,
              vendedor_id: vendedorId,
              vendedor_nome: vendedorNome,
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
        return Response.json(
          {
            ok: false,
            erro: "Mercado Pago recusou a criação do pagamento.",
            statusMercadoPago: resposta.status,
          },
          {
            status: 502,
            headers: corsHeaders,
          },
        );
      }

      return Response.json(
        {
          ok: true,
          preferenceId: dados.id,
          initPoint: dados.init_point,
          sandboxInitPoint: dados.sandbox_init_point,
          externalReference,
        },
        {
          headers: corsHeaders,
        },
      );
    } catch {
      return Response.json(
        {
          ok: false,
          erro: "Não foi possível criar o pagamento.",
        },
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  return Response.json(
    {
      ok: false,
      erro: "Rota não encontrada.",
    },
    {
      status: 404,
      headers: corsHeaders,
    },
  );
});
