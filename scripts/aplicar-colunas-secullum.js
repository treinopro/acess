// Adiciona (de forma idempotente) as colunas e indices de idempotencia da
// migracao do Secullum a um banco EXISTENTE - necessario porque
// "CREATE TABLE IF NOT EXISTS" (em schema.sql) nao mexe em tabelas que ja
// existem. Rodar isso ANTES de scripts/migrar-secullum-v2.js.
//
// Seguro rodar quantas vezes quiser: cada ALTER TABLE so roda se a coluna
// ainda nao existir (confere via PRAGMA table_info antes). So ADICIONA
// coluna/indice - nunca apaga nem altera dado existente.
//
// Como rodar contra o local.db de teste (a partir da pasta academia-gestao):
//   node scripts/aplicar-colunas-secullum.js
//
// Como rodar contra PRODUCAO (Turso):
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/aplicar-colunas-secullum.js --confirmar-producao"

const { createClient } = require('@libsql/client');
require('dotenv').config();

// Mesmo padrao de seguranca do migrar-secullum-v2.js: por padrao usa
// local.db; so troca de banco se DATABASE_URL ja estiver definido no
// ambiente (via rodar-producao-migracao.ps1), e mesmo assim exige
// --confirmar-producao explicito. Ver comentario completo em
// migrar-secullum-v2.js.
const DATABASE_URL = process.env.DATABASE_URL || 'file:./local.db';
const USANDO_PRODUCAO = DATABASE_URL !== 'file:./local.db';
const CONFIRMAR_PRODUCAO = process.argv.includes('--confirmar-producao');
if (USANDO_PRODUCAO && !CONFIRMAR_PRODUCAO) {
  console.error('\n=== BLOQUEADO ===');
  console.error('DATABASE_URL aponta para um banco que NAO e o local.db de teste:');
  console.error(`  ${DATABASE_URL}`);
  console.error('Rode de novo com --confirmar-producao se for isso mesmo que voce quer.');
  process.exit(1);
}

const db = createClient({
  url: DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

if (USANDO_PRODUCAO) {
  console.log('\n=========================================================');
  console.log(' ATENCAO: conectado em PRODUCAO (Turso), nao e o local.db');
  console.log(` URL: ${DATABASE_URL}`);
  console.log('=========================================================\n');
}

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
