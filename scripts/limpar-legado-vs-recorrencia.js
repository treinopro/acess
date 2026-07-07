// Remove a cobranca 'legado' (vinda da migracao do Secullum) quando o mesmo
// aluno tambem tem, no mesmo mes, uma cobranca 'recorrencia' equivalente
// (gerada pelo proprio academia-gestao, ligada a matricula). Mantem sempre a
// 'recorrencia' — e' a que sustenta a renovacao automatica dos proximos
// ciclos (gerarCobrancasRecorrentes busca a ULTIMA cobranca daquela
// matricula pra calcular o proximo vencimento; se so sobrar a 'legado', sem
// matricula_id, essa cadeia quebra).
//
// Seguranca: se a cobranca 'legado' ja tiver pagamento vinculado
// (pagamentos_cobranca), NAO decide sozinho — fica de fora do que e'
// removido automaticamente, listado a parte pra revisao manual.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/limpar-legado-vs-recorrencia.js 2026-07
//     -> dry-run (padrao): so mostra o que seria removido.
//   node scripts/limpar-legado-vs-recorrencia.js 2026-07 --aplicar
//     -> apaga de verdade as cobrancas 'legado' duplicadas (e pagamentos
//        vinculados a elas, se nao tiverem sido excluidas da lista acima).

require('dotenv').config();
const db = require('../src/db/client');

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const mes = args[0] || new Date().toISOString().slice(0, 7);
  const aplicar = process.argv.includes('--aplicar');

  const result = await db.execute({
    sql: `SELECT c.id, c.aluno_id, a.nome AS aluno_nome, c.matricula_id, c.valor_centavos,
                 c.vencimento, c.descricao, c.status, c.provedor, c.criado_em
          FROM cobrancas c
          LEFT JOIN alunos a ON a.id = c.aluno_id
          WHERE c.vencimento LIKE ? AND c.provedor IN ('legado', 'recorrencia') AND c.status != 'cancelado'
          ORDER BY c.aluno_id, c.provedor`,
    args: [`${mes}%`],
  });
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

  const porAluno = new Map();
  for (const l of linhas) {
    if (!porAluno.has(l.aluno_id)) porAluno.set(l.aluno_id, []);
    porAluno.get(l.aluno_id).push(l);
  }

  const paraRemover = [];
  const paraRevisar = [];

  for (const grupo of porAluno.values()) {
    const legados = grupo.filter((l) => l.provedor === 'legado');
    const recorrencias = grupo.filter((l) => l.provedor === 'recorrencia');
    if (!legados.length || !recorrencias.length) continue;

    for (const l of legados) {
      if (pagPorCobranca.has(l.id)) {
        paraRevisar.push(l);
      } else {
        paraRemover.push(l);
      }
    }
  }

  console.log(`Mês analisado: ${mes}`);
  console.log(`Cobranças 'legado' que seriam removidas (têm equivalente 'recorrencia' no mesmo mês, sem pagamento vinculado): ${paraRemover.length}`);
  console.log(`Cobranças 'legado' com equivalente 'recorrencia' MAS com pagamento vinculado (não mexo sozinho — revise manualmente): ${paraRevisar.length}`);
  console.log('');

  console.log('--- Serão removidas ---');
  for (const l of paraRemover) {
    console.log(`  aluno "${l.aluno_nome}" (${l.aluno_id})  valor R$${(l.valor_centavos / 100).toFixed(2)}  venc ${l.vencimento}  status ${l.status}  id ${l.id}`);
  }

  if (paraRevisar.length) {
    console.log('');
    console.log('--- Revisão manual (tinham pagamento vinculado) ---');
    for (const l of paraRevisar) {
      console.log(`  aluno "${l.aluno_nome}" (${l.aluno_id})  valor R$${(l.valor_centavos / 100).toFixed(2)}  venc ${l.vencimento}  status ${l.status}  id ${l.id}`);
    }
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
  console.log(`Removido: ${paraRemover.length} cobranças 'legado' duplicadas.`);
}

main()
  .catch((err) => {
    console.error('Erro:', err.message);
    process.exit(1);
  })
  .finally(() => process.exit(0));
