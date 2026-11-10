process.env.JWT_SECRET = 'teste';
process.env.DATABASE_URL = 'file:./teste-webhook.db';
delete process.env.DATABASE_AUTH_TOKEN;
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const router = require('../src/routes/pagamentos.routes');
const verificar = router.verificarAssinaturaMercadoPago;

function req({ secret, dataId, requestId, assinarComRequestId = true, segredoAssinatura = secret }) {
  const ts = '1731200000';
  const id = /^[a-zA-Z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};${assinarComRequestId && requestId ? `request-id:${requestId};` : ''}ts:${ts};`;
  const v1 = crypto.createHmac('sha256', segredoAssinatura).update(manifest).digest('hex');
  return { headers: { 'x-signature': `ts=${ts},v1=${v1}`, ...(requestId ? { 'x-request-id': requestId } : {}) }, query: { 'data.id': dataId }, body: {} };
}

test('webhook MP: aceita assinatura válida, inclusive com segredo com espaços/aspas e id alfanumérico', () => {
  process.env.MERCADOPAGO_WEBHOOK_SECRET = '  "segredo123"\n';
  assert.strictEqual(verificar(req({ secret: 'segredo123', dataId: '123456', requestId: 'abc' })).valido, true);
  assert.strictEqual(verificar(req({ secret: 'segredo123', dataId: 'ABCdef9', requestId: 'abc' })).valido, true);
});

test('webhook MP: aceita quando o proxy troca o x-request-id', () => {
  process.env.MERCADOPAGO_WEBHOOK_SECRET = 'segredo123';
  const r = req({ secret: 'segredo123', dataId: '999', requestId: 'original', assinarComRequestId: false });
  r.headers['x-request-id'] = 'reescrito-pelo-proxy';
  assert.strictEqual(verificar(r).valido, true);
});

test('webhook MP: rejeita segredo errado e explica no log', () => {
  process.env.MERCADOPAGO_WEBHOOK_SECRET = 'segredo123';
  const r = verificar(req({ secret: 'segredo123', segredoAssinatura: 'outro', dataId: '1', requestId: 'x' }));
  assert.strictEqual(r.valido, false);
  assert.match(r.aviso, /Diagnóstico/);
});

test('webhook MP: aceita quando o request id original chega em outro cabeçalho', () => {
  process.env.MERCADOPAGO_WEBHOOK_SECRET = 'segredo123';
  const r = req({ secret: 'segredo123', dataId: '555', requestId: 'id-original-do-mp' });
  r.headers = { 'x-signature': r.headers['x-signature'], 'x-request-id': 'trocado-pelo-proxy', 'x-original-request-id': 'id-original-do-mp' };
  assert.strictEqual(verificar(r).valido, true);
});
