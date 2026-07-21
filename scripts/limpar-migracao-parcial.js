// Reverte uma execucao parcial/interrompida de migrar-secullum.js, preservando
// os dados que ja existiam ANTES de qualquer tentativa de migracao (conferidos
// manualmente): 5 alunos, 2 usuarios, 3 planos (e as matriculas/cobrancas/
// pagamentos que referenciam esses alunos).
const db = require('../src/db/client');

// Identificam de forma unica os registros PRE-EXISTENTES (checados antes da
// primeira tentativa de migracao) -- tudo que nao bater com isso e' considerado
// inserido pela migracao e sera removido.
const ALUNOS_ORIGINAIS = [
  { nome: 'Robson', cpf: '12345678912' },
  { nome: 'Robson Junior', cpf: '41396743855' },
  { nome: 'dsfdf', cpf: '12345678918' },
  { nome: 'junior', cpf: '14253698723' },
  { nome: 'teste q', cpf: '12345678910' },
];

const USUARIOS_ORIGINAIS_EMAILS = ['brye_@hotmail.com', 'academiasuperacao01@gmail.com', 'junior007eai@gmail.com'];

// Nomes de planos inseridos pela migracao (vindos do Secullum) -- qualquer
// plano com um desses nomes exatos e' removido; o resto (os 3 originais) fica.
const PLANOS_MIGRADOS = [
  'MUSCULAÇÃO', 'MUSCULAÇÃO TRIMESTRAL', 'Trimestral', 'Anual', 'Semestral',
  'Consultoria trimestral', 'Musc+Aéro 75', 'MUSCULAÇÃO + AÉROBICA',
];

async function main() {
  // 1. Descobre os IDs dos 5 alunos originais (mantidos)
  const idsAlunosOriginais = [];
  for (const a of ALUNOS_ORIGINAIS) {
    const r = await db.execute({ sql: 'SELECT id FROM alunos WHERE nome = ? AND cpf = ?', args: [a.nome, a.cpf] });
    if (r.rows[0]) idsAlunosOriginais.push(r.rows[0].id);
  }
  console.log(`Alunos originais preservados: ${idsAlunosOriginais.length} de ${ALUNOS_ORIGINAIS.length} esperados`);
  if (idsAlunosOriginais.length !== ALUNOS_ORIGINAIS.length) {
    throw new Error('Não encontrei todos os 5 alunos originais esperados — parando por segurança (nada foi apagado ainda).');
  }
  const placeholdersAlunos = idsAlunosOriginais.map(() => '?').join(',');

  // 2. Apaga dependentes dos alunos migrados (tudo cujo aluno_id NAO esta na lista original)
  await db.execute({
    sql: `DELETE FROM pagamentos_cobranca WHERE cobranca_id IN (
            SELECT id FROM cobrancas WHERE aluno_id NOT IN (${placeholdersAlunos})
          )`,
    args: idsAlunosOriginais,
  });
  const cobrancasApagadas = await db.execute({
    sql: `DELETE FROM cobrancas WHERE aluno_id NOT IN (${placeholdersAlunos})`,
    args: idsAlunosOriginais,
  });
  const matriculasApagadas = await db.execute({
    sql: `DELETE FROM matriculas WHERE aluno_id NOT IN (${placeholdersAlunos})`,
    args: idsAlunosOriginais,
  });
  await db.execute({
    sql: `DELETE FROM anamnese_respostas WHERE anamnese_id IN (
            SELECT id FROM anamneses WHERE aluno_id NOT IN (${placeholdersAlunos})
          )`,
    args: idsAlunosOriginais,
  });
  await db.execute({ sql: `DELETE FROM anamneses WHERE aluno_id NOT IN (${placeholdersAlunos})`, args: idsAlunosOriginais });
  await db.execute({ sql: `DELETE FROM avaliacoes_fisicas WHERE aluno_id NOT IN (${placeholdersAlunos})`, args: idsAlunosOriginais });

  // 3. Apaga os alunos migrados
  const alunosApagados = await db.execute({
    sql: `DELETE FROM alunos WHERE id NOT IN (${placeholdersAlunos})`,
    args: idsAlunosOriginais,
  });

  // 4. Apaga usuarios migrados (mantém só os 2 originais por e-mail)
  const placeholdersEmails = USUARIOS_ORIGINAIS_EMAILS.map(() => '?').join(',');
  const usuariosApagados = await db.execute({
    sql: `DELETE FROM usuarios WHERE email NOT IN (${placeholdersEmails})`,
    args: USUARIOS_ORIGINAIS_EMAILS,
  });

  // 5. Apaga planos migrados (pelos nomes conhecidos do Secullum)
  const placeholdersPlanos = PLANOS_MIGRADOS.map(() => '?').join(',');
  const planosApagados = await db.execute({
    sql: `DELETE FROM planos WHERE nome IN (${placeholdersPlanos})`,
    args: PLANOS_MIGRADOS,
  });

  // 6. Apaga o catalogo de perguntas de anamnese (nao existia antes, sera recriado do zero)
  const perguntasApagadas = await db.execute('DELETE FROM anamnese_perguntas');

  console.log('\n=== LIMPEZA CONCLUIDA ===');
  console.log(`alunos apagados: ${alunosApagados.rowsAffected}`);
  console.log(`usuarios apagados: ${usuariosApagados.rowsAffected}`);
  console.log(`planos apagados: ${planosApagados.rowsAffected}`);
  console.log(`matriculas apagadas: ${matriculasApagadas.rowsAffected}`);
  console.log(`cobrancas apagadas: ${cobrancasApagadas.rowsAffected}`);
  console.log(`anamnese_perguntas apagadas: ${perguntasApagadas.rowsAffected}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro na limpeza:', err);
    process.exit(1);
  });
