/**
 * Reconciliação de pagamentos Pix "esquecidos" (2026-08-20).
 *
 * Pagamentos feitos pelo portal/totem via "pagar contas em aberto" (Pix
 * agregado, tabela pagamentos_totem — ver pagamentoContas.service.js) só eram
 * confirmados pelo polling do próprio navegador de quem estava pagando (a
 * cada 4s, enquanto a tela do QR code Pix ficava aberta — ver portal.js e
 * terminal.routes.js). Se a pessoa saísse dessa tela antes da confirmação
 * chegar (fechou o app, a aba foi suspensa em segundo plano no celular, pagou
 * por fora sem esperar a tela atualizar), o pagamento ficava aprovado pra
 * sempre no Mercado Pago e "pendente" pra sempre no sistema — nada nunca
 * voltava a checar. Incidente real: aluno pagou mensalidade pelo portal, o
 * pagamento aparece "Aprovado" no comprovante do Mercado Pago, mas a cobrança
 * nunca caiu como paga (conversa 20/08/2026).
 *
 * Este job varre periodicamente os pagamentos_totem ainda não confirmados e
 * reconsulta o Mercado Pago pra cada um, reaproveitando a mesma função
 * idempotente que o polling ao vivo usa (consultarStatusPagamento) — só que
 * aqui SEMPRE com permitirLiberarAcesso=false: um job em segundo plano
 * rodando minutos/horas depois não deve mandar sinal pra abrir a catraca
 * física (a pessoa já não está mais lá esperando). O lado financeiro (quitar
 * a cobrança) é confirmado normalmente.
 *
 * Não cobre os pagamentos Pix do fluxo de cadastro de aluno novo / upgrade de
 * plano (tabela cobrancas, reconciliados em confirmarPagamentoEAtivarMatricula
 * em portal.routes.js e no bloco equivalente em terminal.routes.js) — a mesma
 * lacuna teórica existe lá, mas fica de fora por ora pra manter esta correção
 * pequena e focada no caso que realmente aconteceu (mensalidade via "pagar
 * contas em aberto").
 */
const db = require('../db/client');
const pagamentoContas = require('./../services/pagamentoContas.service');

// Só reconsulta pagamentos criados nas últimas N horas — mais antigos que
// isso quase certamente foram abandonados de verdade (QR code expirado,
// pessoa desistiu de pagar) e reconsultar a API do Mercado Pago pra eles pra
// sempre não traz valor, só custo (e risco de rate limit).
const JANELA_HORAS = 48;

async function rodar() {
  const pendentes = await db.execute(`
    SELECT id FROM pagamentos_totem
    WHERE status != 'pago' AND provedor = 'mercadopago'
      AND criado_em >= datetime('now', '-${JANELA_HORAS} hours')
  `);

  let confirmados = 0;
  for (const row of pendentes.rows) {
    try {
      const resultado = await pagamentoContas.consultarStatusPagamento(row.id, { permitirLiberarAcesso: false });
      if (resultado.pago) confirmados += 1;
    } catch (err) {
      console.error(`[reconciliarPagamentosPix] erro ao reconsultar pagamento ${row.id}:`, err.message);
    }
  }

  if (confirmados > 0) {
    console.log(`[reconciliarPagamentosPix] ${new Date().toISOString()} — ${confirmados} pagamento(s) Pix confirmado(s) que o polling ao vivo tinha perdido (de ${pendentes.rows.length} verificado(s)).`);
  }
  return { verificados: pendentes.rows.length, confirmados };
}

module.exports = { rodar };
