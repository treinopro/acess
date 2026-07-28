// Script de diagnóstico SOMENTE LEITURA — investiga por que um aluno específico
// mostra cobranças "atrasado" que não existem no Secullum (sistema antigo).
// Uso: node scripts/diagnosticar-aluno-cobrancas.js "nome ou parte do nome"
const db = require('../src/db/client');

async function main() {
  const termo = process.argv[2];
  if (!termo) {
    console.error('Uso: node scripts/diagnosticar-aluno-cobrancas.js "nome do aluno"');
    process.exit(1);
  }

  const alunos = await db.execute({
    sql: "SELECT id, nome, cpf, secullum_id, status FROM alunos WHERE nome LIKE ?",
    args: [`%${termo}%`],
  });

  if (!alunos.rows.length) {
    console.log('Nenhum aluno encontrado com esse nome.');
    process.exit(0);
  }

  for (const aluno of alunos.rows) {
    console.log('\n=== ALUNO ===');
    console.log(JSON.stringify(aluno, null, 2));

    const matriculas = await db.execute({
      sql: 'SELECT id, plano_id, data_inicio, data_fim, status, renovacao_automatica, secullum_id, criado_em FROM matriculas WHERE aluno_id = ? ORDER BY data_inicio',
      args: [aluno.id],
    });
    console.log(`\n--- MATRICULAS (${matriculas.rows.length}) ---`);
    matriculas.rows.forEach((m) => console.log(JSON.stringify(m)));

    const cobrancas = await db.execute({
      sql: `SELECT id, matricula_id, valor_centavos, status, provedor, provedor_referencia,
                   metodo_pagamento, descricao, vencimento, pago_em, secullum_numero, criado_em
            FROM cobrancas WHERE aluno_id = ? ORDER BY vencimento`,
      args: [aluno.id],
    });
    console.log(`\n--- COBRANCAS (${cobrancas.rows.length}) ---`);
    cobrancas.rows.forEach((c) => console.log(JSON.stringify(c)));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
