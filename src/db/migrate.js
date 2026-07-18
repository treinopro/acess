const fs = require('fs');
const path = require('path');
const db = require('./client');

// Colunas adicionadas depois da versão inicial do schema. CREATE TABLE IF NOT EXISTS
// não altera tabelas já existentes, então bancos criados antes destas mudanças
// precisam de ALTER TABLE. Cada comando roda isolado e ignora erro de "coluna
// duplicada" para que rodar `npm run migrate` de novo seja sempre seguro.
const ALTERACOES_INCREMENTAIS = [
  "ALTER TABLE alunos ADD COLUMN biometria_id TEXT",
  "ALTER TABLE cobrancas ADD COLUMN descricao TEXT",
  "ALTER TABLE alunos ADD COLUMN codigo_acesso TEXT",
  "ALTER TABLE alunos ADD COLUMN face_descriptor TEXT",
  "ALTER TABLE usuarios ADD COLUMN usuario TEXT",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN medida_panturrilha_cm REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN imc_atual REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN imc_ideal REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN iac REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN massa_magra_kg REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN perfil_morfologico TEXT",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN dados_extras TEXT",
  // 'nativo' = treino cadastrado neste sistema (aba Treino no perfil) | 'app_externo'
  // = aluno acompanha o treino em outro aplicativo (vínculo por CPF/e-mail lá).
  "ALTER TABLE alunos ADD COLUMN treino_modo TEXT DEFAULT 'nativo'",
  // Desconto opcional por forma de pagamento (ex: "desconto pagamento em dinheiro").
  "ALTER TABLE planos ADD COLUMN desconto_tipo TEXT",
  "ALTER TABLE planos ADD COLUMN desconto_percentual REAL",
  "ALTER TABLE planos ADD COLUMN desconto_valor_centavos INTEGER",
  "ALTER TABLE planos ADD COLUMN desconto_forma_pagamento TEXT",
];

// Divide um arquivo .sql em statements individuais (o driver libsql nao aceita
// multiplos comandos separados por ';' em uma unica chamada .execute).
// Cuidado: um ';' pode aparecer DENTRO de uma linha de comentario ('-- texto; texto'),
// e nesse caso nao deve ser tratado como fim de statement - senao o pedaco cortado
// vira um "comando" formado só por comentário, sem SQL nenhum, e o banco rejeita
// com "SQL string does not contain any statement" (bug real, já visto em produção,
// causado por um comentário do schema.sql que tinha um ';' no meio do texto).
function dividirStatementsSQL(sql) {
  const MARCADOR = ''; // caractere de controle que nunca aparece no schema.sql de verdade
  const linhas = sql.split('\n');
  const linhasProtegidas = linhas.map((linha) => {
    const semEspacos = linha.trimStart();
    if (semEspacos.startsWith('--')) {
      // Linha é 100% comentário: protege qualquer ';' que apareça nela,
      // trocando por um marcador temporário até depois do split.
      return linha.split(';').join(MARCADOR);
    }
    return linha;
  });
  return linhasProtegidas
    .join('\n')
    .split(';')
    .map((s) => s.split(MARCADOR).join(';').trim())
    .filter(Boolean)
    // Rede de segurança extra: descarta qualquer statement que, tirando as
    // linhas de comentário, não sobrou nenhum SQL de verdade.
    .filter((s) => {
      const semComentarios = s
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim();
      return Boolean(semComentarios);
    });
}

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  const statements = dividirStatementsSQL(schema);

  // Índices (CREATE INDEX/CREATE UNIQUE INDEX) rodam DEPOIS dos ALTER TABLE
  // abaixo, de propósito: em bancos já existentes a tabela já existe (o
  // CREATE TABLE IF NOT EXISTS correspondente é ignorado), então um índice
  // sobre uma coluna nova (ex.: codigo_acesso) só pode ser criado depois que
  // o ALTER TABLE ADD COLUMN já rodou — senão dá "no such column".
  const statementsTabelas = statements.filter((s) => !/^CREATE (UNIQUE )?INDEX/i.test(s));
  const statementsIndices = statements.filter((s) => /^CREATE (UNIQUE )?INDEX/i.test(s));

  for (const statement of statementsTabelas) {
    await db.execute(statement);
  }

  let aplicadas = 0;
  for (const alteracao of ALTERACOES_INCREMENTAIS) {
    try {
      await db.execute(alteracao);
      aplicadas += 1;
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  }

  for (const statement of statementsIndices) {
    await db.execute(statement);
  }

  console.log(`Migração concluída: ${statements.length} statements de schema + ${aplicadas} alteração(ões) incremental(is) nova(s).`);
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao migrar banco de dados:', err);
    process.exit(1);
  });
