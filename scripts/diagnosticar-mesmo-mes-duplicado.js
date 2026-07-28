const db = require('../src/db/client');
async function main() {
  const result = await db.execute(`
    SELECT a.nome as aluno_nome, c1.aluno_id, c1.vencimento, c1.id as id_legado, c2.id as id_recorrencia,
           c1.valor_centavos as valor_legado, c2.valor_centavos as valor_recorrencia,
           c1.status as status_legado, c2.status as status_recorrencia
    FROM cobrancas c1
    JOIN cobrancas c2 ON c2.aluno_id = c1.aluno_id AND c2.vencimento = c1.vencimento AND c2.provedor = 'recorrencia'
    JOIN alunos a ON a.id = c1.aluno_id
    WHERE c1.provedor = 'legado'
    ORDER BY a.nome, c1.vencimento
  `);
  console.log(`Mesmo mês faturado em legado E recorrencia: ${result.rows.length} par(es)`);
  result.rows.forEach((d) => console.log(`- ${d.aluno_nome}: vencimento=${d.vencimento} legado(${d.status_legado}, R$${(d.valor_legado/100).toFixed(2)}) recorrencia(${d.status_recorrencia}, R$${(d.valor_recorrencia/100).toFixed(2)})`));
  process.exit(0);
}
main().catch((err) => { console.error('ERRO:', err); process.exit(1); });
