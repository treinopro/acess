/**
 * Pareamento de aparelhos do totem (2026-11).
 *
 * Antes, o tablet do totem se identificava com o TERMINAL_TOKEN escrito dentro de public/terminal.js — um arquivo
 * público: qualquer pessoa que abrisse o endereço do sistema podia ler o token e chamar a API do totem (lista de
 * alunos, código de acesso por CPF, contas por CPF...). Agora cada aparelho tem a SUA chave:
 *
 *   1. A recepção gera um código de pareamento no painel (vale 10 minutos, uso único).
 *   2. O aparelho digita o código e troca por uma chave própria (aleatória, 256 bits), guardada só nele.
 *   3. O servidor guarda apenas o hash da chave. Revogar um aparelho no painel invalida só a chave dele.
 *
 * Funciona nos dois servidores (nuvem e PC do totem), que compartilham o mesmo banco. O PC do totem precisa
 * continuar reconhecendo o aparelho se a internet cair: as chaves válidas ficam também em memória e num arquivo
 * local (hashes apenas), usados quando o banco não responde.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('../db/client');

const VALIDADE_CODIGO_MS = 10 * 60 * 1000;
const REVALIDAR_APOS_MS = 60 * 1000; // reconfere no banco (pega revogações) no máximo a cada 60 s por aparelho
const MAX_CODIGOS_ATIVOS = 5;
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L
const ARQUIVO_CACHE = process.env.CAMINHO_CACHE_APARELHOS || path.join(__dirname, '..', '..', 'aparelhos-cache.json');

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

let tabelasProntas = null;
function garantirTabelas() {
  if (!tabelasProntas) {
    tabelasProntas = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS aparelhos (
        id TEXT PRIMARY KEY, nome TEXT NOT NULL, chave_hash TEXT NOT NULL UNIQUE,
        criado_em TEXT NOT NULL DEFAULT (datetime('now')), ultimo_uso TEXT, revogado_em TEXT)`);
      await db.execute(`CREATE TABLE IF NOT EXISTS aparelhos_codigos (
        id TEXT PRIMARY KEY, codigo_hash TEXT NOT NULL UNIQUE, nome TEXT NOT NULL,
        expira_em TEXT NOT NULL, usado_em TEXT, criado_em TEXT NOT NULL DEFAULT (datetime('now')))`);
    })().catch((err) => { tabelasProntas = null; throw err; });
  }
  return tabelasProntas;
}

// ---- cache em memória + arquivo (tolerância a queda do banco no PC do totem) ----
const cache = new Map(); // chave_hash -> { id, nome, verificadoEm }
let cacheCarregado = false;
function carregarArquivo() {
  if (cacheCarregado) return;
  cacheCarregado = true;
  try {
    const dados = JSON.parse(fs.readFileSync(ARQUIVO_CACHE, 'utf8'));
    for (const a of dados.aparelhos || []) cache.set(a.chave_hash, { id: a.id, nome: a.nome, verificadoEm: 0 });
  } catch { /* sem arquivo ainda: tudo bem */ }
}
function gravarArquivo() {
  try {
    const aparelhos = [...cache.entries()].map(([chave_hash, a]) => ({ chave_hash, id: a.id, nome: a.nome }));
    fs.writeFileSync(ARQUIVO_CACHE, JSON.stringify({ atualizado_em: new Date().toISOString(), aparelhos }));
  } catch { /* disco somente-leitura etc.: o cache em memória continua valendo */ }
}

/** Valida a chave de um aparelho. Devolve { id, nome } ou null. Nunca lança. */
async function validarChave(chave) {
  if (!chave || typeof chave !== 'string' || chave.length < 32 || chave.length > 200) return null;
  carregarArquivo();
  const hash = sha256(chave);
  const emCache = cache.get(hash);
  if (emCache && Date.now() - emCache.verificadoEm < REVALIDAR_APOS_MS) return { id: emCache.id, nome: emCache.nome };
  try {
    await garantirTabelas();
    const r = await db.execute({ sql: 'SELECT id, nome FROM aparelhos WHERE chave_hash = ? AND revogado_em IS NULL', args: [hash] });
    const linha = r.rows[0];
    if (!linha) {
      if (cache.delete(hash)) gravarArquivo();
      return null;
    }
    const novo = !emCache;
    cache.set(hash, { id: linha.id, nome: linha.nome, verificadoEm: Date.now() });
    if (novo) gravarArquivo();
    // Marca o último uso sem atrasar a requisição.
    db.execute({ sql: "UPDATE aparelhos SET ultimo_uso = datetime('now') WHERE id = ? AND (ultimo_uso IS NULL OR ultimo_uso < datetime('now', '-10 minutes'))", args: [linha.id] }).catch(() => {});
    return { id: linha.id, nome: linha.nome };
  } catch {
    // Banco fora do ar (ex.: sem internet no PC do totem): vale o que já era conhecido como válido.
    return emCache ? { id: emCache.id, nome: emCache.nome } : null;
  }
}

function formatarCodigo(bruto) { return `${bruto.slice(0, 4)}-${bruto.slice(4)}`; }
const normalizarCodigo = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Gera um código de pareamento (uso único, 10 min). Devolve o código em claro UMA vez. */
async function emitirCodigoPareamento(nome) {
  await garantirTabelas();
  const nomeLimpo = String(nome || '').trim().slice(0, 60) || 'Aparelho do totem';
  const ativos = await db.execute("SELECT COUNT(*) AS n FROM aparelhos_codigos WHERE usado_em IS NULL AND expira_em > datetime('now')");
  if (Number(ativos.rows[0].n) >= MAX_CODIGOS_ATIVOS) {
    throw Object.assign(new Error('Já existem códigos de pareamento ativos. Aguarde expirarem (10 min) ou use um deles.'), { status: 429 });
  }
  let bruto = '';
  for (let i = 0; i < 8; i++) bruto += ALFABETO[crypto.randomInt(ALFABETO.length)];
  const expira = new Date(Date.now() + VALIDADE_CODIGO_MS);
  await db.execute({
    sql: "INSERT INTO aparelhos_codigos (id, codigo_hash, nome, expira_em) VALUES (?, ?, ?, ?)",
    args: [uuid(), sha256(bruto), nomeLimpo, expira.toISOString().slice(0, 19).replace('T', ' ')],
  });
  return { codigo: formatarCodigo(bruto), nome: nomeLimpo, expira_em: expira.toISOString() };
}

/** Troca um código válido por uma chave de aparelho. Devolve { chave, nome } ou null se o código não vale. */
async function parear(codigo) {
  const bruto = normalizarCodigo(codigo);
  if (bruto.length !== 8) return null;
  await garantirTabelas();
  const hash = sha256(bruto);
  // "Consome" o código de forma atômica: só quem marcar usado_em primeiro leva a chave.
  const consumido = await db.execute({
    sql: "UPDATE aparelhos_codigos SET usado_em = datetime('now') WHERE codigo_hash = ? AND usado_em IS NULL AND expira_em > datetime('now')",
    args: [hash],
  });
  if (consumido.rowsAffected === 0) return null;
  const linha = (await db.execute({ sql: 'SELECT nome FROM aparelhos_codigos WHERE codigo_hash = ?', args: [hash] })).rows[0];
  const chave = crypto.randomBytes(32).toString('hex');
  const id = uuid();
  await db.execute({ sql: 'INSERT INTO aparelhos (id, nome, chave_hash) VALUES (?, ?, ?)', args: [id, linha.nome, sha256(chave)] });
  carregarArquivo();
  cache.set(sha256(chave), { id, nome: linha.nome, verificadoEm: Date.now() });
  gravarArquivo();
  return { chave, id, nome: linha.nome };
}

async function listar() {
  await garantirTabelas();
  const r = await db.execute('SELECT id, nome, criado_em, ultimo_uso, revogado_em FROM aparelhos ORDER BY criado_em DESC');
  return r.rows;
}

async function revogar(id) {
  await garantirTabelas();
  const r = await db.execute({ sql: "UPDATE aparelhos SET revogado_em = datetime('now') WHERE id = ? AND revogado_em IS NULL", args: [id] });
  // Derruba já no processo atual (os outros servidores percebem em até 60 s).
  for (const [hash, a] of cache) if (a.id === id) cache.delete(hash);
  gravarArquivo();
  return r.rowsAffected > 0;
}

module.exports = {
  validarChave, emitirCodigoPareamento, parear, listar, revogar, garantirTabelas,
  VALIDADE_CODIGO_MS, REVALIDAR_APOS_MS,
  _limparCacheParaTeste: () => { cache.clear(); cacheCarregado = true; },
};
