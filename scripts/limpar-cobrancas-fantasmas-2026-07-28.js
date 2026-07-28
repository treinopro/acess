// Limpeza pontual (2026-07-28) de duas coisas encontradas ao investigar por
// que o aluno "Alexandre da silva maciel" mostrava cobranças em atraso que
// não existem no Secullum (sistema antigo, fonte da verdade):
//
// 1) 12 cobranças 'recorrencia' fantasmas nesse aluno (fev/2024 a jan/2025,
//    R$780 no total) — geradas retroativamente durante os testes da migração
//    (ver scripts/diagnosticar-recorrencia-retroativa-v3.js), nunca existiram
//    de verdade. Confirmado isolado: nenhum outro aluno tem esse padrão.
// 2) 4 pares de "mesmo mês faturado em legado E recorrencia" (10/07/2026),
//    ambos já pagos — mantém sempre a 'legado' (fonte do Secullum), remove a
//    'recorrencia' duplicada (ver scripts/diagnosticar-mesmo-mes-duplicado.js).
//
// Dry-run por padrão (só mostra o que seria apagado). Rode com --aplicar
// pra executar de verdade.
const db = require('../src/db/client');

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  console.log(APLICAR ? '=== MODO: APLICANDO DE VERDADE ===' : '=== MODO: DRY-RUN (nada será apagado) ===');

  // ---- 1) Fantasmas retroativos (Alexandre) ----
  const fantasmas = await db.execute(`
    SELECT c.id, a.nome as aluno_nome, c.vencimento, c.valor_centavos
    FROM cobrancas c
    JOIN alunos a ON a.id = c.aluno_id
    JOIN matriculas m ON m.id = c.matricula_id
    WHERE c.provedor = 'recorrencia'
      AND date(c.vencimento) < date(m.criado_em)
      AND c.matricula_id IN (
        SELECT c2.matricula_id FROM cobrancas c2
        JOIN matriculas m2 ON m2.id = c2.matricula_id
        WHERE c2.provedor = 'recorrencia' AND date(c2.vencimento) < date(m2.criado_em)
        GROUP BY c2.matricula_id HAVING COUNT(*) >= 2
      )
    ORDER BY a.nome, c.vencimento
  `);
  console.log(`\n--- Fantasmas retroativos: ${fantasmas.rows.length} cobrança(s) ---`);
  fantasmas.rows.forEach((r) => console.log(`  ${r.aluno_nome} | vencimento=${r.vencimento} | R$${(r.valor_centavos/100).toFixed(2)} | id=${r.id}`));

  // ---- 2) Mesmo mês em legado + recorrencia (mantém legado, apaga recorrencia) ----
  const duplicados = await db.execute(`
    SELECT c2.id, a.nome as aluno_nome, c2.vencimento, c2.valor_centavos
    FROM cobrancas c1
    JOIN cobrancas c2 ON c2.aluno_id = c1.aluno_id AND c2.vencimento = c1.vencimento AND c2.provedor = 'recorrencia'
    JOIN alunos a ON a.id = c1.aluno_id
    WHERE c1.provedor = 'legado'
  `);
  console.log(`\n--- Duplicatas (recorrencia a remover, legado fica): ${duplicados.rows.length} cobrança(s) ---`);
  duplicados.rows.forEach((r) => console.log(`  ${r.aluno_nome} | vencimento=${r.vencimento} | R$${(r.valor_centavos/100).toFixed(2)} | id=${r.id}`));

  const totalIds = [...fantasmas.rows.map((r) => r.id), ...duplicados.rows.map((r) => r.id)];
  console.log(`\nTotal de linhas marcadas para exclusão: ${totalIds.length}`);

  if (!APLICAR) {
    console.log('\nDry-run — nada foi apagado. Rode com --aplicar para executar de verdade.');
    process.exit(0);
  }

  for (const id of totalIds) {
    await db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: [id] });
  }
  console.log(`\n${totalIds.length} cobrança(s) apagada(s) com sucesso.`);
  process.exit(0);
}

main().catch((err) => { console.error('ERRO:', err); process.exit(1); });
