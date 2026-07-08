// A tabela `planos` também é uma das que zerar-dados-alunos.js NÃO apaga
// (fica preservada de propósito, junto com usuarios/turmas/configuracoes).
// Por isso, depois da remigração do Secullum, ela ficou com os 8 planos
// novos (ligados a um secullum_id) MAIS qualquer plano que já existisse
// antes de toda essa migração começar (sem secullum_id).
//
// Este script apaga só os planos SEM secullum_id (ou seja, os antigos, não
// relacionados à migração), e só se nenhuma matrícula estiver usando esse
// plano_id (o esperado, já que todas as matrículas foram recriadas do zero
// pela migração v2, todas apontando pros 8 planos novos). Se algum plano
// antigo ainda tiver matrícula ligada, ele NÃO é apagado - só reportado.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/limpar-planos-sem-secullum.js            (dry-run)
//   node scripts/limpar-planos-sem-secullum.js --aplicar   (apaga de verdade)

const { createClient } = require('@libsql/client');

const APLICAR = process.argv.includes('--aplicar');
const db = createClient({ url: 'file:./local.db' });

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO' : 'DRY-RUN'} ===\n`);

  const antigos = await db.execute(
    `SELECT id, nome, tipo, valor_centavos, ativo FROM planos WHERE secullum_id IS NULL ORDER BY nome`
  );
  console.log(`Planos sem secullum_id (pré-migração): ${antigos.rows.length}`);

  if (antigos.rows.length === 0) {
    console.log('Nada a limpar - não há planos antigos.');
    return;
  }

  const seguros = [];
  const emUso = [];
  for (const p of antigos.rows) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) as n FROM matriculas WHERE plano_id = ?`,
      args: [p.id],
    });
    const n = Number(r.rows[0].n);
    const valorReais = (Number(p.valor_centavos) / 100).toFixed(2).replace('.', ',');
    if (n === 0) {
      seguros.push(p);
      console.log(`  [apagar] "${p.nome}" (${p.tipo}, R$ ${valorReais}, ativo=${p.ativo}) — sem matrícula ligada`);
    } else {
      emUso.push({ ...p, matriculas: n });
      console.log(`  [MANTER] "${p.nome}" (${p.tipo}, R$ ${valorReais}) — ${n} matrícula(s) ligada(s), NÃO será apagado`);
    }
  }

  if (!APLICAR) {
    console.log('\n=== FIM (dry-run — nada foi apagado) ===');
    if (seguros.length > 0) {
      console.log('Se a lista acima fizer sentido, rode de novo com --aplicar:');
      console.log('  node scripts/limpar-planos-sem-secullum.js --aplicar');
    }
    return;
  }

  for (const p of seguros) {
    await db.execute({ sql: `DELETE FROM planos WHERE id = ?`, args: [p.id] });
  }
  console.log(`\n=== FIM: ${seguros.length} plano(s) antigo(s) apagado(s) ===`);
  if (emUso.length > 0) {
    console.log(`${emUso.length} plano(s) antigo(s) mantido(s) por ter matrícula ligada - revise manualmente se necessário.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
