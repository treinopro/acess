/**
 * Sincronização periódica Turso -> local.db (cache/fallback offline do
 * totem — ver src/db/clientOffline.js e dbResiliente.service.js). Só é
 * chamado quando MODO_TOTEM_OFFLINE=true (ver server.js).
 *
 * Puxa um retrato completo de `planos`, `alunos`, `matriculas`, `cobrancas` e
 * `pagamentos_cobranca` — as tabelas usadas tanto pelas leituras de decisão
 * de acesso (ver acessoTerminal.service.js: motivoBloqueioPorStatus /
 * possuiCobrancaEmAtraso / buscarAlunoPorCpf(ParaAcesso) /
 * encontrarMelhorMatchFacial(ParaAcesso)) quanto pelas CONSULTAS de cadastro
 * no painel (ver alunos.routes.js: busca, perfil do aluno) e pela checagem de
 * conflito da fila de edições offline (ver filaCadastroOffline.service.js) —
 * e SOBRESCREVE essas tabelas no local.db.
 *
 * Direção única de propósito: Turso -> local.db, nunca o contrário (exceto
 * pela fila de edições/pagamentos pendentes, que fica só num arquivo .jsonl à
 * parte — ver filaCadastroOffline.service.js e filaAcessosOffline.service.js
 * — nunca escrita direto nestas tabelas do local.db). O local.db não é fonte
 * de verdade de cadastro nenhuma — só um espelho usado em caso de queda de
 * internet, aceitando que o dado ali pode estar até ~SYNC_OFFLINE_INTERVALO_MS
 * desatualizado (risco aceito pelo dono do sistema).
 *
 * Apaga e reinsere tudo em vez de calcular um diff — mais simples e seguro,
 * e o volume esperado (alunos de uma única academia) é pequeno o bastante
 * pra isso ser rápido. Ordem de DELETE (filhos antes dos pais) e INSERT (pais
 * antes dos filhos) respeita a cadeia de dependência: planos <- alunos <-
 * matriculas <- cobrancas <- pagamentos_cobranca — evita qualquer problema de
 * FK, mesmo que o SQLite não esteja com PRAGMA foreign_keys ligado.
 *
 * Pré-requisito: o local.db do PC do totem precisa ter o schema completo
 * (rodar `node scripts/atualizar-schema-local.js` uma vez, se ainda não
 * tiver rodado nesse arquivo local.db) — sem isso, `matriculas`/`planos`/
 * `pagamentos_cobranca` podem não existir ainda nesse banco.
 */

const db = require('../db/client');
const dbOffline = require('../db/clientOffline');

function log(...args) {
  console.log(`[syncOfflineCache ${new Date().toISOString()}]`, ...args);
}

// Colunas que cada tabela tem no local.db (preenchido por alinharColunas).
const colunasLocais = {};

/**
 * Garante que o local.db tenha todas as colunas que a tabela já tem no Turso.
 * Sem isso, qualquer coluna criada só no Turso (ex.: alunos.atualizado_em,
 * criada pelo servidor ao subir) faz o INSERT do espelho falhar ("table alunos
 * has no column named ...") e o batch inteiro é desfeito: o espelho ficou
 * congelado desde 11/09/2026 e o painel, ao cair no fallback, não mostrava os
 * alunos novos. Aqui só ADICIONA colunas ao local.db (nunca mexe no Turso).
 */
async function alinharColunas(tabela) {
  const [remotas, locais] = await Promise.all([
    db.execute(`PRAGMA table_info(${tabela})`),
    dbOffline.execute(`PRAGMA table_info(${tabela})`),
  ]);
  const nomesLocais = new Set(locais.rows.map((r) => r.name));
  for (const col of remotas.rows) {
    if (nomesLocais.has(col.name)) continue;
    try {
      await dbOffline.execute(`ALTER TABLE ${tabela} ADD COLUMN "${col.name}" ${col.type || 'TEXT'}`);
      nomesLocais.add(col.name);
      log(`Coluna "${col.name}" adicionada em ${tabela} do local.db (existia só no Turso).`);
    } catch (err) {
      log(`Não foi possível adicionar a coluna "${col.name}" em ${tabela} do local.db — será ignorada na cópia:`, err.message);
    }
  }
  colunasLocais[tabela] = nomesLocais;
}

function montarInserts(tabela, linhas) {
  return linhas.map((linha) => {
    // Só copia colunas que existem no local.db (alinharColunas já tentou criar as que faltavam).
    const colunas = Object.keys(linha).filter((c) => !colunasLocais[tabela] || colunasLocais[tabela].has(c));
    return {
      sql: `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${colunas.map(() => '?').join(', ')})`,
      args: colunas.map((coluna) => linha[coluna]),
    };
  });
}

async function sincronizar() {
  for (const tabela of ['planos', 'alunos', 'matriculas', 'cobrancas', 'pagamentos_cobranca']) {
    await alinharColunas(tabela);
  }
  const [resultPlanos, resultAlunos, resultMatriculas, resultCobrancas, resultPagamentos] = await Promise.all([
    db.execute('SELECT * FROM planos'),
    db.execute('SELECT * FROM alunos'),
    db.execute('SELECT * FROM matriculas'),
    db.execute('SELECT * FROM cobrancas'),
    db.execute('SELECT * FROM pagamentos_cobranca'),
  ]);

  const statements = [
    // DELETE: filhos antes dos pais.
    { sql: 'DELETE FROM pagamentos_cobranca', args: [] },
    { sql: 'DELETE FROM cobrancas', args: [] },
    { sql: 'DELETE FROM matriculas', args: [] },
    { sql: 'DELETE FROM alunos', args: [] },
    { sql: 'DELETE FROM planos', args: [] },
    // INSERT: pais antes dos filhos.
    ...montarInserts('planos', resultPlanos.rows),
    ...montarInserts('alunos', resultAlunos.rows),
    ...montarInserts('matriculas', resultMatriculas.rows),
    ...montarInserts('cobrancas', resultCobrancas.rows),
    ...montarInserts('pagamentos_cobranca', resultPagamentos.rows),
  ];

  await dbOffline.batch(statements, 'write');
  log(
    `Cache local atualizado: ${resultPlanos.rows.length} plano(s), ${resultAlunos.rows.length} aluno(s), `
    + `${resultMatriculas.rows.length} matrícula(s), ${resultCobrancas.rows.length} cobrança(s), `
    + `${resultPagamentos.rows.length} pagamento(s) de cobrança.`,
  );
}

module.exports = { sincronizar };
