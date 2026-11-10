/**
 * Encerra checkouts de assinatura (cartão) abandonados há mais de 48h e
 * restaura a cobrança tradicional (Pix) original. Ver
 * assinaturas.service.expirarCheckoutsAbandonados.
 */
const assinaturas = require('../services/assinaturas.service');

async function rodar() {
  const r = await assinaturas.expirarCheckoutsAbandonados({ horas: 48 });
  if (r.cancelados || r.sincronizados) console.log('[expirarCheckoutsRecorrencia]', r);
  return r;
}

module.exports = { rodar };
