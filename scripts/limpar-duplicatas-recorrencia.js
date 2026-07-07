// Remove cobrancas de mensalidade duplicadas geradas por gerarCobrancasRecorrentes
// (src/services/cobrancas.service.js), provedor = 'recorrencia'. Causa provavel:
// o servidor roda essa rotina toda vez que sobe (server.js) — reinicios muito
// proximos (redeploy logo depois de outro, ou crash-loop reiniciando varias
// vezes seguidas) podem sobrepor duas execucoes que checam "existe cobranca
// pra essa matricula+vencimento?" ao mesmo tempo, antes de qualquer uma
// gravar, e as duas acabam criando a cobranca. A chave de unicidade que o
// proprio sistema usa e' (matricula_id, vencimento) — e' por isso que
// agrupamos por essa chave aqui, mais preciso que o agrupamento usado pra
// duplicatas de migracao (aquelas nao tem matricula_id).
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/limpar-duplicatas-recorrencia.js
//     -> dry-run (padrao): so mostra o que seria removido, nao apaga nada.
//   node scripts/limpar-duplicatas-recorrencia.js --aplicar
//     -> apaga de verdade: mantem 1 cobranca por (matricula_id, vencimento)
//        (a que tiver pagamento vinculado, senao a mais antiga por
//        criado_em) e remove as demais + pagamentos_cobranca ligados.

require('dotenv').config();
const db = require('../src/db/client');

async function main() {
  const aplicar = process.argv.includes('--aplicar');

  const result = await db.execute(
    `SELECT c.id, c.aluno_id, a.nome AS aluno_nome, c.matricula_id, c.valor_centavos,
            c.vencimento, c.descricao, c.status, c.criado_em
     FROM cobrancas c
     LEFT JOIN alunos a ON a.id = c.aluno_id
     WHERE c.provedor = 'recorrencia' AND c.matricula_id IS NOT NULL
     ORDER BY c.matricula_id, c.vencimento, c.criado_em`
  );
  const linhas = result.rows;
  console.log(`Total de cobranças com provedor = 'recorrencia': ${linhas.length}`);

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
    const chave = `${l.matricula_id}|${l.vencimento}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  }

  const duplicados = [...grupos.values()].filter((g) => g.length > 1);
  console.log(`Grupos duplicados (mesma matrícula + mesmo vencimento): ${duplicados.length}`);

  const paraManter = [];
  const paraRemover = [];
  for (const g of duplicados) {
    const ordenado = [...g].sort((a, b) => {
      const pgA = pagPorCobranca.has(a.id) ? 1 : 0;
      const pgB = pagPorCobranca.has(b.id) ? 1 : 0;
      if (pgA !== pgB) return pgB - pgA;
      return String(a.criado_em).localeCompare(String(b.criado_em));
    });
    paraManter.push(ordenado[0]);
    paraRemover.push(...ordenado.slice(1));
  }

  const removerNaoPagas = paraRemover.filter((l) => l.status !== 'pago');

  console.log(`Cobranças que seriam removidas: ${paraRemover.length}`);
  console.log(`  - das quais NÃO estão pagas (pendente/atrasado — podem estar afetando liberação de acesso agora): ${removerNaoPagas.length}`);
  console.log('');

  console.log('--- Todas as cobranças que seriam removidas ---');
  for (const l of paraRemover) {
    const temPg = pagPorCobranca.has(l.id) ? ' (tinha pagamento vinculado — será removido junto)' : '';
    console.log(`  aluno "${l.aluno_nome}" (${l.aluno_id})  matrícula ${l.matricula_id}  valor R$${(l.valor_centavos / 100).toFixed(2)}  venc ${l.vencimento}  status ${l.status}  criado_em ${l.criado_em}  id ${l.id}${temPg}`);
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
  console.log(`Removido: ${paraRemover.length} cobranças duplicadas (e seus pagamentos vinculados, se houver). Mantida 1 por matrícula+vencimento.`);
}

main()
  .catch((err) => {
    console.error('Erro:', err.message);
    process.exit(1);
  })
  .finally(() => process.exit(0));
