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

function montarInserts(tabela, linhas) {
  return linhas.map((linha) => {
    const colunas = Object.keys(linha);
    return {
      sql: `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${colunas.map(() => '?').join(', ')})`,
      args: colunas.map((coluna) => linha[coluna]),
    };
  });
}

async function sincronizar() {
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
