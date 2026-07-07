// Diagnostica cobrancas duplicadas geradas por reexecucao de
// scripts/migrar-secullum.js. Esse script de migracao insere cada cobranca
// com um `id` novo (uuid()) a cada rodada — o `INSERT OR IGNORE` so evita
// duplicata dentro da MESMA execucao (colisao de id), entao rodar a
// migracao mais de uma vez cria um segundo (ou terceiro) conjunto completo
// de cobrancas pra cada conta a receber do Secullum, todas com provedor =
// 'legado'.
//
// Este script SO GERA RELATORIO — nao apaga nada. E o passo 1; depois de
// conferir os grupos aqui, escrevo o script de limpeza de verdade (nos
// moldes do scripts/limpar-fantasmas-mensalidade.js ja usado antes).
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/diagnosticar-duplicatas-migracao.js

require('dotenv').config();
const db = require('../src/db/client');

async function main() {
  const result = await db.execute(
    `SELECT c.id, c.aluno_id, a.nome AS aluno_nome, c.valor_centavos, c.vencimento,
            c.descricao, c.status, c.criado_em
     FROM cobrancas c
     LEFT JOIN alunos a ON a.id = c.aluno_id
     WHERE c.provedor = 'legado'
     ORDER BY c.aluno_id, c.valor_centavos, c.vencimento, c.descricao, c.status, c.criado_em`
  );
  const linhas = result.rows;
  console.log(`Total de cobranças com provedor = 'legado': ${linhas.length}`);

  const grupos = new Map();
  for (const l of linhas) {
    const chave = [l.aluno_id, l.valor_centavos, l.vencimento, l.descricao || '', l.status].join('|');
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  }

  const duplicados = [...grupos.values()].filter((g) => g.length > 1);
  const totalExtra = duplicados.reduce((soma, g) => soma + (g.length - 1), 0);

  console.log(`Grupos únicos (aluno+valor+vencimento+descrição+status): ${grupos.size}`);
  console.log(`Grupos com mais de 1 cobrança idêntica: ${duplicados.length}`);
  console.log(`Linhas "extras" (o que sobraria de remover, mantendo 1 por grupo): ${totalExtra}`);

  // Quantas dessas duplicatas já têm pagamento vinculado (pra saber se a
  // limpeza vai precisar mexer em pagamentos_cobranca também).
  let comPagamento = 0;
  if (duplicados.length) {
    const idsDuplicados = duplicados.flatMap((g) => g.map((l) => l.id));
    const placeholders = idsDuplicados.map(() => '?').join(',');
    const pg = await db.execute({
      sql: `SELECT DISTINCT cobranca_id FROM pagamentos_cobranca WHERE cobranca_id IN (${placeholders})`,
      args: idsDuplicados,
    });
    comPagamento = pg.rows.length;
  }
  console.log(`Dessas linhas duplicadas, quantas têm pagamento_cobranca vinculado: ${comPagamento}`);

  console.log('');
  console.log('--- Amostra dos 20 maiores grupos duplicados ---');
  const ordenados = duplicados.sort((a, b) => b.length - a.length).slice(0, 20);
  for (const g of ordenados) {
    const ex = g[0];
    console.log(
      `  ${g.length}x  aluno "${ex.aluno_nome || '(sem aluno)'}" (${ex.aluno_id})  valor R$${(ex.valor_centavos / 100).toFixed(2)}  venc ${ex.vencimento}  status ${ex.status}  desc "${ex.descricao || ''}"`
    );
    for (const l of g) console.log(`      id ${l.id}  criado_em ${l.criado_em}`);
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
