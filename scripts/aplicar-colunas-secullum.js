// Adiciona (de forma idempotente) as colunas e indices de idempotencia da
// migracao do Secullum a um banco EXISTENTE - necessario porque
// "CREATE TABLE IF NOT EXISTS" (em schema.sql) nao mexe em tabelas que ja
// existem. Rodar isso ANTES de scripts/migrar-secullum-v2.js.
//
// Seguro rodar quantas vezes quiser: cada ALTER TABLE so roda se a coluna
// ainda nao existir (confere via PRAGMA table_info antes).
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/aplicar-colunas-secullum.js

const { createClient } = require('@libsql/client');

const db = createClient({ url: 'file:./local.db' });

const COLUNAS = [
  { tabela: 'alunos', coluna: 'secullum_id', definicao: 'TEXT' },
  { tabela: 'planos', coluna: 'secullum_id', definicao: 'TEXT' },
  { tabela: 'matriculas', coluna: 'secullum_id', definicao: 'TEXT' },
  { tabela: 'cobrancas', coluna: 'secullum_numero', definicao: 'TEXT' },
];

const INDICES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_secullum_id ON alunos(secullum_id) WHERE secullum_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_planos_secullum_id ON planos(secullum_id) WHERE secullum_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_matriculas_secullum_id ON matriculas(secullum_id) WHERE secullum_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cobrancas_secullum_numero ON cobrancas(secullum_numero) WHERE secullum_numero IS NOT NULL`,
];

async function colunaExiste(tabela, coluna) {
  const info = await db.execute(`PRAGMA table_info(${tabela})`);
  return info.rows.some((r) => r.name === coluna);
}

async function main() {
  for (const { tabela, coluna, definicao } of COLUNAS) {
    const existe = await colunaExiste(tabela, coluna);
    if (existe) {
      console.log(`  já existe: ${tabela}.${coluna}`);
      continue;
    }
    await db.execute(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    console.log(`  adicionada: ${tabela}.${coluna}`);
  }

  for (const sql of INDICES) {
    await db.execute(sql);
  }
  console.log('  índices de idempotência OK');

  console.log('\n=== Colunas e índices de idempotência da migração aplicados ===');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao aplicar colunas:', err);
    process.exit(1);
  });
