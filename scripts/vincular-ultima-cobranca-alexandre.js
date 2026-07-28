// Fix pontual (2026-07-28): ancora a matrícula do Alexandre da silva maciel
// na cobrança real mais recente (20/06/2026), pra gerarCobrancasRecorrentes
// calcular o próximo ciclo a partir dali (jul/2026 em diante) em vez de
// recomeçar do data_inicio (fev/2024) — mesmo side-effect (UPDATE matriculas
// SET data_fim) que o próprio job já faz ao gerar um ciclo normalmente, só
// que aplicado manualmente porque esta cobrança veio do Secullum, não do job.
const db = require('../src/db/client');

const MATRICULA_ID = 'b0ba0685-a201-4473-ac76-d55dc64b5c4b';
const COBRANCA_ID = 'e8721c2e-71bc-40a2-9722-aca38d95eb76';
const VENCIMENTO = '2026-06-20';

async function main() {
  const antes = await db.execute({ sql: 'SELECT id, matricula_id FROM cobrancas WHERE id = ?', args: [COBRANCA_ID] });
  console.log('Cobrança antes:', JSON.stringify(antes.rows[0]));

  await db.execute({ sql: 'UPDATE cobrancas SET matricula_id = ? WHERE id = ?', args: [MATRICULA_ID, COBRANCA_ID] });
  await db.execute({ sql: 'UPDATE matriculas SET data_fim = ? WHERE id = ?', args: [VENCIMENTO, MATRICULA_ID] });

  const depoisCobranca = await db.execute({ sql: 'SELECT id, matricula_id, vencimento, status FROM cobrancas WHERE id = ?', args: [COBRANCA_ID] });
  const depoisMatricula = await db.execute({ sql: 'SELECT id, data_inicio, data_fim FROM matriculas WHERE id = ?', args: [MATRICULA_ID] });
  console.log('Cobrança depois:', JSON.stringify(depoisCobranca.rows[0]));
  console.log('Matrícula depois:', JSON.stringify(depoisMatricula.rows[0]));
  process.exit(0);
}
main().catch((err) => { console.error('ERRO:', err); process.exit(1); });
