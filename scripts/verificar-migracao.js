// Conferencia rapida pos-migracao: conta linhas nas tabelas principais e
// procura sinais de duplicidade (ex: rodar a migracao duas vezes por engano).
// So faz leitura (SELECT/COUNT) - nunca escreve nada.
//
// Como rodar contra o local.db de teste (a partir da pasta academia-gestao):
//   node scripts/verificar-migracao.js
//
// Como rodar contra PRODUCAO (Turso):
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/verificar-migracao.js --confirmar-producao"
const { createClient } = require('@libsql/client');
require('dotenv').config();

// Mesmo padrao de seguranca dos outros scripts de migracao: por padrao usa
// local.db; so troca de banco se DATABASE_URL ja estiver definido no
// ambiente (via rodar-producao-migracao.ps1), e mesmo assim exige
// --confirmar-producao explicito - mantido por consistencia, mesmo este
// script sendo só leitura.
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

async function contar(tabela) {
  try {
    const r = await db.execute(`SELECT COUNT(*) AS n FROM ${tabela}`);
    return r.rows[0].n;
  } catch (err) {
    if (/no such table/i.test(err.message)) return 'tabela não existe ainda';
    throw err;
  }
}

async function main() {
  const tabelas = [
    'alunos', 'usuarios', 'planos', 'matriculas', 'cobrancas',
    'pagamentos_cobranca', 'anamneses', 'avaliacoes_fisicas',
    'anamnese_respostas', 'anamnese_perguntas',
  ];

  console.log('=== CONTAGEM DE LINHAS ===');
  for (const t of tabelas) {
    console.log(`${t}: ${await contar(t)}`);
  }

  console.log('\n=== POSSIVEIS DUPLICATAS (mesmo nome+cpf em alunos) ===');
  const dup = await db.execute(`
    SELECT nome, cpf, COUNT(*) AS qtd
    FROM alunos
    WHERE cpf IS NOT NULL AND cpf <> ''
    GROUP BY nome, cpf
    HAVING COUNT(*) > 1
    ORDER BY qtd DESC
    LIMIT 20
  `);
  if (dup.rows.length === 0) {
    console.log('Nenhuma duplicata encontrada (bom sinal).');
  } else {
    console.log(`Encontradas ${dup.rows.length} combinacoes de nome+cpf duplicadas:`);
    dup.rows.forEach((r) => console.log(`  ${r.nome} (${r.cpf}): ${r.qtd}x`));
  }

  console.log('\n=== PERGUNTAS DE ANAMNESE CADASTRADAS ===');
  const perguntas = await contar('anamnese_perguntas');
  console.log(`anamnese_perguntas: ${perguntas} (esperado: 26 -- se for multiplo disso, ex 52, a migracao rodou mais de uma vez)`);

  console.log('\n=== USUARIOS JA EXISTENTES (conferir antes de migrar, evitar colisao de login/e-mail) ===');
  const usuariosExistentes = await db.execute('SELECT nome, usuario, email, papel FROM usuarios ORDER BY nome');
  usuariosExistentes.rows.forEach((u) => console.log(`  ${u.nome} | usuario=${u.usuario || '(vazio)'} | email=${u.email} | papel=${u.papel}`));

  console.log('\n=== ALUNOS JA EXISTENTES (conferir antes de migrar) ===');
  const alunosExistentes = await db.execute('SELECT nome, cpf, email, status FROM alunos ORDER BY nome');
  alunosExistentes.rows.forEach((a) => console.log(`  ${a.nome} | cpf=${a.cpf || '(vazio)'} | email=${a.email || '(vazio)'} | status=${a.status}`));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao verificar:', err);
    process.exit(1);
  });
