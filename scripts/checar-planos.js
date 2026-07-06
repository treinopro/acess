const db = require('../src/db/client');

async function main() {
  console.log('=== PLANOS RESTANTES ===');
  const planos = await db.execute('SELECT id, nome, tipo, valor_centavos, criado_em FROM planos ORDER BY criado_em');
  planos.rows.forEach((p) => console.log(`  ${p.id} | ${p.nome} | ${p.tipo} | R$${(p.valor_centavos / 100).toFixed(2)} | criado ${p.criado_em}`));

  console.log('\n=== MATRICULAS E SEUS PLANOS (procurando referencia quebrada) ===');
  const matriculas = await db.execute(`
    SELECT m.id, m.aluno_id, m.plano_id, a.nome as aluno_nome, p.nome as plano_nome
    FROM matriculas m
    LEFT JOIN alunos a ON a.id = m.aluno_id
    LEFT JOIN planos p ON p.id = m.plano_id
  `);
  matriculas.rows.forEach((m) => {
    const quebrado = m.plano_nome === null ? '  <<< PLANO NAO ENCONTRADO (orfao)' : '';
    console.log(`  aluno=${m.aluno_nome} | plano_id=${m.plano_id} | plano_nome=${m.plano_nome}${quebrado}`);
  });
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
