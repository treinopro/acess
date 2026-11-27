// "Acessos ao vivo": o token de login do admin NÃO vai mais na URL; a conexão SSE abre com um código de uso único.
// Banco local descartável, sem rede. Rodar: node --test tests/sse-ticket.test.js
process.env.DATABASE_URL = 'file:./teste-sse-ticket.db';
delete process.env.DATABASE_AUTH_TOKEN;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste-jwt';
process.env.TERMINAL_TOKEN = 'terminal-teste';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const arquivoBanco = path.resolve(process.env.DATABASE_URL.replace('file:', ''));
function limparBanco() {
  for (const f of [arquivoBanco, `${arquivoBanco}-journal`, `${arquivoBanco}-wal`, `${arquivoBanco}-shm`]) { try { fs.unlinkSync(f); } catch (e) { /* ok */ } }
}
limparBanco();
require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'db', 'migrate.js')], {
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DATABASE_AUTH_TOKEN: '' },
  stdio: 'pipe',
});

const express = require('express');
const { assinarToken } = require('../src/utils/jwt');
const tickets = require('../src/services/ticketsSse.service');
let servidor; let base; let jwtAdmin; let jwtComum;

before(async () => {
  jwtAdmin = assinarToken({ id: 'u1', email: 'admin@teste.com', papel: 'admin' });
  jwtComum = assinarToken({ id: 'u2', email: 'rec@teste.com', papel: 'recepcao' });
  const app = express();
  app.use(express.json());
  app.use('/api/terminal', require('../src/routes/terminal.routes'));
  await new Promise((ok) => { servidor = http.createServer(app).listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => { servidor.closeAllConnections?.(); servidor.close(); limparBanco(); });

const pedirTicket = (jwt) => fetch(`${base}/api/terminal/admin/eventos/ticket`, { method: 'POST', headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });

// Abre o stream, lê só o status/cabeçalho e fecha.
async function abrirStream(query) {
  const ctrl = new AbortController();
  const r = await fetch(`${base}/api/terminal/admin/eventos/stream?${query}`, { signal: ctrl.signal });
  const info = { status: r.status, tipo: r.headers.get('content-type') };
  ctrl.abort();
  return info;
}

test('só administrador autenticado recebe um código', async () => {
  assert.strictEqual((await pedirTicket(null)).status, 401);
  assert.strictEqual((await pedirTicket(jwtComum)).status, 403);
  const r = await pedirTicket(jwtAdmin);
  assert.strictEqual(r.status, 200);
  assert.match((await r.json()).ticket, /^[0-9a-f]{48}$/);
});

test('o stream abre com o código e o código vale uma única vez', async () => {
  const { ticket } = await (await pedirTicket(jwtAdmin)).json();
  const a = await abrirStream(`ticket=${ticket}`);
  assert.strictEqual(a.status, 200);
  assert.match(a.tipo, /text\/event-stream/);
  const b = await abrirStream(`ticket=${ticket}`);
  assert.strictEqual(b.status, 401, 'o mesmo código não pode abrir uma segunda conexão');
});

test('o token de login na URL (formato antigo) NÃO abre mais o stream', async () => {
  assert.strictEqual((await abrirStream(`token=${encodeURIComponent(jwtAdmin)}`)).status, 401);
  assert.strictEqual((await abrirStream('')).status, 401);
  assert.strictEqual((await abrirStream('ticket=inventado')).status, 401);
});

test('código expirado é recusado', async () => {
  const real = Date.now;
  const ticket = tickets.emitir({ papel: 'admin' });
  Date.now = () => real() + tickets.VALIDADE_MS + 1000;
  try { assert.strictEqual(tickets.consumir(ticket), null); } finally { Date.now = real; }
});
