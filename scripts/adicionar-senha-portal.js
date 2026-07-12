// Adiciona a coluna "portal_senha_revelada" em alunos e o índice único
// parcial em biometria_id — necessários pro novo recurso de senha do portal
// remoto (aluno passa a usar CPF + biometria_id, o mesmo código sequencial
// da catraca, como login a partir do primeiro acesso — ver
// src/routes/portal.routes.js e src/services/acessoTerminal.service.js).
//
// Idempotente: seguro rodar quantas vezes quiser (não faz nada se a coluna/
// índice já existirem).
//
// Como rodar contra o local.db de teste (a partir da pasta academia-gestao):
//   node scripts/adicionar-senha-portal.js
//
// Como rodar contra PRODUCAO (precisa rodar aqui — schema.sql sozinho não
// atualiza uma tabela que já existe):
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/adicionar-senha-portal.js --confirmar-producao"

require('dotenv').config();
const { createClient } = require('@libsql/client');

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

async function colunaExiste(tabela, coluna) {
  const info = await db.execute(`PRAGMA table_info(${tabela})`);
  return info.rows.some((r) => r.name === coluna);
}

async function main() {
  console.log('=== Coluna "portal_senha_revelada" em "alunos" ===');
  const existe = await colunaExiste('alunos', 'portal_senha_revelada');
  if (existe) {
    console.log('  já existe: alunos.portal_senha_revelada');
  } else {
    await db.execute('ALTER TABLE alunos ADD COLUMN portal_senha_revelada INTEGER NOT NULL DEFAULT 0');
    console.log('  adicionada: alunos.portal_senha_revelada');
  }

  console.log('\n=== Índice único em "biometria_id" ===');
  await db.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_biometria_id ON alunos(biometria_id) WHERE biometria_id IS NOT NULL',
  );
  console.log('  índice OK: idx_alunos_biometria_id');

  console.log('\n=== Migração da senha do portal concluída com sucesso ===');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro na migração:', err);
    process.exit(1);
  });
