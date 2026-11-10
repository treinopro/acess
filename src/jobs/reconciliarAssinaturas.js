/**
 * Rede de segurança das assinaturas do Mercado Pago: consulta o MP e dá baixa
 * nas cobranças aprovadas cujo webhook não chegou. Ver
 * assinaturas.service.reconciliarAssinaturas (idempotente).
 */
const assinaturas = require('../services/assinaturas.service');
const acessoTerminal = require('../services/acessoTerminal.service');

async function rodar() {
  const r = await assinaturas.reconciliarAssinaturas();
  for (const alunoId of new Set(r.alunosAtualizados)) acessoTerminal.notificarAgenteAtualizacaoAluno(alunoId);
  if (r.baixas) console.log('[reconciliarAssinaturas]', { assinaturas: r.assinaturas, baixas: r.baixas });
  return r;
}

module.exports = { rodar };
