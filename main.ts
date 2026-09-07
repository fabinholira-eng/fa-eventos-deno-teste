const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/") {
    return Response.json({
      ok: true,
      servico: "F&A Eventos API - Deno",
    });
  }

  if (url.pathname === "/teste-token") {
    if (!token) {
      return Response.json(
        { ok: false, erro: "Token não configurado." },
        { status: 500 },
      );
    }

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

    return Response.json({
      ok: resposta.ok,
      status: resposta.status,
      statusText: resposta.statusText,
      resposta: texto.slice(0, 500),
    });
  }

  return Response.json(
    { ok: false, erro: "Rota não encontrada." },
    { status: 404 },
  );
});
if (url.pathname === "/teste-preferencia") {
  if (!token) {
    return Response.json(
      { ok: false, erro: "Token não configurado." },
      { status: 500 },
    );
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

  return Response.json({
    ok: resposta.ok,
    status: resposta.status,
    statusText: resposta.statusText,
    resposta: texto.slice(0, 1500),
  });
}
