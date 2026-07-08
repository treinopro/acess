// Adiciona índices que faltam em colunas aluno_id usadas por FKs com
// ON DELETE CASCADE (anamneses, agendamentos, checkins, pagamentos_totem).
// Sem esses índices, cada DELETE FROM alunos força uma varredura completa
// dessas tabelas pra achar as linhas-filhas a apagar em cascata - foi o que
// deixou o --aplicar do reconciliar-migracao-v1-v2-producao.js muito lento
// (parou de progredir no meio do 2º lote de exclusões).
//
// Só cria índice (CREATE INDEX IF NOT EXISTS) - nunca apaga nem altera
// dado nenhum. Seguro rodar quantas vezes quiser, em qualquer banco.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/otimizar-indices-cascata.js
//
// Como rodar contra PRODUCAO:
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/otimizar-indices-cascata.js --confirmar-producao"

const { createClient } = require('@libsql/client');
require('dotenv').config();

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

const INDICES = [
  { nome: 'idx_anamneses_aluno', sql: 'CREATE INDEX IF NOT EXISTS idx_anamneses_aluno ON anamneses(aluno_id)' },
  { nome: 'idx_agendamentos_aluno', sql: 'CREATE INDEX IF NOT EXISTS idx_agendamentos_aluno ON agendamentos(aluno_id)' },
  { nome: 'idx_checkins_aluno', sql: 'CREATE INDEX IF NOT EXISTS idx_checkins_aluno ON checkins(aluno_id)' },
  { nome: 'idx_pagamentos_totem_aluno', sql: 'CREATE INDEX IF NOT EXISTS idx_pagamentos_totem_aluno ON pagamentos_totem(aluno_id)' },
];

async function main() {
  console.log('=== Criando índices que faltam (aluno_id em tabelas com ON DELETE CASCADE) ===\n');
  for (const { nome, sql } of INDICES) {
    const inicio = Date.now();
    await db.execute(sql);
    console.log(`  ${nome}: ok (${Date.now() - inicio}ms)`);
  }
  console.log('\n=== FIM - índices garantidos, nenhum dado foi alterado ===');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao criar índices:', err);
    process.exit(1);
  });
