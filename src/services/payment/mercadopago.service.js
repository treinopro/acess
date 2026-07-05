// Integração com Mercado Pago via Checkout Pro (preferences) - REST direto por fetch,
// sem depender do SDK oficial para manter o scaffold enxuto.
// Docs: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/overview
//       https://www.mercadopago.com.br/developers/pt/docs/subscriptions/overview

const BASE_URL = 'https://api.mercadopago.com';

function getToken() {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) throw new Error('MERCADOPAGO_ACCESS_TOKEN não configurado no .env');
  return token;
}

// Cria uma preferência de pagamento único (ex: mensalidade avulsa, matrícula).
async function criarPreferencia({ titulo, valorCentavos, referenciaExterna, urlRetorno }) {
  const resp = await fetch(`${BASE_URL}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [{
        title: titulo,
        quantity: 1,
        unit_price: valorCentavos / 100,
        currency_id: 'BRL',
      }],
      external_reference: referenciaExterna,
      back_urls: {
        success: urlRetorno,
        failure: urlRetorno,
        pending: urlRetorno,
      },
      auto_return: 'approved',
    }),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`Erro ao criar preferência Mercado Pago: ${erro}`);
  }
  return resp.json(); // contém init_point (link de checkout)
}

// Consulta o status de um pagamento recebido via webhook.
async function consultarPagamento(paymentId) {
  const resp = await fetch(`${BASE_URL}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!resp.ok) throw new Error('Erro ao consultar pagamento no Mercado Pago');
  return resp.json();
}

module.exports = { criarPreferencia, consultarPagamento };
