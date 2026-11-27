// Reconciliação de Pix aprovado no Mercado Pago que não constava no sistema. SEM rede e SEM tocar em produção:
// banco local descartável + Mercado Pago simulado. Rodar: node --test tests/reconciliar-pix.test.js
process.env.DATABASE_URL = 'file:./teste-reconciliar-pix.db';
delete process.env.DATABASE_AUTH_TOKEN;
process.env.MERCADOPAGO_ACCESS_TOKEN = 'TESTE';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste-jwt';
delete process.env.MERCADOPAGO_WEBHOOK_SECRET;

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const mpPath = require.resolve('../src/services/payment/mercadopago.service');
const pedidos = {}; // id do pedido -> resposta simulada
require.cache[mpPath] = {
  id: mpPath, filename: mpPath, loaded: true,
  exports: {
    consultarOrder: async (id) => { if (!pedidos[id]) throw new Error('Erro ao consultar order no Mercado Pago (HTTP 404)'); return pedidos[id]; },
    criarOrderPix: async () => ({}), criarPreferencia: async () => ({}), criarPagamentoPix: async () => ({}),
    criarAssinaturaPendente: async () => ({}), consultarAssinatura: async () => ({}), cancelarAssinatura: async () => ({}),
    consultarPagamentoAutorizado: async () => ({}), listarCobrancasDaAssinatura: async () => [], buscarPagamentosPorReferencia: async () => [],
  },
};

const arquivoBanco = path.resolve(process.env.DATABASE_URL.replace('file:', ''));
function limparBanco() {
  for (const f of [arquivoBanco, `${arquivoBanco}-journal`, `${arquivoBanco}-wal`, `${arquivoBanco}-shm`]) { try { fs.unlinkSync(f); } catch (e) { /* ok */ } }
}
limparBanco();
require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'db', 'migrate.js')], {
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DATABASE_AUTH_TOKEN: '' },
  stdio: 'pipe',
});

const db = require('../src/db/client');
const job = require('../src/jobs/reconciliarPagamentosPix');

const aprovado = { status: 'processed', transactions: { payments: [{ status: 'approved' }] } };
const aguardando = { status: 'action_required', transactions: { payments: [{ status: 'action_required' }] } };

async function linhas(sql, args = []) { return (await db.execute({ sql, args })).rows; }

before(async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('a1', 'Aluno Teste', 'aluno@teste.com', '11122233344')` });
  await db.execute({ sql: `INSERT INTO planos (id, nome, tipo, valor_centavos) VALUES ('p1', 'Mensal', 'mensal', 6500)` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m1', 'a1', 'p1', '2026-11-01', 'ativa'), ('m2', 'a1', 'p1', '2026-11-01', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES
    ('c-a', 'a1', 'm1', 6500, 'atrasado', 'manual', 'Mensalidade A', '2026-11-10'),
    ('c-b', 'a1', 'm1', 6500, 'atrasado', 'manual', 'Mensalidade B', '2026-10-10')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, provedor_referencia, descricao, vencimento) VALUES
    ('c-cad', 'a1', 'm2', 6500, 'pendente', 'mercadopago', 'ORD-CAD', 'Matrícula - Mensal', '2026-11-27'),
    ('c-espera', 'a1', 'm1', 6500, 'pendente', 'mercadopago', 'ORD-ESPERA', 'Matrícula - Outra', '2026-11-27')` });
  // pagamento "pagar contas em aberto" ainda pendente no sistema, mas aprovado no MP
  await db.execute({ sql: `INSERT INTO pagamentos_totem (id, aluno_id, cobranca_ids, valor_centavos, provedor, provedor_referencia, liberar_acesso, status)
    VALUES ('pt-pendente', 'a1', '["c-a"]', 6500, 'mercadopago', 'ORD-PT1', 0, 'pendente')` });
  // pagamento já marcado 'pago' (primeira etapa), mas a conta ficou aberta (falha no meio)
  await db.execute({ sql: `INSERT INTO pagamentos_totem (id, aluno_id, cobranca_ids, valor_centavos, provedor, provedor_referencia, liberar_acesso, status)
    VALUES ('pt-meio', 'a1', '["c-b"]', 6500, 'mercadopago', 'ORD-PT2', 0, 'pago')` });
  pedidos['ORD-PT1'] = aprovado;
  pedidos['ORD-PT2'] = aprovado;
  pedidos['ORD-CAD'] = aprovado;
  pedidos['ORD-ESPERA'] = aguardando;
});

after(() => limparBanco());

test('Pix de "pagar contas" aprovado no MP é confirmado: conta paga e pagamento lançado', async () => {
  await job.rodar();
  assert.strictEqual((await linhas("SELECT status FROM cobrancas WHERE id = 'c-a'"))[0].status, 'pago');
  const pg = await linhas("SELECT valor_centavos, tipo FROM pagamentos_cobranca WHERE cobranca_id = 'c-a'");
  assert.strictEqual(pg.length, 1);
  assert.strictEqual(Number(pg[0].valor_centavos), 6500);
  assert.strictEqual(pg[0].tipo, 'pix');
});

test('pagamento já marcado "pago" mas com a conta em aberto é recuperado', async () => {
  assert.strictEqual((await linhas("SELECT status FROM cobrancas WHERE id = 'c-b'"))[0].status, 'pago');
  assert.strictEqual((await linhas("SELECT * FROM pagamentos_cobranca WHERE cobranca_id = 'c-b'")).length, 1);
});

test('Pix de matrícula/cadastro aprovado: cobrança paga, matrícula ativa e pagamento lançado', async () => {
  assert.strictEqual((await linhas("SELECT status FROM cobrancas WHERE id = 'c-cad'"))[0].status, 'pago');
  assert.strictEqual((await linhas("SELECT status FROM matriculas WHERE id = 'm2'"))[0].status, 'ativa');
  assert.strictEqual((await linhas("SELECT * FROM pagamentos_cobranca WHERE cobranca_id = 'c-cad'")).length, 1);
});

test('Pix ainda não pago no MP continua pendente', async () => {
  assert.strictEqual((await linhas("SELECT status FROM cobrancas WHERE id = 'c-espera'"))[0].status, 'pendente');
  assert.strictEqual((await linhas("SELECT * FROM pagamentos_cobranca WHERE cobranca_id = 'c-espera'")).length, 0);
});

test('rodar de novo não duplica nenhum lançamento (idempotente)', async () => {
  await job.rodar();
  await job.rodar();
  for (const id of ['c-a', 'c-b', 'c-cad']) {
    assert.strictEqual((await linhas('SELECT * FROM pagamentos_cobranca WHERE cobranca_id = ?', [id])).length, 1, id);
  }
});
