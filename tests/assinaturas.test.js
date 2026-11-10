// Teste de ponta a ponta das assinaturas do Mercado Pago, SEM rede e SEM tocar
// em produção: banco local descartável + mercadopago.service simulado.
// Rodar: node --test tests/assinaturas.test.js
// O banco é SEMPRE um arquivo local descartável: a DATABASE_URL do ambiente/.env
// (que neste projeto pode apontar pro Turso de produção) é ignorada de propósito.
process.env.DATABASE_URL = 'file:./teste-assinaturas.db';
delete process.env.DATABASE_AUTH_TOKEN;
process.env.MERCADOPAGO_ASSINATURAS = '1';
process.env.MERCADOPAGO_ACCESS_TOKEN = 'TESTE';
delete process.env.MERCADOPAGO_WEBHOOK_SECRET;

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// --- Mercado Pago simulado (antes de carregar qualquer serviço que o importe) ---
const mpPath = require.resolve('../src/services/payment/mercadopago.service');
const chamadas = [];
const estadoMp = { parcelas: {}, assinaturas: {} };
let contadorMp = 0;
require.cache[mpPath] = {
  id: mpPath, filename: mpPath, loaded: true,
  exports: {
    criarAssinaturaPendente: async (p) => {
      chamadas.push(['criar', p]);
      const id = `PRE-${++contadorMp}`;
      estadoMp.assinaturas[id] = { id, status: 'pending' };
      return { id, init_point: `https://mp.test/subscriptions/checkout?preapproval_id=${id}` };
    },
    consultarAssinatura: async (id) => estadoMp.assinaturas[id],
    cancelarAssinatura: async (id) => { chamadas.push(['cancelar', id]); estadoMp.assinaturas[id].status = 'cancelled'; return estadoMp.assinaturas[id]; },
    consultarPagamentoAutorizado: async (id) => estadoMp.parcelas[id],
    listarCobrancasDaAssinatura: async (id) => (estadoMp.cobrancas?.[id] || []),
    consultarPagamento: async (id) => estadoMp.pagamentos?.[id],
    criarPreferencia: async () => ({}), criarPagamentoPix: async () => ({}), criarOrderPix: async () => ({}), consultarOrder: async () => ({}),
  },
};

// Banco novo + migração ANTES de abrir a conexão deste processo. migrate.js roda ao
// ser executado (e dá process.exit), então vai em processo à parte.
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
const assinaturas = require('../src/services/assinaturas.service');

async function seed() {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('a1', 'Aluno Teste', 'aluno@teste.com', '11122233344')` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, cpf) VALUES ('a2', 'Sem Email', '55566677788')` });
  await db.execute({ sql: `INSERT INTO planos (id, nome, tipo, valor_centavos) VALUES ('p1', 'Mensal', 'mensal', 9900), ('p2', 'Avulso', 'avulso', 1000)` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio) VALUES ('m1', 'a1', 'p1', '2026-11-01'), ('m2', 'a2', 'p1', '2026-11-01'), ('m3', 'a1', 'p2', '2026-11-01')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, vencimento) VALUES
    ('c-nov', 'a1', 'm1', 9900, 'pendente', 'recorrencia', '2026-11-10'),
    ('c-dez', 'a1', 'm1', 9900, 'pendente', 'recorrencia', '2026-12-10')` });
}

before(async () => {
  await seed();
});

after(() => limparBanco());

test('criarAssinatura: manda valor/ciclo certos ao MP e devolve o link do cartão', async () => {
  const r = await assinaturas.criarAssinatura({ matriculaId: 'm1', baseUrl: 'https://academia.test' });
  assert.match(r.init_point, /preapproval_id=PRE-1/);
  const [, payload] = chamadas.find((c) => c[0] === 'criar');
  assert.strictEqual(payload.valorCentavos, 9900);
  assert.strictEqual(payload.frequenciaMeses, 1);
  assert.strictEqual(payload.emailPagador, 'aluno@teste.com');
  assert.strictEqual(payload.referenciaExterna, r.id); // id local = external_reference
});

test('criarAssinatura: recusa duplicada, plano avulso e aluno sem e-mail', async () => {
  await assert.rejects(assinaturas.criarAssinatura({ matriculaId: 'm1' }), /já tem uma assinatura/);
  await assert.rejects(assinaturas.criarAssinatura({ matriculaId: 'm3' }), /não é recorrente/);
  await assert.rejects(assinaturas.criarAssinatura({ matriculaId: 'm2' }), /e-mail/);
});

test('webhook de parcela aprovada baixa a conta MAIS ANTIGA e é idempotente', async () => {
  estadoMp.parcelas['AP-1'] = { preapproval_id: 'PRE-1', transaction_amount: 99, payment: { id: 777, status: 'approved' } };
  const r1 = await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: 'AP-1' });
  assert.deepStrictEqual(r1, { alunoId: 'a1' });
  let nov = (await db.execute({ sql: `SELECT status, metodo_pagamento, pago_em FROM cobrancas WHERE id='c-nov'` })).rows[0];
  let dez = (await db.execute({ sql: `SELECT status FROM cobrancas WHERE id='c-dez'` })).rows[0];
  assert.strictEqual(nov.status, 'pago');
  assert.strictEqual(nov.metodo_pagamento, 'credit_card');
  assert.ok(nov.pago_em);
  assert.strictEqual(dez.status, 'pendente');

  // MP reenvia o mesmo webhook: não pode baixar a de dezembro.
  const r2 = await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: 'AP-1' });
  assert.strictEqual(r2, null);
  dez = (await db.execute({ sql: `SELECT status FROM cobrancas WHERE id='c-dez'` })).rows[0];
  assert.strictEqual(dez.status, 'pendente');

  const sub = (await db.execute({ sql: `SELECT status FROM assinaturas_mp WHERE preapproval_id='PRE-1'` })).rows[0];
  assert.strictEqual(sub.status, 'authorized');
});

test('parcela recusada não baixa nada', async () => {
  estadoMp.parcelas['AP-2'] = { preapproval_id: 'PRE-1', payment: { id: 778, status: 'rejected' } };
  assert.strictEqual(await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: 'AP-2' }), null);
  const dez = (await db.execute({ sql: `SELECT status FROM cobrancas WHERE id='c-dez'` })).rows[0];
  assert.strictEqual(dez.status, 'pendente');
});

test('parcela aprovada sem conta em aberto fica registrada como sem_cobranca', async () => {
  await db.execute({ sql: `UPDATE cobrancas SET status='pago' WHERE id='c-dez'` });
  estadoMp.parcelas['AP-3'] = { preapproval_id: 'PRE-1', transaction_amount: 99, payment: { id: 779, status: 'approved' } };
  assert.strictEqual(await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: 'AP-3' }), null);
  const reg = (await db.execute({ sql: `SELECT baixa, cobranca_id FROM assinaturas_mp_pagamentos WHERE payment_id='779'` })).rows[0];
  assert.strictEqual(reg.baixa, 'sem_cobranca');
  assert.strictEqual(reg.cobranca_id, null);
});

test('tópico payment com external_reference da assinatura também baixa (e só uma vez)', async () => {
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, vencimento) VALUES ('c-jan', 'a1', 'm1', 9900, 'pendente', 'recorrencia', '2027-01-10')` });
  const idLocal = (await db.execute({ sql: `SELECT id FROM assinaturas_mp WHERE preapproval_id='PRE-1'` })).rows[0].id;
  const pagamento = { id: 900, status: 'approved', external_reference: idLocal, transaction_amount: 99, payment_type_id: 'credit_card' };
  assert.deepStrictEqual(await assinaturas.processarPagamentoAprovado(pagamento), { alunoId: 'a1' });
  assert.strictEqual(await assinaturas.processarPagamentoAprovado(pagamento), null);
  const jan = (await db.execute({ sql: `SELECT status FROM cobrancas WHERE id='c-jan'` })).rows[0];
  assert.strictEqual(jan.status, 'pago');
});

test('subscription_preapproval atualiza o status; cancelar chama o MP', async () => {
  estadoMp.assinaturas['PRE-1'].status = 'paused';
  await assinaturas.processarEvento({ type: 'subscription_preapproval', dataId: 'PRE-1' });
  let sub = (await db.execute({ sql: `SELECT id, status FROM assinaturas_mp WHERE preapproval_id='PRE-1'` })).rows[0];
  assert.strictEqual(sub.status, 'paused');
  await assinaturas.cancelar({ assinaturaId: sub.id });
  sub = (await db.execute({ sql: `SELECT status FROM assinaturas_mp WHERE preapproval_id='PRE-1'` })).rows[0];
  assert.strictEqual(sub.status, 'cancelled');
  assert.ok(chamadas.some((c) => c[0] === 'cancelar' && c[1] === 'PRE-1'));
});

test('com a flag desligada nada é processado', async () => {
  process.env.MERCADOPAGO_ASSINATURAS = '0';
  assert.strictEqual(await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: 'AP-1' }), null);
  await assert.rejects(assinaturas.criarAssinatura({ matriculaId: 'm1' }), /desligadas/);
  process.env.MERCADOPAGO_ASSINATURAS = '1';
});

// ── Página de oferta, WhatsApp e portal do aluno ────────────────────────────
async function novoAlunoComMatricula(id, { telefone = null, plano = 'p1' } = {}) {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf, telefone) VALUES (?, ?, ?, ?, ?)`, args: [id, `JOÃO ${id}`, `${id}@teste.com`, `cpf-${id}`, telefone] });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio) VALUES (?, ?, ?, '2026-11-01')`, args: [`m-${id}`, id, plano] });
}

test('criarAssinatura: monta link da oferta, back_url https e link de WhatsApp', async () => {
  await novoAlunoComMatricula('w1', { telefone: '(11) 98888-7777' });
  const r = await assinaturas.criarAssinatura({ matriculaId: 'm-w1', baseUrl: 'https://academia.test' });
  assert.strictEqual(r.oferta_url, `https://academia.test/assinar/${r.id}`);
  assert.match(r.whatsapp_link, /^https:\/\/wa\.me\/5511988887777\?text=/);
  assert.ok(decodeURIComponent(r.whatsapp_link).includes(r.oferta_url));
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.strictEqual(payload.urlRetorno, `https://academia.test/assinar/${r.id}?retorno=1`);
});

test('criarAssinatura: em http (localhost) não manda back_url inválido ao MP', async () => {
  await novoAlunoComMatricula('w2');
  await assinaturas.criarAssinatura({ matriculaId: 'm-w2', baseUrl: 'http://localhost:3000' });
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.strictEqual(payload.urlRetorno, 'https://www.mercadopago.com.br');
});

test('ofertaPublica: dados da página, sem vazar e-mail/CPF/telefone', async () => {
  const sub = (await db.execute({ sql: `SELECT id FROM assinaturas_mp WHERE matricula_id='m-w1'` })).rows[0];
  const o = await assinaturas.ofertaPublica(sub.id);
  assert.strictEqual(o.aluno, 'João');
  assert.strictEqual(o.plano, 'Mensal');
  assert.strictEqual(o.valor_centavos, 9900);
  assert.strictEqual(o.status, 'pending');
  assert.match(o.init_point, /mp\.test/);
  assert.ok(o.beneficios.length >= 3);
  const txt = JSON.stringify(o);
  assert.ok(!txt.includes('@teste.com') && !txt.includes('cpf-w1') && !txt.includes('98888'));
  assert.strictEqual(await assinaturas.ofertaPublica('id-inexistente'), null);
});

test('ofertaPublica: benefícios personalizados vêm da configuração', async () => {
  await db.execute({ sql: `INSERT INTO configuracoes (chave, valor) VALUES ('assinatura_beneficios', 'Primeira avaliação grátis\n\n  Camiseta de brinde  ')` });
  const sub = (await db.execute({ sql: `SELECT id FROM assinaturas_mp WHERE matricula_id='m-w1'` })).rows[0];
  const o = await assinaturas.ofertaPublica(sub.id);
  assert.deepStrictEqual(o.beneficios, ['Primeira avaliação grátis', 'Camiseta de brinde']);
  await db.execute({ sql: `DELETE FROM configuracoes WHERE chave='assinatura_beneficios'` });
});

test('oferta de assinatura cancelada não expõe o link de pagamento', async () => {
  const sub = (await db.execute({ sql: `SELECT id FROM assinaturas_mp WHERE matricula_id='m-w2'` })).rows[0];
  await assinaturas.cancelar({ assinaturaId: sub.id });
  const o = await assinaturas.ofertaPublica(sub.id);
  assert.strictEqual(o.status, 'cancelled');
  assert.strictEqual(o.init_point, null);
});

test('portal: card disponível, reaproveita a assinatura pendente e some depois de ativa', async () => {
  await novoAlunoComMatricula('p1x');
  const base = 'https://academia.test';
  let d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'p1x', baseUrl: base });
  assert.strictEqual(d.disponivel, true);
  assert.strictEqual(d.assinatura_pendente, null);

  const r1 = await assinaturas.obterOuCriarParaAluno({ alunoId: 'p1x', baseUrl: base, modalidade: 'mensal_livre' });
  const r2 = await assinaturas.obterOuCriarParaAluno({ alunoId: 'p1x', baseUrl: base, modalidade: 'mensal_livre' });
  assert.strictEqual(r1.oferta_url, r2.oferta_url);   // não cria assinatura duplicada
  const qtd = (await db.execute({ sql: `SELECT COUNT(*) n FROM assinaturas_mp WHERE aluno_id='p1x'` })).rows[0].n;
  assert.strictEqual(Number(qtd), 1);

  await db.execute({ sql: `UPDATE assinaturas_mp SET status='authorized' WHERE aluno_id='p1x'` });
  d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'p1x', baseUrl: base });
  assert.strictEqual(d.disponivel, false);
  await assert.rejects(assinaturas.obterOuCriarParaAluno({ alunoId: 'p1x', baseUrl: base, modalidade: 'mensal_livre' }), /não está disponível/);
});

test('cadastro novo: recorrência deixa matrícula pendente até a primeira parcela aprovada', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('novo-rec', 'Aluno Novo', 'novo@teste.com', '99988877766')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-novo-rec', 'novo-rec', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-novo-rec', 'novo-rec', 'm-novo-rec', 9900, 'pendente', 'mercadopago', 'Matrícula - Mensal', '2026-11-10')` });

  const criada = await assinaturas.obterOuCriarParaNovoCadastro({
    alunoId: 'novo-rec', matriculaId: 'm-novo-rec', baseUrl: 'https://academia.test', modalidade: '12_meses',
  });
  assert.match(criada.oferta_url, /\/assinar\//);
  let matricula = (await db.execute({ sql: `SELECT status FROM matriculas WHERE id='m-novo-rec'` })).rows[0];
  assert.strictEqual(matricula.status, 'pendente');
  let cobranca = (await db.execute({ sql: `SELECT valor_centavos, provedor, status FROM cobrancas WHERE id='c-novo-rec'` })).rows[0];
  assert.strictEqual(cobranca.valor_centavos, 6500);
  assert.strictEqual(cobranca.provedor, 'mercadopago');
  assert.strictEqual(cobranca.status, 'pendente');

  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  const preapprovalId = payload.referenciaExterna;
  const assinatura = (await db.execute({ sql: `SELECT preapproval_id FROM assinaturas_mp WHERE id=?`, args: [preapprovalId] })).rows[0];
  estadoMp.parcelas['AP-NOVO-1'] = { preapproval_id: assinatura.preapproval_id, transaction_amount: 65, payment: { id: 991, status: 'approved' } };
  const baixa = await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: 'AP-NOVO-1' });
  assert.deepStrictEqual(baixa, { alunoId: 'novo-rec' });
  matricula = (await db.execute({ sql: `SELECT status, data_fim FROM matriculas WHERE id='m-novo-rec'` })).rows[0];
  assert.strictEqual(matricula.status, 'ativa');
  cobranca = (await db.execute({ sql: `SELECT status FROM cobrancas WHERE id='c-novo-rec'` })).rows[0];
  assert.strictEqual(cobranca.status, 'pago');
});

test('cadastro novo: cancelar checkout recorrente restaura o valor tradicional', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('novo-cancel', 'Aluno Cancel', 'cancel@teste.com', '99988877755')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-novo-cancel', 'novo-cancel', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-novo-cancel', 'novo-cancel', 'm-novo-cancel', 9900, 'pendente', 'mercadopago', 'Matrícula - Mensal', '2026-11-20')` });
  const criada = await assinaturas.obterOuCriarParaNovoCadastro({ alunoId:'novo-cancel', matriculaId:'m-novo-cancel', baseUrl:'https://academia.test', modalidade:'mensal_livre' });
  const id = (await db.execute({ sql:`SELECT id FROM assinaturas_mp WHERE matricula_id='m-novo-cancel'` })).rows[0].id;
  await assinaturas.cancelar({ assinaturaId:id });
  const c = (await db.execute({ sql:`SELECT valor_centavos, status, provedor, vencimento FROM cobrancas WHERE id='c-novo-cancel'` })).rows[0];
  assert.strictEqual(c.valor_centavos,9900);
  assert.strictEqual(c.status,'pendente');
  assert.strictEqual(c.provedor,'mercadopago');
  assert.strictEqual(c.vencimento,'2026-11-20');
  const m = (await db.execute({ sql:`SELECT status FROM matriculas WHERE id='m-novo-cancel'` })).rows[0];
  assert.strictEqual(m.status,'pendente');
});

test('portal: plano avulso e recurso desligado não mostram o card', async () => {
  await novoAlunoComMatricula('p2x', { plano: 'p2' });
  assert.strictEqual((await assinaturas.disponibilidadeParaAluno({ alunoId: 'p2x', baseUrl: 'https://academia.test' })).disponivel, false);
  await novoAlunoComMatricula('p3x');
  process.env.MERCADOPAGO_ASSINATURAS = '0';
  assert.strictEqual((await assinaturas.disponibilidadeParaAluno({ alunoId: 'p3x', baseUrl: 'https://academia.test' })).disponivel, false);
  process.env.MERCADOPAGO_ASSINATURAS = '1';
});

test('baseUrlDaRequisicao: usa PUBLIC_BASE_URL, senão o host do proxy', () => {
  const req = { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.academia.com' }, protocol: 'http', get: () => 'localhost:3000' };
  assert.strictEqual(assinaturas.baseUrlDaRequisicao(req), 'https://app.academia.com');
  process.env.PUBLIC_BASE_URL = 'https://fixo.academia.com/';
  assert.strictEqual(assinaturas.baseUrlDaRequisicao(req), 'https://fixo.academia.com');
  delete process.env.PUBLIC_BASE_URL;
});

test('portal: apresenta as duas modalidades e preço fixo correto', async () => {
  await novoAlunoComMatricula('opcoes1');
  const d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'opcoes1', baseUrl: 'https://academia.test' });
  assert.strictEqual(d.disponivel, true);
  assert.deepStrictEqual(d.opcoes.map((x) => [x.modalidade, x.valor_centavos, x.limite_cobrancas]), [
    ['12_meses', 6500, 12],
    ['mensal_livre', 7000, null],
  ]);
});

test('migração: reaproveita mensalidade em aberto sem criar competência duplicada', async () => {
  await novoAlunoComMatricula('migra-aberta');
  const hoje = new Date().toISOString().slice(0, 10);
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, vencimento) VALUES ('c-migra-aberta', 'migra-aberta', 'm-migra-aberta', 9900, 'pendente', 'recorrencia', ?)`, args: [hoje] });
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'migra-aberta', baseUrl: 'https://academia.test', modalidade: '12_meses' });
  const conta = (await db.execute({ sql: `SELECT valor_centavos, status FROM cobrancas WHERE id='c-migra-aberta'` })).rows[0];
  assert.strictEqual(Number(conta.valor_centavos), 6500);
  assert.strictEqual(conta.status, 'pendente');
  const qtd = (await db.execute({ sql: `SELECT COUNT(*) n FROM cobrancas WHERE matricula_id='m-migra-aberta' AND vencimento=? AND status IN ('pendente','atrasado','pago')`, args: [hoje] })).rows[0].n;
  assert.strictEqual(Number(qtd), 1);
});

test('migração: se a competência atual já está quitada, começa no próximo mês', async () => {
  await novoAlunoComMatricula('migra-paga');
  const hoje = new Date().toISOString().slice(0, 10);
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, vencimento) VALUES ('c-migra-paga', 'migra-paga', 'm-migra-paga', 9900, 'pago', 'recorrencia', ?)`, args: [hoje] });
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'migra-paga', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const proximo = (await db.execute({ sql: `SELECT valor_centavos, vencimento FROM cobrancas WHERE matricula_id='m-migra-paga' AND status='pendente'` })).rows[0];
  const [ano, mes, dia] = hoje.split('-').map(Number);
  const alvo = new Date(Date.UTC(ano, mes, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const esperado = `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth()+1).padStart(2,'0')}-${String(Math.min(dia,ultimo)).padStart(2,'0')}`;
  assert.strictEqual(proximo.vencimento, esperado);
  assert.strictEqual(Number(proximo.valor_centavos), 7000);
});

test('recorrência de 12 meses encerra após 12 pagamentos aprovados', async () => {
  await novoAlunoComMatricula('doze-ciclos');
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'doze-ciclos', baseUrl: 'https://academia.test', modalidade: '12_meses' });
  const sub = (await db.execute({ sql: `SELECT * FROM assinaturas_mp WHERE aluno_id='doze-ciclos'` })).rows[0];
  for (let i = 1; i <= 12; i += 1) {
    const idEvento = `AP-12-${i}`;
    estadoMp.parcelas[idEvento] = {
      preapproval_id: sub.preapproval_id,
      transaction_amount: 65,
      payment: { id: `PAY-12-${i}`, status: 'approved' },
    };
    const resultado = await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: idEvento });
    assert.deepStrictEqual(resultado, { alunoId: 'doze-ciclos' });
  }
  const final = (await db.execute({ sql: `SELECT status, limite_cobrancas, cobrancas_processadas FROM assinaturas_mp WHERE id=?`, args: [sub.id] })).rows[0];
  assert.strictEqual(final.status, 'completed');
  assert.strictEqual(Number(final.limite_cobrancas), 12);
  assert.strictEqual(Number(final.cobrancas_processadas), 12);
  const abertas = (await db.execute({ sql: `SELECT COUNT(*) n FROM cobrancas WHERE matricula_id=? AND status IN ('pendente','atrasado')`, args: [sub.matricula_id] })).rows[0].n;
  assert.strictEqual(Number(abertas), 0);
  assert.ok(chamadas.some((x) => x[0] === 'cancelar' && x[1] === sub.preapproval_id));
});

// ── Desconto para quem assina + edição da oferta ────────────────────────────
const dinheiro = (r) => Number(r.valor_centavos);

test('oferta: salvar normaliza, trava desconto inválido e lê de volta', async () => {
  const salva = await assinaturas.salvarOferta({
    selo: '  Só hoje  ', titulo: 'Oi {nome}, assine *já*', subtitulo: '', beneficios: ['A', '', '  B  '],
    botao: 'Quero!', microtexto: 'seguro', faq: [{ p: 'Pergunta?', r: 'Resposta.' }, { p: '', r: 'sem pergunta' }],
    desconto: { ativo: true, tipo: 'percentual', percentual: 10, valor_centavos: 0 },
  });
  assert.strictEqual(salva.selo, 'Só hoje');
  assert.deepStrictEqual(salva.beneficios, ['A', 'B']);
  assert.deepStrictEqual(salva.faq, [{ p: 'Pergunta?', r: 'Resposta.' }]);   // item sem pergunta é descartado
  assert.strictEqual(salva.subtitulo, assinaturas.OFERTA_PADRAO.subtitulo);   // vazio cai no padrão
  const lida = await assinaturas.obterOferta();
  assert.deepStrictEqual(lida, salva);
  // desconto "ativo" com valor zero não vale
  const zero = await assinaturas.salvarOferta({ ...salva, desconto: { ativo: true, tipo: 'valor', percentual: 0, valor_centavos: 0 } });
  assert.strictEqual(zero.desconto.ativo, false);
});

test('calcularDescontoCentavos: percentual, valor fixo e piso de R$ 1,00', () => {
  const f = assinaturas.calcularDescontoCentavos;
  assert.strictEqual(f(9900, { ativo: true, tipo: 'percentual', percentual: 10 }), 990);
  assert.strictEqual(f(9900, { ativo: true, tipo: 'valor', valor_centavos: 1500 }), 1500);
  assert.strictEqual(f(9900, { ativo: true, tipo: 'valor', valor_centavos: 999999 }), 9800);   // sobra R$ 1,00
  assert.strictEqual(f(9900, { ativo: true, tipo: 'percentual', percentual: 90 }), 8910);
  assert.strictEqual(f(9900, { ativo: false, tipo: 'percentual', percentual: 10 }), 0);
});

test('assinatura com desconto: MP cobra o valor com desconto e a página mostra de/por', async () => {
  await assinaturas.salvarOferta({ ...(await assinaturas.obterOferta()), desconto: { ativo: true, tipo: 'percentual', percentual: 10, valor_centavos: 0 } });
  await novoAlunoComMatricula('d1', { telefone: '11999990000' });
  const r = await assinaturas.criarAssinatura({ matriculaId: 'm-d1', baseUrl: 'https://academia.test' });
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.strictEqual(payload.valorCentavos, 8910);                   // o que o MP vai cobrar
  assert.strictEqual(r.desconto_centavos, 990);
  assert.ok(decodeURIComponent(r.whatsapp_link).includes('desconto'));
  const o = await assinaturas.ofertaPublica(r.id);
  assert.strictEqual(o.valor_centavos, 8910);
  assert.strictEqual(o.valor_cheio_centavos, 9900);
  assert.strictEqual(o.desconto_centavos, 990);
  assert.strictEqual(o.titulo, 'Oi {nome}, assine *já*');             // textos editados chegam à página
});

test('baixa com desconto: reduz o valor da conta, registra o pagamento real e fecha a conta', async () => {
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, vencimento) VALUES ('c-d1', 'd1', 'm-d1', 9900, 'pendente', 'recorrencia', '2026-12-10')` });
  const sub = (await db.execute({ sql: `SELECT preapproval_id FROM assinaturas_mp WHERE matricula_id='m-d1'` })).rows[0];
  estadoMp.parcelas['AP-D1'] = { preapproval_id: sub.preapproval_id, transaction_amount: 89.1, payment: { id: 5001, status: 'approved' } };
  assert.deepStrictEqual(await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: 'AP-D1' }), { alunoId: 'd1' });
  const conta = (await db.execute({ sql: `SELECT status, valor_centavos FROM cobrancas WHERE id='c-d1'` })).rows[0];
  assert.strictEqual(conta.status, 'pago');
  assert.strictEqual(dinheiro(conta), 8910);                          // conta fecha pelo valor com desconto
  const pag = (await db.execute({ sql: `SELECT valor_centavos, tipo FROM pagamentos_cobranca WHERE cobranca_id='c-d1'` })).rows;
  assert.strictEqual(pag.length, 1);
  assert.strictEqual(dinheiro(pag[0]), 8910);
  assert.strictEqual(pag[0].tipo, 'cartao_credito');
});

test('baixa com valor inesperado NÃO fecha a conta (fica para conferência)', async () => {
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, vencimento) VALUES ('c-d2', 'd1', 'm-d1', 9900, 'pendente', 'recorrencia', '2027-01-10')` });
  const sub = (await db.execute({ sql: `SELECT preapproval_id FROM assinaturas_mp WHERE matricula_id='m-d1'` })).rows[0];
  estadoMp.parcelas['AP-D2'] = { preapproval_id: sub.preapproval_id, transaction_amount: 50, payment: { id: 5002, status: 'approved' } };
  assert.strictEqual(await assinaturas.processarEvento({ type: 'subscription_authorized_payment', dataId: 'AP-D2' }), null);
  const conta = (await db.execute({ sql: `SELECT status, valor_centavos FROM cobrancas WHERE id='c-d2'` })).rows[0];
  assert.strictEqual(conta.status, 'pendente');
  assert.strictEqual(dinheiro(conta), 9900);
  const reg = (await db.execute({ sql: `SELECT baixa FROM assinaturas_mp_pagamentos WHERE payment_id='5002'` })).rows[0];
  assert.strictEqual(reg.baixa, 'valor_divergente');
});

test('portal: permite trocar modalidade pendente sem manter duas assinaturas', async () => {
  const base = 'https://academia.test';
  await novoAlunoComMatricula('d2');
  const r1 = await assinaturas.obterOuCriarParaAluno({ alunoId: 'd2', baseUrl: base, modalidade: '12_meses' });
  const primeira = (await db.execute({ sql: `SELECT id, modalidade, valor_centavos FROM assinaturas_mp WHERE aluno_id='d2' AND status='pending'` })).rows[0];
  assert.strictEqual(primeira.modalidade, '12_meses');
  assert.strictEqual(Number(primeira.valor_centavos), 6500);

  const r2 = await assinaturas.obterOuCriarParaAluno({ alunoId: 'd2', baseUrl: base, modalidade: 'mensal_livre' });
  assert.notStrictEqual(r2.oferta_url, r1.oferta_url);
  const abertas = (await db.execute({ sql: `SELECT modalidade, valor_centavos FROM assinaturas_mp WHERE aluno_id='d2' AND status='pending'` })).rows;
  assert.strictEqual(abertas.length, 1);
  assert.strictEqual(abertas[0].modalidade, 'mensal_livre');
  assert.strictEqual(Number(abertas[0].valor_centavos), 7000);
  const antiga = await assinaturas.ofertaPublica(r1.oferta_url.split('/').pop());
  assert.strictEqual(antiga.status, 'cancelled');
});

test('prévia: monta a página com as configurações atuais sem criar nada', async () => {
  const antes = Number((await db.execute({ sql: 'SELECT COUNT(*) n FROM assinaturas_mp' })).rows[0].n);
  const o = await assinaturas.ofertaPublica('preview');
  assert.strictEqual(o.preview, true);
  assert.strictEqual(o.init_point, '#');
  assert.ok(o.valor_centavos < o.valor_cheio_centavos);               // desconto ativo aparece na prévia
  assert.strictEqual(Number((await db.execute({ sql: 'SELECT COUNT(*) n FROM assinaturas_mp' })).rows[0].n), antes);
});

test('pagamento recorrente estende a validade da matrícula até o próximo vencimento', async () => {
  await novoAlunoComMatricula('renova-validade');
  await db.execute({
    sql: `UPDATE matriculas SET data_fim = '2026-11-11' WHERE id = 'm-renova-validade'`,
  });
  await assinaturas.obterOuCriarParaAluno({
    alunoId: 'renova-validade',
    baseUrl: 'https://academia.test',
    modalidade: 'mensal_livre',
  });
  const sub = (await db.execute({
    sql: `SELECT * FROM assinaturas_mp WHERE aluno_id = 'renova-validade'`,
  })).rows[0];
  const primeira = (await db.execute({
    sql: `SELECT id, vencimento FROM cobrancas WHERE matricula_id = 'm-renova-validade' AND status = 'pendente'`,
  })).rows[0];
  const hoje = new Date().toISOString().slice(0, 10);
  const baseVencimento = primeira.vencimento < hoje ? hoje : primeira.vencimento;
  const [ano, mes, dia] = baseVencimento.split('-').map(Number);
  const alvo = new Date(Date.UTC(ano, mes, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const proximoEsperado = `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;

  estadoMp.parcelas['AP-RENOVA-VALIDADE'] = {
    preapproval_id: sub.preapproval_id,
    transaction_amount: 70,
    payment: { id: 'PAY-RENOVA-VALIDADE', status: 'approved' },
  };
  await assinaturas.processarEvento({
    type: 'subscription_authorized_payment',
    dataId: 'AP-RENOVA-VALIDADE',
  });

  const matricula = (await db.execute({
    sql: `SELECT data_fim FROM matriculas WHERE id = 'm-renova-validade'`,
  })).rows[0];
  assert.strictEqual(matricula.data_fim, proximoEsperado);
});


test('modalidade configurável: aplica desconto e congela preço e quantidade no contrato', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('novo-config', 'Aluno Config', 'config@teste.com', '11100099988')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-config', 'novo-config', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-config', 'novo-config', 'm-config', 9900, 'pendente', 'mercadopago', 'Matrícula - Mensal', '2026-11-10')` });

  const planos = [{
    id: 'trimestral_promocional', nome: 'Trimestral promocional', valor_centavos: 6000,
    limite_cobrancas: 3, ativo: true,
    desconto: { ativo: true, tipo: 'percentual', percentual: 10, valor_centavos: 0 },
  }];
  await assinaturas.salvarPlanosCadastro(planos);
  const opcoes = await assinaturas.listarPlanosCadastroPublicos();
  assert.strictEqual(opcoes.length, 1);
  assert.strictEqual(opcoes[0].valor_final_centavos, 5400);
  assert.strictEqual(opcoes[0].limite_cobrancas, 3);

  await assinaturas.obterOuCriarParaNovoCadastro({
    alunoId: 'novo-config', matriculaId: 'm-config', baseUrl: 'https://academia.test', modalidade: 'trimestral_promocional',
  });
  let contrato = (await db.execute({ sql: `SELECT valor_centavos, valor_cheio_centavos, desconto_centavos, limite_cobrancas FROM assinaturas_mp WHERE matricula_id='m-config'` })).rows[0];
  assert.strictEqual(contrato.valor_centavos, 5400);
  assert.strictEqual(contrato.valor_cheio_centavos, 6000);
  assert.strictEqual(contrato.desconto_centavos, 600);
  assert.strictEqual(contrato.limite_cobrancas, 3);

  // Reajustar a oferta só altera novos contratos.
  await assinaturas.salvarPlanosCadastro([{
    ...planos[0], valor_centavos: 8000, limite_cobrancas: 6,
    desconto: { ativo: false, tipo: 'percentual', percentual: 0, valor_centavos: 0 },
  }]);
  contrato = (await db.execute({ sql: `SELECT valor_centavos, valor_cheio_centavos, desconto_centavos, limite_cobrancas FROM assinaturas_mp WHERE matricula_id='m-config'` })).rows[0];
  assert.strictEqual(contrato.valor_centavos, 5400);
  assert.strictEqual(contrato.valor_cheio_centavos, 6000);
  assert.strictEqual(contrato.desconto_centavos, 600);
  assert.strictEqual(contrato.limite_cobrancas, 3);
});


test('migração de aluno atual também usa a modalidade cadastrada no painel', async () => {
  await novoAlunoComMatricula('mig-custom');
  await assinaturas.salvarPlanosCadastro([{
    id: 'mensal_custom', nome: 'Mensal personalizado', valor_centavos: 8000,
    limite_cobrancas: null, ativo: true,
    desconto: { ativo: false, tipo: 'percentual', percentual: 0, valor_centavos: 0 },
  }]);
  const criada = await assinaturas.obterOuCriarParaAluno({
    alunoId: 'mig-custom', baseUrl: 'https://academia.test', modalidade: 'mensal_custom',
  });
  assert.match(criada.oferta_url, /\/assinar\//);
  const contrato = (await db.execute({
    sql: `SELECT valor_centavos, valor_cheio_centavos, limite_cobrancas FROM assinaturas_mp WHERE matricula_id='m-mig-custom'`,
  })).rows[0];
  assert.strictEqual(contrato.valor_centavos, 8000);
  assert.strictEqual(contrato.valor_cheio_centavos, 8000);
  assert.strictEqual(contrato.limite_cobrancas, null);
});


test('checkout abandonado: expira após 48h, cancela no MP e restaura a cobrança original', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('abandona', 'Aluno Abandona', 'abandona@teste.com', '22200099988')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-abandona', 'abandona', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-abandona', 'abandona', 'm-abandona', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'abandona', matriculaId: 'm-abandona', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });

  // Recente: não mexe.
  let r = await assinaturas.expirarCheckoutsAbandonados({ horas: 48 });
  assert.strictEqual(r.cancelados, 0);

  await db.execute({ sql: `UPDATE assinaturas_mp SET criado_em = datetime('now', '-3 days') WHERE matricula_id = 'm-abandona'` });
  r = await assinaturas.expirarCheckoutsAbandonados({ horas: 48 });
  assert.strictEqual(r.cancelados, 1);

  const a = (await db.execute({ sql: `SELECT status FROM assinaturas_mp WHERE matricula_id='m-abandona'` })).rows[0];
  assert.strictEqual(a.status, 'cancelled');
  const c = (await db.execute({ sql: `SELECT valor_centavos, status FROM cobrancas WHERE id='c-abandona'` })).rows[0];
  assert.strictEqual(c.valor_centavos, 9900);
  assert.strictEqual(c.status, 'pendente');
});


test('reconciliação sem webhook: ativa a matrícula, dá baixa na 1ª cobrança e não duplica', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('recon', 'Aluno Recon', 'recon@teste.com', '33300099977')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-recon', 'recon', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-recon', 'recon', 'm-recon', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'recon', matriculaId: 'm-recon', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { preapproval_id: pre } = (await db.execute({ sql: `SELECT preapproval_id FROM assinaturas_mp WHERE matricula_id='m-recon'` })).rows[0];

  // O aluno cadastrou o cartão e o MP cobrou — mas NENHUM webhook chegou.
  estadoMp.assinaturas[pre].status = 'authorized';
  estadoMp.cobrancas = { ...(estadoMp.cobrancas || {}), [pre]: [{ id: 'AP-R1', preapproval_id: pre, transaction_amount: 70, debit_date: '2026-11-10', payment: { id: 9001, status: 'approved' } }] };

  let r = await assinaturas.reconciliarAssinaturas();
  assert.strictEqual(r.baixas, 1);
  assert.deepStrictEqual(r.alunosAtualizados, ['recon']);

  const m = (await db.execute({ sql: `SELECT status FROM matriculas WHERE id='m-recon'` })).rows[0];
  assert.strictEqual(m.status, 'ativa');
  const c = (await db.execute({ sql: `SELECT status, valor_centavos FROM cobrancas WHERE id='c-recon'` })).rows[0];
  assert.strictEqual(c.status, 'pago');
  assert.strictEqual(c.valor_centavos, 7000);
  const a = (await db.execute({ sql: `SELECT status, cobrancas_processadas FROM assinaturas_mp WHERE matricula_id='m-recon'` })).rows[0];
  assert.strictEqual(a.status, 'authorized');
  assert.strictEqual(a.cobrancas_processadas, 1);

  // Segunda execução (e/ou webhook atrasado): nada muda.
  r = await assinaturas.reconciliarAssinaturas();
  assert.strictEqual(r.baixas, 0);
  const a2 = (await db.execute({ sql: `SELECT cobrancas_processadas FROM assinaturas_mp WHERE matricula_id='m-recon'` })).rows[0];
  assert.strictEqual(a2.cobrancas_processadas, 1);
  const abertas = (await db.execute({ sql: `SELECT COUNT(*) n FROM cobrancas WHERE matricula_id='m-recon' AND status='pendente'` })).rows[0];
  assert.strictEqual(abertas.n, 1); // só a do próximo mês
});

test('recurso desligado: não oferece modalidades no cadastro', async () => {
  const antes = process.env.MERCADOPAGO_ASSINATURAS;
  try {
    process.env.MERCADOPAGO_ASSINATURAS = '0';
    assert.deepStrictEqual(await assinaturas.listarPlanosCadastroPublicos(), []);
    delete process.env.MERCADOPAGO_ASSINATURAS;
    assert.deepStrictEqual(await assinaturas.listarPlanosCadastroPublicos(), []);
  } finally {
    process.env.MERCADOPAGO_ASSINATURAS = antes;
  }
  assert.ok((await assinaturas.listarPlanosCadastroPublicos()).length >= 1);
});

test('cronograma da cobrança automática segue o vencimento da matrícula', () => {
  // Vencimento no futuro (aluno entrou dia 5, vence dia 10): 1ª cobrança nessa data, próxima 1 mês depois.
  assert.deepStrictEqual(assinaturas.cronogramaCobrancaAutomatica('2026-11-10', '2026-11-05'),
    { primeira_cobranca: '2026-11-10', primeira_ao_cadastrar: false, proxima_cobranca: '2026-12-10' });
  // Vencimento já passado (entrou dia 12, venceu dia 10): cobra ao cadastrar o cartão; próxima em 1 mês.
  assert.deepStrictEqual(assinaturas.cronogramaCobrancaAutomatica('2026-11-10', '2026-11-12'),
    { primeira_cobranca: '2026-11-12', primeira_ao_cadastrar: true, proxima_cobranca: '2026-12-12' });
  // Fim de mês: 31/01 → 28/02.
  assert.strictEqual(assinaturas.cronogramaCobrancaAutomatica('2027-01-20', '2027-01-31').proxima_cobranca, '2027-02-28');
});
