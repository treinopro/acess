const db = require('../db/client');

// Horário da última modificação do cadastro do aluno (alunos.atualizado_em).
//
// A coluna é criada pelo próprio servidor ao subir (garantirColuna), no mesmo
// deploy do código — sem passo manual no banco de produção. Enquanto a coluna
// não estiver confirmada, sqlAtualizadoEm() devolve '' e os UPDATE de aluno
// funcionam exatamente como antes (só não gravam o horário): esta feature
// nunca pode quebrar uma edição de cadastro.
let colunaDisponivel = false;

function sqlAtualizadoEm() {
  return colunaDisponivel ? ", atualizado_em = datetime('now')" : '';
}

async function garantirColuna() {
  try {
    const info = await db.execute('PRAGMA table_info(alunos)');
    const existe = info.rows.some((r) => r.name === 'atualizado_em');
    if (!existe) await db.execute('ALTER TABLE alunos ADD COLUMN atualizado_em TEXT');
    colunaDisponivel = true;
  } catch (err) {
    if (/duplicate column name/i.test(err.message)) {
      colunaDisponivel = true;
    } else {
      console.error('[atualizado_em] não foi possível garantir a coluna — horário de modificação desativado:', err.message);
      return;
    }
  }
  // Índice da lista de acessos do aluno — só otimização, falhar aqui não importa.
  try {
    await db.execute('CREATE INDEX IF NOT EXISTS idx_acessos_catraca_aluno_criado_em ON acessos_catraca(aluno_id, criado_em)');
  } catch (err) {
    console.error('[atualizado_em] índice de acessos não criado:', err.message);
  }
}

module.exports = { garantirColuna, sqlAtualizadoEm };
