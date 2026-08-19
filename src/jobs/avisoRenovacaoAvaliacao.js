/**
 * Aviso de renovação de avaliação física por push (2026-08-19) — mesmo
 * padrão do aviso de vencimento de mensalidade (ver
 * src/jobs/avisoVencimento.js), mas pro passo a passo de avaliação
 * (avaliacao_pipeline): avisa o ALUNO alguns dias antes de completar a
 * cadência de 90 dias (CADENCIA_AVALIACAO_DIAS, ver pendencias.routes.js),
 * pra ele já saber que precisa agendar renovação — sem depender só do
 * professor ver a pendência interna. Diferente do aviso de vencimento, este
 * SEMPRE dispara (não depende da preferência notificar_vencimento do aluno,
 * que é só sobre cobrança) — decisão explícita: toda avaliação vencendo
 * merece aviso.
 *
 * Só considera o pipeline MAIS RECENTE de cada aluno ativo — mesmo critério
 * usado pra pendência de renovação (ver listarPipelinesMaisRecentes em
 * pendencias.routes.js). Um aviso só por pipeline (aviso_renovacao_enviado),
 * nunca reenviado — se passar da janela sem ninguém rodar o job, ainda
 * assim manda um aviso atrasado na próxima checagem em vez de perder o aviso
 * de vez.
 */
const db = require('../db/client');
const webPush = require('../services/webPush.service');

const CADENCIA_AVALIACAO_DIAS = 90; // mantido em sincronia manual com pendencias.routes.js/public/portal.js
const AVISO_RENOVACAO_DIAS_ANTES = 7;

function diasDesdeAvaliacao(dataAvaliacaoIso) {
  const [ano, mes, dia] = dataAvaliacaoIso.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
  const agora = new Date();
  const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 12, 0, 0));
  return Math.round((hoje - data) / 86400000);
}

function textoAviso(diasRestantes) {
  if (diasRestantes < 0) {
    const atraso = Math.abs(diasRestantes);
    return `Sua avaliação física venceu há ${atraso} dia${atraso === 1 ? '' : 's'} — hora de agendar uma nova!`;
  }
  if (diasRestantes === 0) return 'Sua avaliação física vence hoje — hora de agendar uma nova!';
  return `Sua avaliação física vence em ${diasRestantes} dia${diasRestantes === 1 ? '' : 's'} — hora de agendar uma nova!`;
}

async function rodar() {
  const result = await db.execute(`
    WITH ranked AS (
      SELECT ap.*, a.status as aluno_status,
        ROW_NUMBER() OVER (PARTITION BY ap.aluno_id ORDER BY ap.data_avaliacao DESC, ap.criado_em DESC) as rn
      FROM avaliacao_pipeline ap
      JOIN alunos a ON a.id = ap.aluno_id
    )
    SELECT id, aluno_id, data_avaliacao FROM ranked
    WHERE rn = 1 AND aluno_status = 'ativo' AND aviso_renovacao_enviado = 0
  `);

  let enviados = 0;
  for (const row of result.rows) {
    const diasRestantes = CADENCIA_AVALIACAO_DIAS - diasDesdeAvaliacao(row.data_avaliacao);
    if (diasRestantes > AVISO_RENOVACAO_DIAS_ANTES) continue; // ainda longe, próxima checagem cuida

    await webPush.enviarParaAluno(row.aluno_id, {
      titulo: 'Avaliação física vencendo',
      corpo: textoAviso(diasRestantes),
      url: '/portal.html',
      tag: 'avaliacao-renovacao',
    });
    await db.execute({ sql: 'UPDATE avaliacao_pipeline SET aviso_renovacao_enviado = 1 WHERE id = ?', args: [row.id] });
    enviados += 1;
  }

  if (enviados) console.log(`[avisoRenovacaoAvaliacao] ${new Date().toISOString()} — ${enviados} aviso(s) de renovação de avaliação enviado(s).`);
  return enviados;
}

module.exports = { rodar };
