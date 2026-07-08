// Atualiza (de forma idempotente) o local.db de teste para o schema.sql mais
// recente: adiciona as colunas de desconto que faltam em "planos" e cria as
// tabelas do modulo de treino que faltam ("treinos", "treino_exercicios") -
// alem de reconfirmar "pagamentos_totem". Necessario porque local.db foi
// criado com uma versao mais antiga do schema.sql e "CREATE TABLE IF NOT
// EXISTS" nunca mexe em tabela que ja existe (por isso "planos" ficou sem as
// colunas novas), e porque a tabela "treinos" nunca chegou a ser criada
// nesse banco.
//
// Contexto: rodando o servidor contra local.db (via rodar-local.ps1) a aba
// Financeiro quebrava com "no such column: pl.desconto_tipo" e a aba Treino
// quebrava com "no such table: treinos" - ambas as rotas (pagamentos.routes.js
// e treinos.routes.js) esperam esse schema atualizado e nao tem nenhuma
// tolerancia a coluna/tabela faltando (diferente dos scripts de
// migracao/limpeza, que so leem/escrevem local.db e tinham essa tolerancia
// adicionada a mao).
//
// Sempre usa 'file:./local.db' na marra (nunca '../src/db/client'), seguindo
// a mesma regra de seguranca dos outros scripts de teste local: isto NUNCA
// deve rodar contra a producao.
//
// Seguro rodar quantas vezes quiser: cada ALTER TABLE so roda se a coluna
// ainda nao existir, e os CREATE TABLE/INDEX usam IF NOT EXISTS.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/atualizar-schema-local.js

const { createClient } = require('@libsql/client');

const db = createClient({ url: 'file:./local.db' });

const COLUNAS = [
  { tabela: 'planos', coluna: 'desconto_tipo', definicao: 'TEXT' },
  { tabela: 'planos', coluna: 'desconto_percentual', definicao: 'REAL' },
  { tabela: 'planos', coluna: 'desconto_valor_centavos', definicao: 'INTEGER' },
  { tabela: 'planos', coluna: 'desconto_forma_pagamento', definicao: 'TEXT' },
];

const TABELAS = [
  `CREATE TABLE IF NOT EXISTS treinos (
    id TEXT PRIMARY KEY,
    aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    dias_semana TEXT,
    ordem INTEGER NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS treino_exercicios (
    id TEXT PRIMARY KEY,
    treino_id TEXT NOT NULL REFERENCES treinos(id) ON DELETE CASCADE,
    exercicio TEXT NOT NULL,
    series TEXT,
    carga TEXT,
    intervalo TEXT,
    observacao TEXT,
    ordem INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS pagamentos_totem (
    id TEXT PRIMARY KEY,
    aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
    cobranca_ids TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL,
    provedor TEXT NOT NULL,
    provedor_referencia TEXT,
    status TEXT NOT NULL DEFAULT 'pendente',
    liberar_acesso INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

const INDICES = [
  `CREATE INDEX IF NOT EXISTS idx_treinos_aluno ON treinos(aluno_id)`,
  `CREATE INDEX IF NOT EXISTS idx_treino_exercicios_treino ON treino_exercicios(treino_id)`,
];

async function colunaExiste(tabela, coluna) {
  const info = await db.execute(`PRAGMA table_info(${tabela})`);
  return info.rows.some((r) => r.name === coluna);
}

async function tabelaExiste(tabela) {
  const r = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    args: [tabela],
  });
  return r.rows.length > 0;
}

async function main() {
  console.log('=== Colunas de desconto em "planos" ===');
  for (const { tabela, coluna, definicao } of COLUNAS) {
    const existe = await colunaExiste(tabela, coluna);
    if (existe) {
      console.log(`  já existe: ${tabela}.${coluna}`);
      continue;
    }
    await db.execute(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    console.log(`  adicionada: ${tabela}.${coluna}`);
  }

  console.log('\n=== Tabelas do módulo de treino / pagamentos_totem ===');
  for (const sql of TABELAS) {
    const nomeTabela = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1];
    const jaExistia = await tabelaExiste(nomeTabela);
    await db.execute(sql);
    console.log(`  ${jaExistia ? 'já existia' : 'criada'}: ${nomeTabela}`);
  }

  for (const sql of INDICES) {
    await db.execute(sql);
  }
  console.log('  índices de treino OK');

  console.log('\n=== Schema do local.db atualizado com sucesso ===');
  console.log('Pode reiniciar o servidor (rodar-local.ps1) e testar as abas Financeiro e Treino.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao atualizar schema:', err);
    process.exit(1);
  });
