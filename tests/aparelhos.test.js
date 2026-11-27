// Pareamento de aparelhos do totem: o totem não depende mais de segredo público. Banco local descartável, sem rede.
// Rodar: node --test tests/aparelhos.test.js
process.env.DATABASE_URL = 'file:./teste-aparelhos.db';
delete process.env.DATABASE_AUTH_TOKEN;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste-jwt';
process.env.TERMINAL_TOKEN = 'token-do-terminal-de-teste-0123456789';
process.env.CAMINHO_CACHE_APARELHOS = require('path').resolve('./teste-aparelhos-cache.json');
delete process.env.TERMINAL_TOKEN_LEGADO_ATIVO;

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const arquivoBanco = path.resolve(process.env.DATABASE_URL.replace('file:', ''));
function limparBanco() {
  for (const f of [arquivoBanco, `${arquivoBanco}-journal`, `${arquivoBanco}-wal`, `${arquivoBanco}-shm`, process.env.CAMINHO_CACHE_APARELHOS]) { try { fs.unlinkSync(f); } catch (e) { /* ok */ } }
}
limparBanco();
require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'db', 'migrate.js')], {
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DATABASE_AUTH_TOKEN: '' },
  stdio: 'pipe',
});

const express = require('express');
const db = require('../src/db/client');
const { assinarToken } = require('../src/utils/jwt');
const aparelhos = require('../src/services/aparelhos.service');
let servidor; let base; let jwtAdmin;

before(async () => {
  jwtAdmin = assinarToken({ id: 'u1', email: 'admin@teste.com', papel: 'admin' });
  const app = express();
  app.use(express.json());
  app.use('/api/terminal', require('../src/routes/terminal.routes'));
  await new Promise((ok) => { servidor = http.createServer(app).listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => { servidor.closeAllConnections?.(); servidor.close(); limparBanco(); });

const post = (rota, corpo, cab = {}) => fetch(`${base}/api/terminal${rota}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cab }, body: JSON.stringify(corpo || {}) });
const admin = { Authorization: undefined };
const comAdmin = () => ({ Authorization: `Bearer ${jwtAdmin}` });

async function novoAparelho(nome = 'Tablet de teste') {
  const c = await (await post('/aparelhos/codigo', { nome }, comAdmin())).json();
  const p = await post('/aparelhos/parear', { codigo: c.codigo });
  assert.strictEqual(p.status, 200);
  return (await p.json()).chave;
}

test('só administrador gera código de pareamento', async () => {
  assert.strictEqual((await post('/aparelhos/codigo', {})).status, 401);
  const r = await post('/aparelhos/codigo', { nome: 'Tablet' }, comAdmin());
  assert.strictEqual(r.status, 201);
  assert.match((await r.json()).codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('o código troca por uma chave, uma única vez', async () => {
  const c = await (await post('/aparelhos/codigo', { nome: 'Uso único' }, comAdmin())).json();
  const a = await post('/aparelhos/parear', { codigo: c.codigo.toLowerCase() }); // tolera minúsculas
  assert.strictEqual(a.status, 200);
  const dados = await a.json();
  assert.match(dados.chave, /^[0-9a-f]{64}$/);
  assert.strictEqual((await post('/aparelhos/parear', { codigo: c.codigo })).status, 400, 'o mesmo código não pode parear duas vezes');
  assert.strictEqual((await post('/aparelhos/parear', { codigo: 'AAAA-BBBB' })).status, 400);
});

test('o banco guarda só o hash da chave, nunca a chave', async () => {
  const chave = await novoAparelho('Hash');
  const linhas = (await db.execute('SELECT chave_hash FROM aparelhos')).rows.map((r) => r.chave_hash);
  assert.ok(!linhas.includes(chave));
  assert.ok(linhas.some((h) => /^[0-9a-f]{64}$/.test(h)));
});

test('rota do tablet: aceita a chave do aparelho e recusa sem chave', async () => {
  const chave = await novoAparelho();
  const ok = await fetch(`${base}/api/terminal/aparelho/status`, { headers: { 'X-Device-Key': chave } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).pareado, true);
  const sem = await fetch(`${base}/api/terminal/aparelho/status`);
  assert.strictEqual(sem.status, 401);
  assert.strictEqual((await sem.json()).precisa_parear, true);
  const errada = await fetch(`${base}/api/terminal/aparelho/status`, { headers: { 'X-Device-Key': 'a'.repeat(64) } });
  assert.strictEqual(errada.status, 401);
});

test('revogar um aparelho derruba só a chave dele', async () => {
  const a = await novoAparelho('Será revogado');
  const b = await novoAparelho('Continua valendo');
  const lista = (await (await fetch(`${base}/api/terminal/aparelhos`, { headers: comAdmin() })).json()).aparelhos;
  const alvo = lista.find((x) => x.nome === 'Será revogado');
  const r = await fetch(`${base}/api/terminal/aparelhos/${alvo.id}`, { method: 'DELETE', headers: comAdmin() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await fetch(`${base}/api/terminal/aparelho/status`, { headers: { 'X-Device-Key': a } })).status, 401);
  assert.strictEqual((await fetch(`${base}/api/terminal/aparelho/status`, { headers: { 'X-Device-Key': b } })).status, 200);
});

test('transição: com o token antigo ligado o tablet antigo ainda funciona; desligado, não', async () => {
  const antigo = { 'X-Terminal-Token': process.env.TERMINAL_TOKEN };
  assert.strictEqual((await fetch(`${base}/api/terminal/aparelho/status`, { headers: antigo })).status, 200);
  process.env.TERMINAL_TOKEN_LEGADO_ATIVO = '0';
  try {
    assert.strictEqual((await fetch(`${base}/api/terminal/aparelho/status`, { headers: antigo })).status, 401);
    // rotas do AGENTE da catraca continuam com o token (agora secreto), sem depender do pareamento
    const agente = await fetch(`${base}/api/terminal/biometria-catraca-horario`, { headers: antigo });
    assert.notStrictEqual(agente.status, 401, 'o agente da catraca não pode perder acesso');
    const semToken = await fetch(`${base}/api/terminal/biometria-catraca-horario`);
    assert.strictEqual(semToken.status, 401);
  } finally { delete process.env.TERMINAL_TOKEN_LEGADO_ATIVO; }
});

test('stream do totem: abre com código de uso único e recusa o token na URL com o legado desligado', async () => {
  const chave = await novoAparelho('Stream');
  const { ticket } = await (await post('/eventos/ticket', {}, { 'X-Device-Key': chave })).json();
  async function abrir(q) {
    const ctrl = new AbortController();
    const r = await fetch(`${base}/api/terminal/eventos/stream?${q}`, { signal: ctrl.signal });
    const s = r.status; ctrl.abort(); return s;
  }
  assert.strictEqual(await abrir(`ticket=${ticket}`), 200);
  assert.strictEqual(await abrir(`ticket=${ticket}`), 401, 'código de uso único');
  process.env.TERMINAL_TOKEN_LEGADO_ATIVO = '0';
  try { assert.strictEqual(await abrir(`token=${process.env.TERMINAL_TOKEN}`), 401); } finally { delete process.env.TERMINAL_TOKEN_LEGADO_ATIVO; }
  // um código do totem não abre o stream do painel do administrador
  const { ticket: t2 } = await (await post('/eventos/ticket', {}, { 'X-Device-Key': chave })).json();
  const ctrl = new AbortController();
  const r = await fetch(`${base}/api/terminal/admin/eventos/stream?ticket=${t2}`, { signal: ctrl.signal });
  assert.strictEqual(r.status, 403); ctrl.abort();
});

test('sem banco o aparelho já conhecido continua valendo (PC do totem sem internet)', async () => {
  const chave = await novoAparelho('Offline');
  assert.ok(await aparelhos.validarChave(chave));
  // força a reconferência e derruba o acesso ao banco
  const antes = db.execute;
  const real = Date.now;
  Date.now = () => real() + aparelhos.REVALIDAR_APOS_MS + 1000;
  db.execute = async () => { throw new Error('banco fora do ar'); };
  try {
    assert.ok(await aparelhos.validarChave(chave), 'aparelho conhecido segue válido sem banco');
    assert.strictEqual(await aparelhos.validarChave('f'.repeat(64)), null, 'chave desconhecida continua recusada');
  } finally { db.execute = antes; Date.now = real; }
});
