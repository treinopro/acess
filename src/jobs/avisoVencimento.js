/**
 * Aviso de vencimento por push (2026-08-13) — checa periodicamente as
 * cobranças em aberto de alunos que optaram por receber o aviso (ver
 * notificar_vencimento em alunos, configurável pelo portal) e manda uma
 * notificação quando a cobrança entra na janela configurada (X dias antes
 * do vencimento até o próprio dia). Cada cobrança recebe UM aviso só —
 * marcado em aviso_vencimento_enviado, nunca reenviado depois disso, mesmo
 * que continue em aberto por mais dias.
 */
const db = require('../db/client');
const webPush = require('../services/webPush.service');

function diasAteVencimento(vencimentoIso) {
  const [ano, mes, dia] = vencimentoIso.split('-').map(Number);
  const venc = new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
  const agora = new Date();
  const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 12, 0, 0));
  return Math.round((venc - hoje) / 86400000);
}

function textoAviso(dias) {
  if (dias < 0) {
    const atraso = Math.abs(dias);
    return `Sua mensalidade venceu há ${atraso} dia${atraso === 1 ? '' : 's'}. Regularize para evitar bloqueio de acesso.`;
  }
  if (dias === 0) return 'Sua mensalidade vence hoje.';
  return `Sua mensalidade vence em ${dias} dia${dias === 1 ? '' : 's'}.`;
}

async function rodar() {
  const result = await db.execute(`
    SELECT c.id as cobranca_id, c.vencimento, a.id as aluno_id, a.notificar_vencimento_dias_antes as dias_antes
    FROM cobrancas c
    JOIN alunos a ON a.id = c.aluno_id
    WHERE c.status IN ('pendente', 'atrasado')
      AND c.aviso_vencimento_enviado = 0
      AND c.vencimento IS NOT NULL
      AND a.notificar_vencimento = 1
  `);

  let enviados = 0;
  for (const row of result.rows) {
    const dias = diasAteVencimento(row.vencimento);
    const janela = Number.isFinite(row.dias_antes) ? row.dias_antes : 3;
    if (dias > janela) continue; // ainda longe, próxima checagem cuida

    await webPush.enviarParaAluno(row.aluno_id, {
      titulo: 'Mensalidade vencendo',
      corpo: textoAviso(dias),
      url: '/portal.html',
      tag: 'vencimento',
    });
    await db.execute({ sql: 'UPDATE cobrancas SET aviso_vencimento_enviado = 1 WHERE id = ?', args: [row.cobranca_id] });
    enviados += 1;
  }

  if (enviados) console.log(`[avisoVencimento] ${new Date().toISOString()} — ${enviados} aviso(s) de vencimento enviado(s).`);
  return enviados;
}

module.exports = { rodar };
