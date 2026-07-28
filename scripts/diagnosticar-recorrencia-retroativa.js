// Refinamento da v2: um único ciclo criado no mesmo dia da matrícula é normal
// (é a 1a mensalidade do auto-cadastro, gerada na hora). O sinal real de bug
// é uma matrícula com VÁRIOS ciclos 'recorrencia' retroativos de uma vez
// (2+), sinal de backfill indevido — não uma cobrança isolada.
const db = require('../src/db/client');

async function main() {
  const result = await db.execute(`
    SELECT a.nome as aluno_nome, c.aluno_id, c.matricula_id, COUNT(*) as qtd,
           SUM(c.valor_centavos) as total_centavos, MIN(c.vencimento) as venc_min, MAX(c.vencimento) as venc_max
    FROM cobrancas c
    JOIN alunos a ON a.id = c.aluno_id
    JOIN matriculas m ON m.id = c.matricula_id
    WHERE c.provedor = 'recorrencia' AND date(c.vencimento) < date(m.criado_em)
    GROUP BY c.matricula_id
    HAVING COUNT(*) >= 2
    ORDER BY qtd DESC
  `);
  console.log(`Matrículas com 2+ cobranças 'recorrencia' retroativas de uma vez: ${result.rows.length}`);
  result.rows.forEach((r) => {
    console.log(`- ${r.aluno_nome}: ${r.qtd} cobranças, R$ ${(r.total_centavos/100).toFixed(2)}, de ${r.venc_min} até ${r.venc_max}`);
  });
  process.exit(0);
}
main().catch((err) => { console.error('ERRO:', err); process.exit(1); });
