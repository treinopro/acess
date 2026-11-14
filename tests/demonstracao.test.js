// Demonstração em vídeo no portal (playlist do YouTube): quem pode ver.
// Banco local descartável, sem rede. Rodar: node --test tests/demonstracao.test.js
process.env.DATABASE_URL = 'file:./teste-demonstracao.db';
delete process.env.DATABASE_AUTH_TOKEN;
process.env.JWT_SECRET = 'segredo-de-teste';

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
  env: { ...process.env, DATABASE_AUTH_TOKEN: '' },
  stdio: 'pipe',
});

const express = require('express');
const db = require('../src/db/client');
const { assinarToken } = require('../src/utils/jwt');
const portalRoutes = require('../src/routes/portal.routes');
const { router: configRoutes } = require('../src/routes/config.routes');

let servidor;
let base;
const PLAYLIST = 'PLabcdefghijklmnop123';
const tokenAdmin = () => assinarToken({ id: 'u1', papel: 'admin' });

async function chamar(metodo, url, corpo, token) {
  const r = await fetch(base + url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, json: await r.json() };
}
const SENHAS = { '11111111111': '1234', '22222222222': '5678' };
const demo = (cpf) => chamar('GET', `/api/portal/demonstracao?cpf=${cpf}&senha=${SENHAS[cpf]}`);
const salvar = (corpo) => chamar('PUT', '/api/config/demo-videos', corpo, tokenAdmin());

before(async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, cpf, biometria_id, categoria, portal_senha_revelada) VALUES ('prof', 'Prof Teste', '11111111111', '1234', 'professor', 1)` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, cpf, biometria_id, categoria, portal_senha_revelada) VALUES ('alu', 'Aluno Teste', '22222222222', '5678', 'aluno', 1)` });
  const app = express();
  app.use(express.json());
  app.use('/api/portal', portalRoutes);
  app.use('/api/config', configRoutes);
  app.use((err, req, res, next) => res.status(500).json({ erro: err.message })); // eslint-disable-line no-unused-vars
  await new Promise((ok) => { servidor = http.createServer(app).listen(0, ok); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => { servidor.close(); limparBanco(); });

test('sem playlist configurada, ninguém vê (nem professor)', async () => {
  const r = await demo('11111111111');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { disponivel: false });
});

test('admin salva o link completo e o servidor guarda só o ID', async () => {
  const r = await salvar({ demo_videos_playlist: `https://www.youtube.com/playlist?list=${PLAYLIST}&si=xyz` });
  assert.strictEqual(r.status, 200);
  const cfg = await chamar('GET', '/api/config/demo-videos', null, tokenAdmin());
  assert.strictEqual(cfg.json.playlist, PLAYLIST);
  assert.strictEqual(cfg.json.visibilidade, 'professores'); // padrão = modo teste
});

test('link inválido é recusado', async () => {
  const r = await salvar({ demo_videos_playlist: 'https://www.youtube.com/watch?v=abc' });
  assert.strictEqual(r.status, 400);
});

test('modo teste: professor recebe a playlist, aluno comum NÃO', async () => {
  const prof = await demo('11111111111');
  assert.strictEqual(prof.json.disponivel, true);
  assert.strictEqual(prof.json.playlist_id, PLAYLIST);
  assert.strictEqual(prof.json.modo_teste, true);
  assert.strictEqual(prof.json.repetir, true);

  const aluno = await demo('22222222222');
  assert.deepStrictEqual(aluno.json, { disponivel: false });
  assert.ok(!JSON.stringify(aluno.json).includes(PLAYLIST));
});

test('senha errada continua barrada', async () => {
  const r = await chamar('GET', '/api/portal/demonstracao?cpf=11111111111&senha=errada');
  assert.strictEqual(r.status, 401);
});

test('GET /api/config público não vaza a playlist', async () => {
  const r = await chamar('GET', '/api/config');
  assert.ok(!JSON.stringify(r.json).includes(PLAYLIST));
  assert.strictEqual(r.json.demo_videos_playlist, undefined);
});

test('GET /api/config público só devolve chaves de marca/menu (não vaza caixa nem e-mail do backup)', async () => {
  for (const [chave, valor] of [['saldo_inicial_centavos', '1234500'], ['backup_email_destino', 'dono@exemplo.com'], ['whatsapp_contato', '5582999999999'], ['nome_app', 'Minha Academia']]) {
    await db.execute({ sql: 'INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor', args: [chave, valor] });
  }
  const r = await chamar('GET', '/api/config');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.saldo_inicial_centavos, undefined);
  assert.strictEqual(r.json.backup_email_destino, undefined);
  assert.ok(!JSON.stringify(r.json).includes('dono@exemplo.com'));
  assert.strictEqual(r.json.whatsapp_contato, '5582999999999'); // o portal precisa dessa
  assert.strictEqual(r.json.nome_app, 'Minha Academia');
  assert.ok(Array.isArray(r.json.menu_ordem));
});

test('visibilidade "todos" libera o aluno; "desligado" bloqueia até o professor', async () => {
  await salvar({ demo_videos_visibilidade: 'todos', demo_videos_repetir: false });
  const aluno = await demo('22222222222');
  assert.strictEqual(aluno.json.disponivel, true);
  assert.strictEqual(aluno.json.modo_teste, false);
  assert.strictEqual(aluno.json.repetir, false);

  await salvar({ demo_videos_visibilidade: 'desligado' });
  assert.deepStrictEqual((await demo('11111111111')).json, { disponivel: false });
});

test('só admin altera a configuração', async () => {
  const r = await chamar('PUT', '/api/config/demo-videos', { demo_videos_visibilidade: 'todos' }, assinarToken({ id: 'u2', papel: 'professor' }));
  assert.strictEqual(r.status, 403);
  const sem = await chamar('PUT', '/api/config/demo-videos', { demo_videos_visibilidade: 'todos' });
  assert.strictEqual(sem.status, 401);
});
