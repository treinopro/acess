// Hipotese: o mesmo aluno tem, no mesmo mes, UMA cobranca vinda da migracao
// do Secullum (provedor 'legado' — o "contas a receber" que ja estava em
// aberto la na epoca do export) E OUTRA gerada pelo proprio academia-gestao
// (provedor 'recorrencia', pela rotina gerarCobrancasRecorrentes). Sao a
// MESMA mensalidade contada duas vezes por caminhos diferentes — nao bateram
// no diagnostico anterior (aluno+valor+vencimento+descricao) porque valor,
// descricao ou o dia exato do vencimento podem diferir um pouco entre os
// dois sistemas. Aqui o agrupamento e' so por aluno + mes, ignorando valor/
// descricao/dia exato, pra pegar esses casos. So relatorio, nao apaga nada.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/diagnosticar-legado-vs-recorrencia.js 2026-07

require('dotenv').config();
const db = require('../src/db/client');

async function main() {
  const mes = process.argv[2] || new Date().toISOString().slice(0, 7);

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

  const porAluno = new Map();
  for (const l of linhas) {
    if (!porAluno.has(l.aluno_id)) porAluno.set(l.aluno_id, []);
    porAluno.get(l.aluno_id).push(l);
  }

  const comAmbos = [...porAluno.values()].filter((g) => {
    const provedores = new Set(g.map((l) => l.provedor));
    return provedores.has('legado') && provedores.has('recorrencia');
  });

  console.log(`Cobranças de ${mes} em 'legado' + 'recorrencia': ${linhas.length}`);
  console.log(`Alunos com cobrança 'legado' E 'recorrencia' no mesmo mês (possível cobrança duplicada por caminhos diferentes): ${comAmbos.length}`);
  console.log('');

  for (const g of comAmbos) {
    console.log(`--- ${g[0].aluno_nome} (${g[0].aluno_id}) ---`);
    for (const l of g) {
      console.log(`    provedor ${l.provedor}  valor R$${(l.valor_centavos / 100).toFixed(2)}  venc ${l.vencimento}  status ${l.status}  desc "${l.descricao || ''}"  id ${l.id}`);
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
