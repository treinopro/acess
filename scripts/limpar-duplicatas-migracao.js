// Remove cobrancas duplicadas trazidas da migracao do Secullum (provedor =
// 'legado') — casos em que o mesmo aluno tem duas (ou mais) cobrancas
// identicas em aluno_id + valor_centavos + vencimento + descricao + status.
// Nao mexe em nenhuma cobranca com outro provedor (mercadopago/manual).
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/limpar-duplicatas-migracao.js
//     -> dry-run (padrao): so mostra o que seria removido, nao apaga nada.
//   node scripts/limpar-duplicatas-migracao.js --aplicar
//     -> apaga de verdade: mantem 1 cobranca por grupo (a que tiver
//        pagamento vinculado, ou a mais antiga por criado_em, se nenhuma
//        tiver) e remove as demais + os pagamentos_cobranca ligados a elas.

require('dotenv').config();
const db = require('../src/db/client');

async function main() {
  const aplicar = process.argv.includes('--aplicar');

  const result = await db.execute(
    `SELECT c.id, c.aluno_id, a.nome AS aluno_nome, c.valor_centavos, c.vencimento,
            c.descricao, c.status, c.criado_em
     FROM cobrancas c
     LEFT JOIN alunos a ON a.id = c.aluno_id
     WHERE c.provedor = 'legado'
     ORDER BY c.aluno_id, c.valor_centavos, c.vencimento, c.descricao, c.status, c.criado_em`
  );
  const linhas = result.rows;

  const idsTodos = linhas.map((l) => l.id);
  const pagPorCobranca = new Set();
  if (idsTodos.length) {
    const placeholders = idsTodos.map(() => '?').join(',');
    const pg = await db.execute({
      sql: `SELECT DISTINCT cobranca_id FROM pagamentos_cobranca WHERE cobranca_id IN (${placeholders})`,
      args: idsTodos,
    });
    pg.rows.forEach((r) => pagPorCobranca.add(r.cobranca_id));
  }

  const grupos = new Map();
  for (const l of linhas) {
    const chave = [l.aluno_id, l.valor_centavos, l.vencimento, l.descricao || '', l.status].join('|');
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  }

  const duplicados = [...grupos.values()].filter((g) => g.length > 1);

  const paraManter = [];
  const paraRemover = [];

  for (const g of duplicados) {
    // Prioridade pra manter: 1) tem pagamento vinculado, 2) criado_em mais antigo.
    const ordenado = [...g].sort((a, b) => {
      const pgA = pagPorCobranca.has(a.id) ? 1 : 0;
      const pgB = pagPorCobranca.has(b.id) ? 1 : 0;
      if (pgA !== pgB) return pgB - pgA; // quem tem pagamento vem primeiro
      return String(a.criado_em).localeCompare(String(b.criado_em));
    });
    paraManter.push(ordenado[0]);
    paraRemover.push(...ordenado.slice(1));
  }

  const removerNaoPagas = paraRemover.filter((l) => l.status !== 'pago');

  console.log(`Grupos duplicados: ${duplicados.length}`);
  console.log(`Cobranças que seriam removidas: ${paraRemover.length}`);
  console.log(`  - das quais NÃO estão pagas (pendente/atrasado — atenção, podem afetar liberação de acesso): ${removerNaoPagas.length}`);
  console.log('');

  if (removerNaoPagas.length) {
    console.log('--- Duplicatas NÃO pagas (revise com cuidado) ---');
    for (const l of removerNaoPagas) {
      console.log(`  aluno "${l.aluno_nome}" (${l.aluno_id})  valor R$${(l.valor_centavos / 100).toFixed(2)}  venc ${l.vencimento}  status ${l.status}  id ${l.id}`);
    }
    console.log('');
  }

  console.log('--- Todas as cobranças que seriam removidas ---');
  for (const l of paraRemover) {
    const temPg = pagPorCobranca.has(l.id) ? ' (tinha pagamento vinculado — será removido junto)' : '';
    console.log(`  aluno "${l.aluno_nome}" (${l.aluno_id})  valor R$${(l.valor_centavos / 100).toFixed(2)}  venc ${l.vencimento}  status ${l.status}  id ${l.id}${temPg}`);
  }

  if (!aplicar) {
    console.log('');
    console.log('Nada foi removido (dry-run). Revise a lista acima e rode de novo com --aplicar para apagar de verdade.');
    return;
  }

  const idsRemover = paraRemover.map((l) => l.id);
  if (idsRemover.length) {
    const placeholders = idsRemover.map(() => '?').join(',');
    await db.execute({ sql: `DELETE FROM pagamentos_cobranca WHERE cobranca_id IN (${placeholders})`, args: idsRemover });
    await db.execute({ sql: `DELETE FROM cobrancas WHERE id IN (${placeholders})`, args: idsRemover });
  }

  console.log('');
  console.log(`Removido: ${paraRemover.length} cobranças duplicadas (e seus pagamentos vinculados, se houver). Mantida 1 por grupo.`);
}

main()
  .catch((err) => {
    console.error('Erro:', err.message);
    process.exit(1);
  })
  .finally(() => process.exit(0));
