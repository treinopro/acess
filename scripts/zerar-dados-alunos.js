// Zera TUDO que esta ligado a aluno (alunos, matriculas, cobrancas,
// pagamentos, anamneses, avaliacoes fisicas, treinos, agendamentos, checkins
// e acessos da catraca) para permitir uma remigracao limpa do Secullum.
//
// NAO mexe em: usuarios (login do painel), planos, turmas, configuracoes,
// anamnese_perguntas (catalogo de perguntas) - por pedido explicito, essas
// tabelas ficam como estao.
//
// Usado aqui (08/07/2026) pra resolver de vez o incidente de duplicação: em
// vez de reconciliar par-a-par o lote antigo (sem secullum_id) com o lote
// novo da migração v2 (uma operação que ficou travando repetidamente contra
// o Turso), decidimos apagar TODOS os alunos/matrículas/cobranças/etc. -
// tanto os antigos duplicados quanto os 1380 corretos já migrados - e rodar
// migrar-secullum-v2.js --confirmar-producao mais uma vez, do zero, contra
// o banco já limpo. Decisão explícita do usuário: perder também o punhado
// de atividade real (54 acessos de catraca, 2 pagamentos de totem, 53
// cobranças não-legado) é aceitável, porque o site só teve uso de teste
// dele mesmo até agora, nunca uso operacional real.
//
// MODO SEGURO POR PADRAO: dry-run sem --aplicar (só mostra quantas linhas
// cada tabela tem hoje, não apaga nada).
//
// Pre-requisito: rode scripts/aplicar-colunas-secullum.js pelo menos uma vez
// antes de remigrar (nao precisa rodar antes de zerar - só antes da
// migracao v2). Este script de zerar funciona independente disso.
//
// Como rodar contra o local.db de teste (a partir da pasta academia-gestao):
//   node scripts/zerar-dados-alunos.js            (dry-run - só mostra contagens)
//   node scripts/zerar-dados-alunos.js --aplicar   (apaga de verdade)
//
// Como rodar contra PRODUCAO:
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/zerar-dados-alunos.js --confirmar-producao"
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/zerar-dados-alunos.js --aplicar --confirmar-producao"

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

const APLICAR = process.argv.includes('--aplicar');

// Ordem que respeita as foreign keys: tabelas filhas antes das tabelas mae.
const TABELAS_EM_ORDEM = [
  'pagamentos_cobranca',
  'pagamentos_totem',
  'cobrancas',
  'checkins',
  'agendamentos',
  'anamnese_respostas',
  'anamneses',
  'avaliacoes_fisicas',
  'treino_exercicios',
  'treinos',
  'acessos_catraca',
  'matriculas',
  'alunos',
];

const TABELAS_MANTIDAS = ['usuarios', 'planos', 'turmas', 'configuracoes', 'anamnese_perguntas'];

async function tabelaExiste(tabela) {
  const r = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    args: [tabela],
  });
  return r.rows.length > 0;
}

async function contar(tabela) {
  const r = await db.execute(`SELECT COUNT(*) as n FROM ${tabela}`);
  return Number(r.rows[0].n);
}

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO (apaga de verdade)' : 'DRY-RUN (só mostra contagens, não apaga nada)'} ===\n`);

  // Descobre de antemao quais tabelas existem de verdade neste banco.
  // Bancos criados com uma versao mais antiga do schema.sql podem nao ter
  // todas as tabelas (ex: pagamentos_totem foi adicionada depois) - nesse
  // caso so pulamos essa tabela em vez de travar o script inteiro.
  const existentes = {};
  for (const tabela of [...TABELAS_EM_ORDEM, ...TABELAS_MANTIDAS]) {
    existentes[tabela] = await tabelaExiste(tabela);
  }

  console.log('Tabelas que SERÃO ZERADAS:');
  const contagens = {};
  for (const tabela of TABELAS_EM_ORDEM) {
    if (!existentes[tabela]) {
      console.log(`  ${tabela}: tabela não existe neste banco - pulando`);
      contagens[tabela] = null;
      continue;
    }
    contagens[tabela] = await contar(tabela);
    console.log(`  ${tabela}: ${contagens[tabela]} linha(s)`);
  }

  console.log('\nTabelas que NÃO são mexidas (mantidas como estão):');
  for (const tabela of TABELAS_MANTIDAS) {
    if (!existentes[tabela]) {
      console.log(`  ${tabela}: tabela não existe neste banco - pulando`);
      continue;
    }
    const n = await contar(tabela);
    console.log(`  ${tabela}: ${n} linha(s) — mantidas`);
  }

  if (!APLICAR) {
    console.log('\n=== FIM (dry-run — nada foi apagado) ===');
    console.log('Se os números acima fizerem sentido, rode de novo com --aplicar para apagar de verdade:');
    console.log('  node scripts/zerar-dados-alunos.js --aplicar');
    return;
  }

  console.log('\nApagando...');
  for (const tabela of TABELAS_EM_ORDEM) {
    if (!existentes[tabela]) {
      console.log(`  ${tabela}: tabela não existe neste banco - nada a apagar`);
      continue;
    }
    await db.execute(`DELETE FROM ${tabela}`);
    console.log(`  ${tabela}: apagada (${contagens[tabela]} linha(s) removida(s))`);
  }

  console.log('\n=== FIM (banco de alunos zerado) ===');
  console.log('Próximo passo: rodar scripts/migrar-secullum-v2.js --dry-run (ou --confirmar-producao) pra subir os dados limpos.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao zerar dados:', err);
    process.exit(1);
  });
