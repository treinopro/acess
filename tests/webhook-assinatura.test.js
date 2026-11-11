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
  assert.match(r.aviso, /DADOS PARA O SUPORTE/);
});

test('webhook MP: aceita quando o request id original chega em outro cabeçalho', () => {
  process.env.MERCADOPAGO_WEBHOOK_SECRET = 'segredo123';
  const r = req({ secret: 'segredo123', dataId: '555', requestId: 'id-original-do-mp' });
  r.headers = { 'x-signature': r.headers['x-signature'], 'x-request-id': 'trocado-pelo-proxy', 'x-original-request-id': 'id-original-do-mp' };
  assert.strictEqual(verificar(r).valido, true);
});

test('webhook MP: aceita quando o x-signature traz mais de um v1 (qualquer um que case)', () => {
  process.env.MERCADOPAGO_WEBHOOK_SECRET = 'segredo123';
  const ok = req({ secret: 'segredo123', dataId: '777', requestId: 'rid-1' });
  const v1ok = /v1=([0-9a-f]+)/.exec(ok.headers['x-signature'])[1];
  const ts = /ts=(\d+)/.exec(ok.headers['x-signature'])[1];
  // v1 correto primeiro e um inválido depois (o código antigo guardava só o último)
  ok.headers['x-signature'] = `ts=${ts},v1=${v1ok},v1=${'0'.repeat(64)}`;
  assert.strictEqual(verificar(ok).valido, true);
  // v1 inválido primeiro e o correto depois
  ok.headers['x-signature'] = `ts=${ts},v1=${'0'.repeat(64)},v1=${v1ok}`;
  assert.strictEqual(verificar(ok).valido, true);
  // ts duplicado (headers combinados por proxy)
  ok.headers['x-signature'] = `ts=${ts},v1=${v1ok}, ts=${ts},v1=${v1ok}`;
  assert.strictEqual(verificar(ok).valido, true);
  // nenhum v1 correto: rejeita e mostra o cabeçalho bruto
  const ruim = verificar({ ...ok, headers: { ...ok.headers, 'x-signature': `ts=${ts},v1=${'1'.repeat(64)}` } });
  assert.strictEqual(ruim.valido, false);
  assert.match(ruim.aviso, /x-signature="ts=/);
});

test('webhook MP: aceita vários segredos (um por aplicação) e rejeita se nenhum bater', () => {
  const appA = 'segredoDaAplicacaoA', appB = 'segredoDaAplicacaoB';
  process.env.MERCADOPAGO_WEBHOOK_SECRET = `${appA}, "${appB}"`; // vírgula + aspas colados no painel do host
  assert.strictEqual(verificar(req({ secret: appB, dataId: '321', requestId: 'r1' })).valido, true);
  assert.strictEqual(verificar(req({ secret: appA, dataId: '321', requestId: 'r1' })).valido, true);
  process.env.MERCADOPAGO_WEBHOOK_SECRET = `${appA}\n${appB}`; // uma por linha
  assert.strictEqual(verificar(req({ secret: appB, dataId: '322', requestId: 'r2' })).valido, true);
  const r = req({ secret: 'outraAplicacao', dataId: '321', requestId: 'r1' });
  r.originalUrl = '/api/pagamentos/webhook/mercadopago?data.id=321&type=payment';
  r.body = { application_id: '688969576765420', user_id: '56069909', live_mode: true, type: 'payment' };
  const ruim = verificar(r);
  assert.strictEqual(ruim.valido, false);
  assert.match(ruim.aviso, /application_id=688969576765420/);
  assert.match(ruim.aviso, /Segredos configurados \(2\)/);
  assert.ok(!ruim.aviso.includes(appA) && !ruim.aviso.includes(appB)); // nunca imprime o segredo inteiro
});
