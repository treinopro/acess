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

// Cria um pagamento Pix direto (API de Payments legada, não Checkout Pro) —
// devolve o QR já pronto (copia-e-cola + imagem em base64), sem redirecionar
// o pagador para nenhuma tela externa.
// MANTIDA só por retrocompatibilidade — o totem usa criarOrderPix (abaixo),
// que é a API atual recomendada pelo Mercado Pago para isso. Essa API antiga
// exige, em modo de teste, que o e-mail do pagador pertença a uma conta de
// teste "compradora" de verdade (não basta um e-mail @testuser.com qualquer),
// o que trava o totem sem necessidade.
// Docs: https://www.mercadopago.com.br/developers/pt/docs/checkout-api/payment-methods/pix
async function criarPagamentoPix({ descricao, valorCentavos, referenciaExterna, email }) {
  const resp = await fetch(`${BASE_URL}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': referenciaExterna,
    },
    body: JSON.stringify({
      transaction_amount: valorCentavos / 100,
      description: descricao,
      payment_method_id: 'pix',
      external_reference: referenciaExterna,
      payer: { email },
    }),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`Erro ao criar pagamento Pix Mercado Pago: ${erro}`);
  }
  return resp.json(); // contém id + point_of_interaction.transaction_data.{qr_code, qr_code_base64}
}

// Consulta o status de um pagamento (API de Payments legada) recebido via webhook.
async function consultarPagamento(paymentId) {
  const resp = await fetch(`${BASE_URL}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!resp.ok) throw new Error('Erro ao consultar pagamento no Mercado Pago');
  return resp.json();
}

// Cria uma Order com um pagamento Pix (API de Orders — Checkout Transparente),
// a forma ATUAL recomendada pelo Mercado Pago para Pix sem redirecionamento.
//
// IMPORTANTE: essa API não aceita token de teste ("TEST-...") de jeito
// nenhum — sempre precisa do Access Token de PRODUÇÃO ("APP_USR-..."). O
// "modo teste" é ativado não pelo token, mas pelo PAGADOR: se `email` for de
// uma conta de teste (ex: test_user_br@testuser.com) e `firstName` for
// "APRO", o Mercado Pago reconhece e simula a aprovação automaticamente, sem
// mexer em dinheiro de verdade — mesmo usando a credencial de produção.
// Docs: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/pix
// https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix
async function criarOrderPix({ descricao, valorCentavos, referenciaExterna, email, firstName }) {
  const valorReais = (valorCentavos / 100).toFixed(2);
  const body = {
    type: 'online',
    external_reference: referenciaExterna,
    total_amount: valorReais,
    description: descricao,
    payer: firstName ? { email, first_name: firstName } : { email },
    transactions: {
      payments: [
        {
          amount: valorReais,
          payment_method: { id: 'pix', type: 'bank_transfer' },
        },
      ],
    },
  };
  const resp = await fetch(`${BASE_URL}/v1/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': referenciaExterna,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`Erro ao criar order Pix Mercado Pago: ${erro}`);
  }
  return resp.json(); // contém id + transactions.payments[0].payment_method.{qr_code, qr_code_base64}
}

// Consulta o status de uma Order (API de Orders) — usado no polling ativo do totem.
async function consultarOrder(orderId) {
  const resp = await fetch(`${BASE_URL}/v1/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!resp.ok) throw new Error('Erro ao consultar order no Mercado Pago');
  return resp.json();
}

module.exports = {
  criarPreferencia,
  criarPagamentoPix,
  consultarPagamento,
  criarOrderPix,
  consultarOrder,
};
