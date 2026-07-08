// Diagnóstico pós-migração v2: investiga a duplicação encontrada em produção
// depois de rodar migrar-secullum-v2.js --confirmar-producao (secullum_id
// não existia antes desta sessão, então qualquer registro anterior à
// migração v2 ficou com secullum_id/secullum_numero NULL - a v2 não
// reconheceu esses registros como "já existentes" e inseriu um conjunto novo
// por cima, duplicando quase toda a base).
//
// Só faz leitura (SELECT/COUNT) - nunca escreve nada. Objetivo: confirmar a
// hipótese e, principalmente, checar se algum dos registros "sem
// secullum_id" tem atividade REAL (pagamento pelo totem, checkin, acesso de
// catraca) que indicaria gente que se cadastrou de verdade no app - esses
// NUNCA podem ser tratados como lixo de migração antiga e apagados.
//
// Como rodar (a partir da pasta academia-gestao):
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/diagnosticar-duplicacao-pos-v2.js --confirmar-producao"

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

async function main() {
  console.log('=== ALUNOS: com vs sem secullum_id ===');
  const comId = await db.execute(`SELECT COUNT(*) AS n FROM alunos WHERE secullum_id IS NOT NULL`);
  const semId = await db.execute(`SELECT COUNT(*) AS n FROM alunos WHERE secullum_id IS NULL`);
  console.log(`  com secullum_id (migração v2 desta sessão): ${comId.rows[0].n}`);
  console.log(`  sem secullum_id (possível leftover de migração antiga OU cadastro real): ${semId.rows[0].n}`);

  console.log('\n=== Faixa de datas do grupo SEM secullum_id (criado_em) ===');
  const faixaSemId = await db.execute(`
    SELECT MIN(criado_em) AS mais_antigo, MAX(criado_em) AS mais_recente
    FROM alunos WHERE secullum_id IS NULL
  `);
  console.log(`  mais antigo: ${faixaSemId.rows[0].mais_antigo}`);
  console.log(`  mais recente: ${faixaSemId.rows[0].mais_recente}`);

  console.log('\n=== Faixa de datas do grupo COM secullum_id (deve ser hoje, a migração desta sessão) ===');
  const faixaComId = await db.execute(`
    SELECT MIN(criado_em) AS mais_antigo, MAX(criado_em) AS mais_recente
    FROM alunos WHERE secullum_id IS NOT NULL
  `);
  console.log(`  mais antigo: ${faixaComId.rows[0].mais_antigo}`);
  console.log(`  mais recente: ${faixaComId.rows[0].mais_recente}`);

  console.log('\n=== Quantos do grupo SEM secullum_id têm o MESMO CPF de alguém do grupo COM secullum_id ===');
  console.log('(indica fortemente que é a mesma pessoa duplicada, não um cadastro real diferente)');
  const cruzamentoCpf = await db.execute(`
    SELECT COUNT(*) AS n FROM alunos a
    WHERE a.secullum_id IS NULL AND a.cpf IS NOT NULL AND a.cpf != ''
      AND EXISTS (SELECT 1 FROM alunos b WHERE b.secullum_id IS NOT NULL AND b.cpf = a.cpf)
  `);
  console.log(`  ${cruzamentoCpf.rows[0].n} de ${semId.rows[0].n} tiveram match de CPF`);

  console.log('\n=== ATIVIDADE REAL ligada ao grupo SEM secullum_id (NUNCA apagar se houver) ===');
  const comPagamentoTotem = await db.execute(`
    SELECT COUNT(DISTINCT a.id) AS n FROM alunos a
    JOIN pagamentos_totem pt ON pt.aluno_id = a.id
    WHERE a.secullum_id IS NULL
  `);
  console.log(`  alunos (sem secullum_id) com pagamento pelo totem: ${comPagamentoTotem.rows[0].n}`);

  const comCheckin = await db.execute(`
    SELECT COUNT(DISTINCT a.id) AS n FROM alunos a
    JOIN checkins c ON c.aluno_id = a.id
    WHERE a.secullum_id IS NULL
  `);
  console.log(`  alunos (sem secullum_id) com checkin registrado: ${comCheckin.rows[0].n}`);

  const comAcessoCatraca = await db.execute(`
    SELECT COUNT(DISTINCT a.id) AS n FROM alunos a
    JOIN acessos_catraca ac ON ac.aluno_id = a.id
    WHERE a.secullum_id IS NULL
  `);
  console.log(`  alunos (sem secullum_id) com acesso de catraca registrado: ${comAcessoCatraca.rows[0].n}`);

  console.log('\n=== Cobranças: com vs sem secullum_numero ===');
  const cobComId = await db.execute(`SELECT COUNT(*) AS n FROM cobrancas WHERE secullum_numero IS NOT NULL`);
  const cobSemId = await db.execute(`SELECT COUNT(*) AS n FROM cobrancas WHERE secullum_numero IS NULL`);
  console.log(`  com secullum_numero (migração v2 desta sessão): ${cobComId.rows[0].n}`);
  console.log(`  sem secullum_numero: ${cobSemId.rows[0].n}`);

  const cobSemIdPagas = await db.execute(`
    SELECT status, COUNT(*) AS n, provedor FROM cobrancas WHERE secullum_numero IS NULL GROUP BY status, provedor
  `);
  console.log('  detalhe das cobranças sem secullum_numero (status/provedor):');
  cobSemIdPagas.rows.forEach((r) => console.log(`    ${r.status} / ${r.provedor}: ${r.n}`));

  console.log('\n=== Matrículas: com vs sem secullum_id ===');
  const matComId = await db.execute(`SELECT COUNT(*) AS n FROM matriculas WHERE secullum_id IS NOT NULL`);
  const matSemId = await db.execute(`SELECT COUNT(*) AS n FROM matriculas WHERE secullum_id IS NULL`);
  console.log(`  com secullum_id: ${matComId.rows[0].n}`);
  console.log(`  sem secullum_id: ${matSemId.rows[0].n}`);

  console.log('\n=== Amostra de 10 alunos SEM secullum_id (pra inspeção manual) ===');
  const amostra = await db.execute(`
    SELECT id, nome, cpf, status, criado_em FROM alunos WHERE secullum_id IS NULL ORDER BY criado_em LIMIT 10
  `);
  amostra.rows.forEach((r) => console.log(`  ${r.nome} | cpf=${r.cpf || '(vazio)'} | status=${r.status} | criado_em=${r.criado_em}`));

  console.log('\n=== FIM DO DIAGNÓSTICO (nada foi alterado) ===');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro no diagnóstico:', err);
    process.exit(1);
  });
