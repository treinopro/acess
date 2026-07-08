// SOMENTE LEITURA - nao faz nenhum INSERT/UPDATE/DELETE.
//
// Verifica o impacto de ter subido o servidor com o .env apontando pro
// Turso de producao (nao pro local.db) - a rotina gerarCobrancasRecorrentes
// roda sozinha no boot do servidor, e como a producao nunca passou pela
// "adocao" de cobranca legado que fizemos no local.db, pode ter gerado
// cobranca duplicada/fantasma em cima de contas ja existentes.
//
// Usa deliberadamente '../src/db/client' (e nao um createClient hardcoded)
// para garantir que está olhando EXATAMENTE o mesmo banco que o servidor
// real usou - ou seja, o que estiver em DATABASE_URL no seu .env agora.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/diagnosticar-producao-recorrencia.js

const db = require('../src/db/client');

async function main() {
  console.log('=== Verificando qual banco isso esta lendo ===');
  // Nao da pra ver a URL diretamente (o client nao expoe), entao confere
  // pelo conteudo: se tiver colunas secullum_id, é o local.db migrado;
  // se nao tiver, é o Turso de producao original.
  const temSecullumId = await db.execute(`PRAGMA table_info(alunos)`);
  const colunas = temSecullumId.rows.map((r) => r.name);
  console.log(`Colunas de alunos: ${colunas.join(', ')}`);
  console.log(`--> ${colunas.includes('secullum_id') ? 'Isto parece ser o local.db migrado.' : 'Isto parece ser o banco de PRODUCAO original (sem secullum_id).'}\n`);

  console.log('=== Cobrancas criadas HOJE (possivel efeito da recorrencia rodando no boot) ===');
  const hoje = new Date().toISOString().slice(0, 10);
  const recentes = await db.execute({
    sql: `SELECT c.id, c.aluno_id, a.nome, c.matricula_id, c.valor_centavos, c.status, c.provedor, c.vencimento, c.criado_em
          FROM cobrancas c JOIN alunos a ON a.id = c.aluno_id
          WHERE date(c.criado_em) = ? ORDER BY c.criado_em DESC`,
    args: [hoje],
  });
  console.log(`Cobrancas com criado_em de hoje (${hoje}): ${recentes.rows.length}`);
  for (const c of recentes.rows.slice(0, 50)) {
    const valorReais = (Number(c.valor_centavos) / 100).toFixed(2).replace('.', ',');
    console.log(`  ${c.nome} | provedor=${c.provedor} | matricula_id=${c.matricula_id} | R$${valorReais} | status=${c.status} | vencimento=${c.vencimento} | criado_em=${c.criado_em}`);
  }
  if (recentes.rows.length > 50) console.log(`  ... e mais ${recentes.rows.length - 50}`);

  console.log('\n=== Matriculas com MAIS DE UMA cobranca no mesmo vencimento (indicio de duplicata) ===');
  const dup = await db.execute(`
    SELECT c.matricula_id, c.vencimento, COUNT(*) as qtd, a.nome
    FROM cobrancas c
    JOIN alunos a ON a.id = c.aluno_id
    WHERE c.matricula_id IS NOT NULL
    GROUP BY c.matricula_id, c.vencimento
    HAVING COUNT(*) > 1
    ORDER BY qtd DESC
    LIMIT 50
  `);
  console.log(`Grupos duplicados (matricula_id + vencimento repetido): ${dup.rows.length}`);
  for (const d of dup.rows) {
    console.log(`  ${d.nome} | matricula_id=${d.matricula_id} | vencimento=${d.vencimento} | ${d.qtd}x`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
