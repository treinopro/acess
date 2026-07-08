// A tabela anamnese_perguntas (catalogo de perguntas da anamnese) foi
// deliberadamente NAO apagada pelo zerar-dados-alunos.js (fica na lista de
// tabelas mantidas, junto com usuarios/planos/turmas/configuracoes), porque
// e um catalogo fixo que pode ter sido editado manualmente.
//
// Isso significa que as 26 perguntas da PRIMEIRA migracao (script v1, que
// usava um uuid() aleatorio como id) continuam la, e a migracao v2 (que usa
// um id deterministico "pergunta:<key>") inseriu outras 26 por cima -
// resultando em 52 linhas (a mesma pergunta duplicada, com textos iguais).
// O scripts/verificar-migracao.js ja avisa disso: "esperado: 26 -- se for
// multiplo disso, ex 52, a migracao rodou mais de uma vez".
//
// Este script apaga só as linhas ANTIGAS (id que NAO comeca com "pergunta:"),
// e só se nao tiver nenhuma resposta de anamnese apontando pra elas (o que
// é o esperado, já que a migração v2 recriou todas as anamneses do zero
// usando os ids novos). Se alguma resposta ainda apontar pra um id antigo,
// esse específico NÃO é apagado - só reportado, pra você decidir.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/limpar-perguntas-duplicadas.js            (dry-run)
//   node scripts/limpar-perguntas-duplicadas.js --aplicar   (apaga de verdade)

const { createClient } = require('@libsql/client');

const APLICAR = process.argv.includes('--aplicar');
const db = createClient({ url: 'file:./local.db' });

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO' : 'DRY-RUN'} ===\n`);

  const antigas = await db.execute(
    `SELECT id, texto FROM anamnese_perguntas WHERE id NOT LIKE 'pergunta:%' ORDER BY texto`
  );
  console.log(`Perguntas com id antigo (pré-migração v2): ${antigas.rows.length}`);

  if (antigas.rows.length === 0) {
    console.log('Nada a limpar - não há duplicatas de perguntas.');
    return;
  }

  const seguras = [];
  const emUso = [];
  for (const p of antigas.rows) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) as n FROM anamnese_respostas WHERE pergunta_id = ?`,
      args: [p.id],
    });
    const n = Number(r.rows[0].n);
    if (n === 0) {
      seguras.push(p);
    } else {
      emUso.push({ ...p, respostas: n });
    }
  }

  console.log(`\nSeguras para apagar (sem nenhuma resposta ligada): ${seguras.length}`);
  for (const p of seguras) console.log(`  [apagar] ${p.id} — ${p.texto}`);

  if (emUso.length > 0) {
    console.log(`\nAINDA EM USO (não serão apagadas, têm respostas ligadas): ${emUso.length}`);
    for (const p of emUso) console.log(`  [manter] ${p.id} — ${p.texto} (${p.respostas} resposta(s))`);
  }

  if (!APLICAR) {
    console.log('\n=== FIM (dry-run — nada foi apagado) ===');
    if (seguras.length > 0) {
      console.log('Rode de novo com --aplicar para apagar as seguras:');
      console.log('  node scripts/limpar-perguntas-duplicadas.js --aplicar');
    }
    return;
  }

  for (const p of seguras) {
    await db.execute({ sql: `DELETE FROM anamnese_perguntas WHERE id = ?`, args: [p.id] });
  }
  console.log(`\n=== FIM: ${seguras.length} pergunta(s) antiga(s) apagada(s) ===`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
