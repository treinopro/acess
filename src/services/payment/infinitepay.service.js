// Integração com o Checkout Integrado da InfinitePay (InfinityPay).
// Docs: https://www.infinitepay.io/checkout-documentacao
// Fluxo: POST /links -> devolve link de pagamento -> cliente paga -> webhook ou
// consulta via POST /payment_check confirma o status.

const BASE_URL = 'https://api.checkout.infinitepay.io';

function getHandle() {
  const handle = process.env.INFINITEPAY_HANDLE;
  if (!handle) throw new Error('INFINITEPAY_HANDLE não configurado no .env');
  return handle;
}

// Cria um link de pagamento para uma cobrança (mensalidade, matrícula, aula avulsa).
async function criarLinkPagamento({ descricao, valorCentavos, orderNsu, redirectUrl }) {
  const resp = await fetch(`${BASE_URL}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: getHandle(),
      items: [{ quantity: 1, price: valorCentavos, description: descricao }],
      order_nsu: orderNsu,
      redirect_url: redirectUrl,
      webhook_url: process.env.INFINITEPAY_WEBHOOK_URL || undefined,
    }),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`Erro ao criar link InfinitePay: ${erro}`);
  }
  return resp.json(); // contém a URL do checkout
}

// Confirma o status de um pagamento (usado como fallback ao webhook).
async function verificarPagamento({ orderNsu, transactionNsu, slug }) {
  const resp = await fetch(`${BASE_URL}/payment_check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: getHandle(),
      order_nsu: orderNsu,
      transaction_nsu: transactionNsu,
      slug,
    }),
  });

  if (!resp.ok) throw new Error('Erro ao verificar pagamento na InfinitePay');
  return resp.json(); // { success, paid, amount, paid_amount, installments, capture_method }
}

module.exports = { criarLinkPagamento, verificarPagamento };
