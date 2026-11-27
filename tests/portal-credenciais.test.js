// Credenciais do portal fora da URL: CPF/senha em cabeçalhos (X-Portal-Cpf / X-Portal-Senha), com a URL antiga
// (?cpf=&senha=) ainda aceita por compatibilidade. Banco local descartável, sem rede.
// Rodar: node --test tests/portal-credenciais.test.js
process.env.DATABASE_URL = 'file:./teste-portal-credenciais.db';
delete process.env.DATABASE_AUTH_TOKEN;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste-jwt';
process.env.MERCADOPAGO_ACCESS_TOKEN = 'TESTE';

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
const db = require('../src/db/client');
let servidor; let base;

before(async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, cpf, status, biometria_id, portal_senha_revelada) VALUES ('a1', 'Aluno Portal', '11122233344', 'ativo', '605', 1)` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, cpf, status, biometria_id, portal_senha_revelada) VALUES ('a2', 'Senha Especial', '55566677788', 'ativo', 'çã 7&=', 1)` });
  const app = express();
  app.use(express.json());
  app.use('/api/portal', require('../src/routes/portal.routes'));
  await new Promise((ok) => { servidor = http.createServer(app).listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => { servidor.close(); limparBanco(); });

const cab = (cpf, senha) => ({ 'X-Portal-Cpf': encodeURIComponent(cpf), 'X-Portal-Senha': encodeURIComponent(senha) });

test('CPF e senha em cabeçalhos autenticam (sem nada na URL)', async () => {
  const r = await fetch(`${base}/api/portal/aluno`, { headers: cab('111.222.333-44', '605') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).aluno_nome, 'Aluno Portal');
});

test('senha com acento e símbolos viaja certa pelo cabeçalho', async () => {
  const r = await fetch(`${base}/api/portal/aluno`, { headers: cab('55566677788', 'çã 7&=') });
  assert.strictEqual(r.status, 200);
});

test('senha errada no cabeçalho é recusada', async () => {
  const r = await fetch(`${base}/api/portal/aluno`, { headers: cab('11122233344', '999') });
  assert.strictEqual(r.status, 401);
});

test('formato antigo (?cpf=&senha=) continua aceito por compatibilidade', async () => {
  const r = await fetch(`${base}/api/portal/aluno?cpf=11122233344&senha=605`);
  assert.strictEqual(r.status, 200);
});

test('a resposta declara Vary nos cabeçalhos de credencial (evita cache cruzado entre alunos)', async () => {
  const r = await fetch(`${base}/api/portal/aluno`, { headers: cab('11122233344', '605') });
  const vary = (r.headers.get('vary') || '').toLowerCase();
  assert.ok(vary.includes('x-portal-cpf') && vary.includes('x-portal-senha'), vary);
});

test('outras rotas do portal também leem os cabeçalhos (treino e avaliações)', async () => {
  for (const rota of ['treino', 'avaliacoes', 'assinatura', 'banners', 'gamificacao']) {
    const r = await fetch(`${base}/api/portal/${rota}`, { headers: cab('11122233344', '605') });
    assert.notStrictEqual(r.status, 400, `${rota} ainda exige a URL`);
    assert.notStrictEqual(r.status, 401, `${rota} não reconheceu a senha do cabeçalho`);
  }
});
