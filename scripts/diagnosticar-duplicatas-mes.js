// Diagnostica cobrancas duplicadas dentro de um mes especifico, em QUALQUER
// provedor (recorrencia, legado, mercadopago, manual...). So relatorio, nao
// apaga nada. Usado pra investigar duplicatas recentes que nao se encaixam
// nos diagnosticos ja feitos (migracao / recorrencia).
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/diagnosticar-duplicatas-mes.js 2026-07

require('dotenv').config();
const db = require('../src/db/client');

async function main() {
  const mes = process.argv[2] || new Date().toISOString().slice(0, 7);
  console.log(`Analisando cobranças com vencimento em ${mes} (todos os provedores)...`);

  const result = await db.execute({
    sql: `SELECT c.id, c.aluno_id, a.nome AS aluno_nome, c.matricula_id, c.valor_centavos,
                 c.vencimento, c.descricao, c.status, c.provedor, c.criado_em
          FROM cobrancas c
          LEFT JOIN alunos a ON a.id = c.aluno_id
          WHERE c.vencimento LIKE ?
          ORDER BY c.aluno_id, c.valor_centavos, c.vencimento`,
    args: [`${mes}%`],
  });
  const linhas = result.rows;
  console.log(`Total de cobranças com vencimento em ${mes}: ${linhas.length}`);

  const porProvedor = {};
  for (const l of linhas) porProvedor[l.provedor] = (porProvedor[l.provedor] || 0) + 1;
  console.log('Por provedor:', JSON.stringify(porProvedor));

  // Agrupamento 1: por aluno+valor+vencimento+descricao (ignora status e provedor,
  // pra pegar duplicata mesmo que uma esteja paga e outra nao, ou provedores diferentes).
  const grupos = new Map();
  for (const l of linhas) {
    const chave = [l.aluno_id, l.valor_centavos, l.vencimento, l.descricao || ''].join('|');
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  }
  const duplicados = [...grupos.values()].filter((g) => g.length > 1);
  const totalExtra = duplicados.reduce((s, g) => s + (g.length - 1), 0);

  console.log(`Grupos (aluno+valor+vencimento+descrição) com mais de 1 cobrança: ${duplicados.length}`);
  console.log(`Linhas "extras" nesses grupos: ${totalExtra}`);
  console.log('');
  console.log('--- Detalhe de cada grupo duplicado ---');
  for (const g of duplicados.sort((a, b) => b.length - a.length)) {
    const ex = g[0];
    console.log(`  ${g.length}x  aluno "${ex.aluno_nome}" (${ex.aluno_id})  valor R$${(ex.valor_centavos / 100).toFixed(2)}  venc ${ex.vencimento}  desc "${ex.descricao || ''}"`);
    for (const l of g) {
      console.log(`      id ${l.id}  provedor ${l.provedor}  status ${l.status}  matricula_id ${l.matricula_id || '-'}  criado_em ${l.criado_em}`);
    }
  }

  console.log('');
  console.log('Nada foi alterado — isto é só diagnóstico.');
}

main()
  .catch((err) => {
    console.error('Erro:', err.message);
    process.exit(1);
  })
  .finally(() => process.exit(0));
