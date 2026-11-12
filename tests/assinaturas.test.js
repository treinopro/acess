// Teste de ponta a ponta das assinaturas do Mercado Pago, SEM rede e SEM tocar
// em produção: banco local descartável + mercadopago.service simulado.
// Rodar: node --test tests/assinaturas.test.js
// O banco é SEMPRE um arquivo local descartável: a DATABASE_URL do ambiente/.env
// (que neste projeto pode apontar pro Turso de produção) é ignorada de propósito.
process.env.DATABASE_URL = 'file:./teste-assinaturas.db';
delete process.env.DATABASE_AUTH_TOKEN;
process.env.MERCADOPAGO_ASSINATURAS = '1';
process.env.MERCADOPAGO_ACCESS_TOKEN = 'TESTE';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste-jwt'; // o router do portal carrega o módulo de login
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
    buscarPagamentosPorReferencia: async (ref) => (estadoMp.pagamentosRef?.[ref] || []),
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
  assert.strictEqual(payload.urlRetorno, `https://academia.test/portal.html?cartao=${r.id}`); // volta ao portal, que confirma o pagamento
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
  // Antes do cartão ser aprovado, a conta continua no valor original (quem for de Pix paga o valor do plano).
  assert.strictEqual(cobranca.valor_centavos, 9900);
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
  cobranca = (await db.execute({ sql: `SELECT status, valor_centavos FROM cobrancas WHERE id='c-novo-rec'` })).rows[0];
  assert.strictEqual(cobranca.status, 'pago');
  assert.strictEqual(cobranca.valor_centavos, 6500); // só agora vira o valor da modalidade
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
  assert.strictEqual(Number(conta.valor_centavos), 9900); // não muda antes do cartão ser aprovado
  assert.strictEqual(conta.status, 'pendente');
  const qtd = (await db.execute({ sql: `SELECT COUNT(*) n FROM cobrancas WHERE matricula_id='m-migra-aberta' AND vencimento=? AND status IN ('pendente','atrasado','pago')`, args: [hoje] })).rows[0].n;
  assert.strictEqual(Number(qtd), 1);
});

test('migração: abrir a oferta não cria conta; ao pagar, a conta nasce paga e a próxima vence no mês seguinte', async () => {
  await novoAlunoComMatricula('migra-paga');
  const hoje = new Date().toISOString().slice(0, 10);
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, vencimento) VALUES ('c-migra-paga', 'migra-paga', 'm-migra-paga', 9900, 'pago', 'recorrencia', ?)`, args: [hoje] });
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'migra-paga', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  // Só abrir a oferta NÃO lança conta no Financeiro.
  const antes = (await db.execute({ sql: `SELECT COUNT(*) n FROM cobrancas WHERE matricula_id='m-migra-paga' AND status IN ('pendente','atrasado')`, args: [] })).rows[0].n;
  assert.strictEqual(Number(antes), 0);

  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-migra-paga'`, args: [] })).rows[0];
  estadoMp.assinaturas[pre].status = 'authorized';
  estadoMp.pagamentosRef = { ...(estadoMp.pagamentosRef || {}), [id]: [{ id: 6101, status: 'approved', transaction_amount: 70, payment_type_id: 'credit_card' }] };
  estadoMp.cobrancas = { ...(estadoMp.cobrancas || {}), [pre]: [] };
  await assinaturas.sincronizarAgora({ assinaturaId: id });
  const contas = (await db.execute({ sql: `SELECT status, valor_centavos, vencimento, provedor FROM cobrancas WHERE matricula_id='m-migra-paga' AND id != 'c-migra-paga' ORDER BY vencimento`, args: [] })).rows;
  assert.deepStrictEqual(contas.map((c) => [c.status, Number(c.valor_centavos), c.provedor]), [['pago', 7000, 'assinatura_mp'], ['pendente', 7000, 'assinatura_mp']]);
  const [ano, mes, dia] = hoje.split('-').map(Number);
  const alvo = new Date(Date.UTC(ano, mes, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const esperado = `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
  assert.strictEqual(contas[1].vencimento, esperado);
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
    sql: `UPDATE matriculas SET data_fim = date('now') WHERE id = 'm-renova-validade'`, // validade termina hoje (data relativa, não fixa)
  });
  await assinaturas.obterOuCriarParaAluno({
    alunoId: 'renova-validade',
    baseUrl: 'https://academia.test',
    modalidade: 'mensal_livre',
  });
  const sub = (await db.execute({
    sql: `SELECT * FROM assinaturas_mp WHERE aluno_id = 'renova-validade'`,
  })).rows[0];
  // A conta da adesão nasce quando o pagamento é aprovado (vencendo hoje), e a validade vai até o mês seguinte.
  const hoje = new Date().toISOString().slice(0, 10);
  const baseVencimento = hoje;
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

test('cronograma da cobrança automática: 1ª ao cadastrar o cartão, seguintes no mesmo dia da adesão', () => {
  assert.deepStrictEqual(assinaturas.cronogramaCobrancaAutomatica('2026-11-12'),
    { primeira_cobranca: '2026-11-12', primeira_ao_cadastrar: true, proxima_cobranca: '2026-12-12' });
  assert.strictEqual(assinaturas.cronogramaCobrancaAutomatica('2027-01-31').proxima_cobranca, '2027-02-28');
});

test('novo cadastro no cartão: conta só muda (valor e vencimento=hoje) quando o cartão é aprovado; cancelar mantém o original', async () => {
  const hoje = new Date().toISOString().slice(0, 10);
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('venc', 'Aluno Venc', 'venc@teste.com', '44400099966')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-venc', 'venc', 'p1', ?, 'pendente')`, args: [hoje] });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-venc', 'venc', 'm-venc', 9900, 'pendente', 'mercadopago', 'Matrícula', '2099-01-20')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'venc', matriculaId: 'm-venc', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });

  // O MP é chamado SEM start_date (cobra ao cadastrar o cartão) e a conta continua intacta até lá.
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.strictEqual(payload.dataInicio, null);
  let c = (await db.execute({ sql: `SELECT vencimento, valor_centavos FROM cobrancas WHERE id='c-venc'` })).rows[0];
  assert.deepStrictEqual({ ...c }, { vencimento: '2099-01-20', valor_centavos: 9900 });

  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-venc'` })).rows[0];
  // Desistiu do cartão: cancelar não mexe na conta.
  await assinaturas.cancelar({ assinaturaId: id });
  c = (await db.execute({ sql: `SELECT vencimento, valor_centavos, status FROM cobrancas WHERE id='c-venc'` })).rows[0];
  assert.deepStrictEqual({ ...c }, { vencimento: '2099-01-20', valor_centavos: 9900, status: 'pendente' });
  assert.ok(pre);
});

test('novo cadastro: com cartão aprovado a 1ª conta passa a vencer hoje e a próxima um mês depois', async () => {
  const hoje = new Date().toISOString().slice(0, 10);
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('aprova', 'Aluno Aprova', 'aprova@teste.com', '77700099933')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-aprova', 'aprova', 'p1', ?, 'pendente')`, args: [hoje] });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-aprova', 'aprova', 'm-aprova', 9900, 'pendente', 'mercadopago', 'Matrícula', '2099-01-20')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'aprova', matriculaId: 'm-aprova', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { preapproval_id: pre } = (await db.execute({ sql: `SELECT preapproval_id FROM assinaturas_mp WHERE matricula_id='m-aprova'` })).rows[0];
  estadoMp.assinaturas[pre].status = 'authorized';
  estadoMp.cobrancas = { ...(estadoMp.cobrancas || {}), [pre]: [{ id: 'AP-A1', preapproval_id: pre, transaction_amount: 70, payment: { id: 9301, status: 'approved' } }] };
  await assinaturas.reconciliarAssinaturas();
  const paga = (await db.execute({ sql: `SELECT status, valor_centavos, vencimento FROM cobrancas WHERE id='c-aprova'` })).rows[0];
  assert.deepStrictEqual({ ...paga }, { status: 'pago', valor_centavos: 7000, vencimento: hoje });
  const prox = (await db.execute({ sql: `SELECT vencimento FROM cobrancas WHERE matricula_id='m-aprova' AND status='pendente'` })).rows;
  assert.strictEqual(prox.length, 1);
  const [a, m, d] = hoje.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m, 1));
  const ult = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  assert.strictEqual(prox[0].vencimento, `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, ult)).padStart(2, '0')}`);
});

test('cancelar recorrência ativa volta a matrícula para a regra normal (renovação automática, sem contas da assinatura)', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('volta', 'Aluno Volta', 'volta@teste.com', '55500099955')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-volta', 'volta', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-volta', 'volta', 'm-volta', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'volta', matriculaId: 'm-volta', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-volta'` })).rows[0];
  estadoMp.assinaturas[pre].status = 'authorized';
  estadoMp.cobrancas = { ...(estadoMp.cobrancas || {}), [pre]: [{ id: 'AP-V1', preapproval_id: pre, transaction_amount: 70, debit_date: '2026-11-10', payment: { id: 9101, status: 'approved' } }] };
  await assinaturas.reconciliarAssinaturas();

  let m = (await db.execute({ sql: `SELECT status, renovacao_automatica FROM matriculas WHERE id='m-volta'` })).rows[0];
  assert.strictEqual(m.status, 'ativa');
  assert.strictEqual(m.renovacao_automatica, 0); // durante a recorrência, o gerador normal fica desligado
  let abertas = (await db.execute({ sql: `SELECT provedor FROM cobrancas WHERE matricula_id='m-volta' AND status='pendente'` })).rows;
  assert.deepStrictEqual(abertas.map((x) => x.provedor), ['assinatura_mp']); // conta da assinatura, separada das normais

  const r = await assinaturas.cancelar({ assinaturaId: id });
  assert.strictEqual(r.voltou_plano_normal, true);
  m = (await db.execute({ sql: `SELECT status, renovacao_automatica FROM matriculas WHERE id='m-volta'` })).rows[0];
  assert.strictEqual(m.status, 'ativa');
  assert.strictEqual(m.renovacao_automatica, 1); // regra normal (10/20) volta a valer
  abertas = (await db.execute({ sql: `SELECT id FROM cobrancas WHERE matricula_id='m-volta' AND status IN ('pendente','atrasado')` })).rows;
  assert.strictEqual(abertas.length, 0);
  const paga = (await db.execute({ sql: `SELECT status FROM cobrancas WHERE id='c-volta'` })).rows[0];
  assert.strictEqual(paga.status, 'pago'); // histórico preservado
});

test('sincronizarAgora (botão do painel): dá baixa no pagamento já aprovado no MP', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('sync', 'Aluno Sync', 'sync@teste.com', '66600099944')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-sync', 'sync', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-sync', 'sync', 'm-sync', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'sync', matriculaId: 'm-sync', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-sync'` })).rows[0];
  estadoMp.assinaturas[pre].status = 'authorized';
  estadoMp.cobrancas = { ...(estadoMp.cobrancas || {}), [pre]: [{ id: 'AP-S1', preapproval_id: pre, transaction_amount: 70, payment: { id: 9201, status: 'approved' } }] };
  const r = await assinaturas.sincronizarAgora({ assinaturaId: id });
  assert.strictEqual(r.baixas, 1);
  assert.strictEqual(r.status, 'authorized');
  const c = (await db.execute({ sql: `SELECT status FROM cobrancas WHERE id='c-sync'` })).rows[0];
  assert.strictEqual(c.status, 'pago');
});


test('aluno que escolhe Pix depois de iniciar o cartão: tentativa pendente é cancelada e a conta segue no valor original', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('pixvolta', 'Aluno Pix', 'pix@teste.com', '88800099922')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-pixvolta', 'pixvolta', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-pixvolta', 'pixvolta', 'm-pixvolta', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: '12_meses', nome: '12 meses', valor_centavos: 6500, limite_cobrancas: 12, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'pixvolta', matriculaId: 'm-pixvolta', baseUrl: 'https://academia.test', modalidade: '12_meses' });
  let c = (await db.execute({ sql: `SELECT valor_centavos FROM cobrancas WHERE id='c-pixvolta'` })).rows[0];
  assert.strictEqual(c.valor_centavos, 9900); // o "Meu espaço" mostraria R$ 99,00, e não o da modalidade

  const n = await assinaturas.cancelarPendentesDasMatriculas(['m-pixvolta']);
  assert.strictEqual(n, 1);
  const a = (await db.execute({ sql: `SELECT status FROM assinaturas_mp WHERE matricula_id='m-pixvolta'` })).rows[0];
  assert.strictEqual(a.status, 'cancelled');
  c = (await db.execute({ sql: `SELECT valor_centavos, status FROM cobrancas WHERE id='c-pixvolta'` })).rows[0];
  assert.deepStrictEqual({ ...c }, { valor_centavos: 9900, status: 'pendente' });
});

test('painel: anexarRecorrencia marca matrículas/contas de recorrência e deixa as normais sem marca', async () => {
  const marcadas = await assinaturas.anexarRecorrencia([
    { id: 'm-recon', matricula_id: 'm-recon' },   // assinatura ativa (teste da reconciliação)
    { id: 'm-semsub', matricula_id: 'm-semsub' }, // sem assinatura
    { id: 'm-pixvolta', matricula_id: 'm-pixvolta' }, // assinatura cancelada → volta a ser normal
  ]);
  const por = Object.fromEntries(marcadas.map((r) => [r.id, r.recorrencia]));
  assert.ok(por['m-recon']);
  assert.strictEqual(typeof por['m-recon'].nome, 'string');
  assert.ok(['authorized', 'pending'].includes(por['m-recon'].status));
  assert.strictEqual(por['m-semsub'], null);
  assert.strictEqual(por['m-pixvolta'], null);
});

test('contas vencidas viram "atrasado" (corte em Brasília) e a lista garante isso sem esperar o job', async () => {
  const cobr = require('../src/services/cobrancas.service');
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('venceu', 'Aluno Venceu', 'venceu@teste.com', '12300099911')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-venceu', 'venceu', 'p1', '2026-01-01', 'ativa')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-venceu-ontem', 'venceu', 'm-venceu', 7000, 'pendente', 'manual', 'Mensalidade', date('now', '-3 hours', '-1 day'))` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-vence-hoje', 'venceu', 'm-venceu', 7000, 'pendente', 'manual', 'Mensalidade', date('now', '-3 hours'))` });
  await cobr.garantirVencidasAtualizadas();
  const st = Object.fromEntries((await db.execute({ sql: `SELECT id, status FROM cobrancas WHERE aluno_id='venceu'`, args: [] })).rows.map((r) => [r.id, r.status]));
  assert.strictEqual(st['c-venceu-ontem'], 'atrasado');
  assert.strictEqual(st['c-vence-hoje'], 'pendente'); // vence hoje (BRT): ainda não está atrasada
});

test('consultas do painel/jobs sempre passam args (o cliente do Turso exige)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'assinaturas.service.js'), 'utf8');
  for (const m of src.matchAll(/db\.execute\(\{/g)) {
    let i = m.index + m[0].length, depth = 1;
    while (depth && i < src.length) { if (src[i] === '{') depth += 1; else if (src[i] === '}') depth -= 1; i += 1; }
    const corpo = src.slice(m.index, i);
    if (/sql:/.test(corpo)) assert.ok(/args/.test(corpo), 'db.execute sem args: ' + corpo.slice(0, 80));
  }
});

test('modalidade restrita: só CPFs/categorias liberados enxergam e contratam; painel enxerga tudo', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf, categoria) VALUES ('prof1', 'Professor', 'prof@teste.com', '11111111111', 'professor')` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf, categoria) VALUES ('teste-cpf', 'Aluno Teste', 'tcpf@teste.com', '222.222.222-22', 'aluno')` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf, categoria) VALUES ('comum', 'Aluno Comum', 'comum@teste.com', '33333333333', 'aluno')` });
  await assinaturas.salvarPlanosCadastro([
    { id: 'publica', nome: 'Pública', valor_centavos: 7000, limite_cobrancas: null, ativo: true },
    { id: 'so_teste', nome: 'Só teste', valor_centavos: 100, limite_cobrancas: null, ativo: true, restrito: true,
      cpfs_permitidos: ['222.222.222-22', 'lixo'], categorias_permitidas: ['professor', 'inexistente'] },
  ]);
  const ids = async (arg) => (await assinaturas.listarPlanosCadastroPublicos(arg)).map((p) => p.id).sort();
  assert.deepStrictEqual(await ids({}), ['publica']);                              // anônimo
  assert.deepStrictEqual(await ids({ cpf: '33333333333' }), ['publica']);          // aluno comum
  assert.deepStrictEqual(await ids({ cpf: '222.222.222-22' }), ['publica', 'so_teste']); // CPF liberado (formatado)
  assert.deepStrictEqual(await ids({ cpf: '11111111111' }), ['publica', 'so_teste']);    // categoria professor
  assert.deepStrictEqual(await ids({ alunoId: 'prof1' }), ['publica', 'so_teste']);

  // O que foi salvo é normalizado.
  const salvo = (await assinaturas.obterPlanosCadastro()).find((p) => p.id === 'so_teste');
  assert.deepStrictEqual(salvo.cpfs_permitidos, ['22222222222']);
  assert.deepStrictEqual(salvo.categorias_permitidas, ['professor']);

  // Contratar: o servidor bloqueia quem não pode, mesmo sabendo o id; o painel (admin) pode.
  await assert.rejects(() => assinaturas.buscarPlanoCadastro('so_teste', { alunoId: 'comum' }), /não está disponível/);
  assert.strictEqual((await assinaturas.buscarPlanoCadastro('so_teste', { alunoId: 'prof1' })).id, 'so_teste');
  assert.strictEqual((await assinaturas.buscarPlanoCadastro('so_teste', { alunoId: 'comum', admin: true })).id, 'so_teste');
});

test('aluno existente sem nenhuma conta paga: cobra na adesão (sem start_date), mesmo com conta em aberto vencendo no futuro', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('semPago', 'Aluno Sem Pago', 'sempago@teste.com', '99900099911')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-sempago', 'semPago', 'p1', date('now'), 'ativa')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-sempago', 'semPago', 'm-sempago', 9900, 'pendente', 'manual', 'Mensalidade', '2099-12-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'semPago', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.strictEqual(payload.dataInicio, null); // sem "dias grátis": o MP cobra quando o cartão for cadastrado
});

test('aluno existente que já pagou o ciclo atual: primeira cobrança do cartão fica no próximo vencimento', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('jaPagou', 'Aluno Ja Pagou', 'japagou@teste.com', '99900099922')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-japagou', 'jaPagou', 'p1', date('now', '-20 days'), 'ativa')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-japagou', 'jaPagou', 'm-japagou', 9900, 'pago', 'manual', 'Mensalidade', date('now', '-1 day'))` });
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'jaPagou', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.ok(payload.dataInicio, 'esperava start_date no próximo vencimento');
});


test('sincronizarAgora: se a lista de cobranças da assinatura vier vazia, acha o pagamento pela referência e dá baixa uma só vez', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('ref1', 'Aluno Ref', 'ref@teste.com', '10100099900')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-ref1', 'ref1', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-ref1', 'ref1', 'm-ref1', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 100, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'ref1', matriculaId: 'm-ref1', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-ref1'` })).rows[0];
  estadoMp.assinaturas[pre].status = 'authorized';
  estadoMp.cobrancas = { ...(estadoMp.cobrancas || {}), [pre]: [] }; // a lista da assinatura veio vazia
  estadoMp.pagamentosRef = { ...(estadoMp.pagamentosRef || {}), [id]: [{ id: 5551, status: 'approved', transaction_amount: 1, payment_type_id: 'credit_card' }] };

  let r = await assinaturas.sincronizarAgora({ assinaturaId: id });
  assert.strictEqual(r.baixas, 1);
  assert.strictEqual(r.status_mp, 'authorized');
  assert.strictEqual(r.pagamentos_vistos.length, 1);
  const c = (await db.execute({ sql: `SELECT status, valor_centavos FROM cobrancas WHERE id='c-ref1'` })).rows[0];
  assert.deepStrictEqual({ ...c }, { status: 'pago', valor_centavos: 100 }); // conta passa ao valor da modalidade
  const m = (await db.execute({ sql: `SELECT status FROM matriculas WHERE id='m-ref1'` })).rows[0];
  assert.strictEqual(m.status, 'ativa');

  r = await assinaturas.sincronizarAgora({ assinaturaId: id }); // de novo: nada muda
  assert.strictEqual(r.baixas, 0);
});

test('excluir conta que foi paga por assinatura: o banco recusa até soltar o vínculo; depois exclui', async () => {
  // c-recon foi baixada por assinatura (teste da reconciliação) e tem registro em assinaturas_mp_pagamentos.
  await assert.rejects(() => db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: ['c-recon'] }), /FOREIGN KEY/i);
  await assinaturas.desvincularCobranca('c-recon');
  await db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: ['c-recon'] });
  const ainda = (await db.execute({ sql: `SELECT COUNT(*) n FROM cobrancas WHERE id='c-recon'`, args: [] })).rows[0].n;
  assert.strictEqual(Number(ainda), 0);
  // O registro do pagamento continua (não reprocessa o mesmo pagamento depois).
  const reg = (await db.execute({ sql: `SELECT COUNT(*) n FROM assinaturas_mp_pagamentos WHERE payment_id='9001'`, args: [] })).rows[0].n;
  assert.strictEqual(Number(reg), 1);
});

test('cancelar: se o MP diz que a assinatura já estava cancelada, o sistema conclui o cancelamento mesmo assim', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('jacancel', 'Aluno Ja Cancel', 'jc@teste.com', '70700099911')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-jacancel', 'jacancel', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-jacancel', 'jacancel', 'm-jacancel', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 100, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'jacancel', matriculaId: 'm-jacancel', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { id } = (await db.execute({ sql: `SELECT id FROM assinaturas_mp WHERE matricula_id='m-jacancel'` })).rows[0];

  // O MP responde 400 "You can not modify a cancelled preapproval" (já cancelada do lado dele).
  const mpPath = require.resolve('../src/services/payment/mercadopago.service');
  const original = require.cache[mpPath].exports.cancelarAssinatura;
  require.cache[mpPath].exports.cancelarAssinatura = async () => { throw new Error('Erro ao cancelar assinatura no Mercado Pago: {"message":"You can not modify a cancelled preapproval.","status":400}'); };
  try {
    const r = await assinaturas.cancelar({ assinaturaId: id });
    assert.strictEqual(r.status, 'cancelled');
  } finally { require.cache[mpPath].exports.cancelarAssinatura = original; }
  const a = (await db.execute({ sql: `SELECT status FROM assinaturas_mp WHERE id=?`, args: [id] })).rows[0];
  assert.strictEqual(a.status, 'cancelled');
  const c = (await db.execute({ sql: `SELECT valor_centavos, status FROM cobrancas WHERE id='c-jacancel'`, args: [] })).rows[0];
  assert.deepStrictEqual({ ...c }, { valor_centavos: 9900, status: 'pendente' });
});

test('aluno volta do Mercado Pago: verificarOferta confirma na hora (sem webhook/job) e o job rápido só olha pendentes', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('volta2', 'Aluno Volta2', 'v2@teste.com', '60600099955')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-volta2', 'volta2', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-volta2', 'volta2', 'm-volta2', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 100, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'volta2', matriculaId: 'm-volta2', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-volta2'` })).rows[0];

  // Antes de pagar: continua pendente e nada é baixado.
  let r = await assinaturas.verificarOferta(id);
  assert.strictEqual(r.oferta.status, 'pending');
  assert.deepStrictEqual(r.alunosAtualizados, []);

  // O aluno paga no MP; o webhook NÃO chega. Ao voltar para a página, a verificação confirma sozinha.
  estadoMp.assinaturas[pre].status = 'authorized';
  estadoMp.pagamentosRef = { ...(estadoMp.pagamentosRef || {}), [id]: [{ id: 6601, status: 'approved', transaction_amount: 1, payment_type_id: 'credit_card' }] };
  await new Promise((resolve) => setTimeout(resolve, 3100)); // respeita o intervalo mínimo de 3s por assinatura
  r = await assinaturas.verificarOferta(id);
  assert.strictEqual(r.oferta.status, 'authorized');
  assert.deepStrictEqual(r.alunosAtualizados, ['volta2']);
  const m = (await db.execute({ sql: `SELECT status FROM matriculas WHERE id='m-volta2'` })).rows[0];
  assert.strictEqual(m.status, 'ativa');

  // Job rápido: só considera assinaturas pendentes (esta já está autorizada).
  const j = await assinaturas.reconciliarAssinaturas({ somentePendentes: true });
  assert.ok(!j.alunosAtualizados.includes('volta2'));
});

test('1º pagamento: assinatura já "authorized" mas sem cobrança baixada continua sendo verificada (página e job rápido)', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('lag', 'Aluno Lag', 'lag@teste.com', '50500099944')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-lag', 'lag', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-lag', 'lag', 'm-lag', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 100, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'lag', matriculaId: 'm-lag', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-lag'` })).rows[0];

  // 1ª verificação: o MP já autorizou a assinatura, mas o pagamento ainda não aparece como aprovado.
  estadoMp.assinaturas[pre].status = 'authorized';
  let r = await assinaturas.verificarOferta(id);
  assert.strictEqual(r.oferta.status, 'authorized');
  assert.strictEqual(r.oferta.cobrancas_processadas, 0);

  // Segundos depois o pagamento aparece: a verificação SEGUINTE precisa baixar (antes ela pulava por não estar "pending").
  estadoMp.pagamentosRef = { ...(estadoMp.pagamentosRef || {}), [id]: [{ id: 7701, status: 'approved', transaction_amount: 1, payment_type_id: 'credit_card' }] };
  await new Promise((resolve) => setTimeout(resolve, 3100));
  r = await assinaturas.verificarOferta(id);
  assert.strictEqual(r.oferta.cobrancas_processadas, 1);
  assert.deepStrictEqual(r.alunosAtualizados, ['lag']);
});

test('job rápido (2 min) também pega assinatura autorizada sem 1ª cobrança baixada', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('lag2', 'Aluno Lag2', 'lag2@teste.com', '50500099955')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-lag2', 'lag2', 'p1', '2026-11-10', 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-lag2', 'lag2', 'm-lag2', 9900, 'pendente', 'mercadopago', 'Matrícula', '2026-11-10')` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 100, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'lag2', matriculaId: 'm-lag2', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-lag2'` })).rows[0];
  estadoMp.assinaturas[pre].status = 'authorized';
  await db.execute({ sql: `UPDATE assinaturas_mp SET status='authorized' WHERE id=?`, args: [id] }); // já autorizada localmente, sem baixa
  estadoMp.pagamentosRef = { ...(estadoMp.pagamentosRef || {}), [id]: [{ id: 7702, status: 'approved', transaction_amount: 1, payment_type_id: 'credit_card' }] };
  const j = await assinaturas.reconciliarAssinaturas({ somentePendentes: true });
  assert.ok(j.alunosAtualizados.includes('lag2'));
});

test('oferta de cartão aparece também para aluno com mensalidade atrasada e validade da matrícula vencida', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('atrasado', 'Aluno Atrasado', 'atr@teste.com', '30300099900')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, data_fim, status) VALUES ('m-atr', 'atrasado', 'p1', date('now', '-40 days'), date('now', '-1 day'), 'ativa')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-atr', 'atrasado', 'm-atr', 7000, 'atrasado', 'manual', 'Mensalidade', date('now', '-1 day'))` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  let d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'atrasado', baseUrl: 'https://academia.test' });
  assert.strictEqual(d.disponivel, true);
  assert.ok(d.opcoes.length >= 1);
  // Sem conta em aberto e com a validade vencida, continua fora (matrícula realmente encerrada).
  await db.execute({ sql: `UPDATE cobrancas SET status = 'pago' WHERE id = 'c-atr'` });
  d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'atrasado', baseUrl: 'https://academia.test' });
  assert.strictEqual(d.disponivel, false);
});

test('combo: soma o adicional mensal, grava na assinatura e a conta paga leva o valor do combo', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('combo1', 'Aluno Combo', 'combo1@teste.com', '80800099911')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-combo1', 'combo1', 'p1', date('now'), 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-combo1', 'combo1', 'm-combo1', 9900, 'pendente', 'mercadopago', 'Matrícula', date('now'))` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal sem fidelidade', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);

  // Lista pública: cada modalidade traz os combos com o total mensal (70 + 40 e 70 + 50).
  const op = (await assinaturas.listarPlanosCadastroPublicos()).find((x) => x.id === 'mensal_livre');
  assert.deepStrictEqual(op.combos.map((c) => [c.id, c.valor_total_centavos]), [['avaliacao', 11000], ['avaliacao_completa', 12000]]);

  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'combo1', matriculaId: 'm-combo1', baseUrl: 'https://academia.test', modalidade: 'mensal_livre', combo: 'avaliacao' });
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.strictEqual(payload.valorCentavos, 11000);
  assert.match(payload.razao, /\+ avaliação física/);
  assert.ok(payload.razao.length <= 60, 'nome da assinatura no MP não pode passar de 60 caracteres: ' + payload.razao);
  const sub = (await db.execute({ sql: `SELECT preapproval_id, valor_centavos, combo_id, combo_nome, adicional_centavos FROM assinaturas_mp WHERE matricula_id='m-combo1'` })).rows[0];
  assert.deepStrictEqual({ v: sub.valor_centavos, id: sub.combo_id, add: sub.adicional_centavos }, { v: 11000, id: 'avaliacao', add: 4000 });

  // Cartão aprovado: a conta passa ao valor do combo, a descrição cita o combo e a próxima nasce com o mesmo valor.
  estadoMp.assinaturas[sub.preapproval_id].status = 'authorized';
  estadoMp.cobrancas = { ...(estadoMp.cobrancas || {}), [sub.preapproval_id]: [{ id: 'AP-CB1', preapproval_id: sub.preapproval_id, transaction_amount: 110, payment: { id: 8801, status: 'approved' } }] };
  await assinaturas.reconciliarAssinaturas();
  const paga = (await db.execute({ sql: `SELECT status, valor_centavos FROM cobrancas WHERE id='c-combo1'` })).rows[0];
  assert.deepStrictEqual({ ...paga }, { status: 'pago', valor_centavos: 11000 });
  const prox = (await db.execute({ sql: `SELECT valor_centavos, descricao FROM cobrancas WHERE matricula_id='m-combo1' AND status='pendente'` })).rows[0];
  assert.strictEqual(prox.valor_centavos, 11000);
  assert.match(prox.descricao, /Mensal sem fidelidade \+ Plano \+ avaliação física/);
  // A etiqueta do painel mostra o combo.
  const [marcada] = await assinaturas.anexarRecorrencia([{ matricula_id: 'm-combo1' }]);
  assert.strictEqual(marcada.recorrencia.combo_nome, 'Plano + avaliação física');
});

test('combo: sem combo cobra só o plano; combo inexistente ou desativado é recusado; mudar o combo não altera contratos', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('combo2', 'Aluno Combo2', 'combo2@teste.com', '80800099922')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-combo2', 'combo2', 'p1', date('now'), 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-combo2', 'combo2', 'm-combo2', 9900, 'pendente', 'mercadopago', 'Matrícula', date('now'))` });
  await assert.rejects(() => assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'combo2', matriculaId: 'm-combo2', baseUrl: 'https://academia.test', modalidade: 'mensal_livre', combo: 'nao_existe' }), /não está disponível/);

  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'combo2', matriculaId: 'm-combo2', baseUrl: 'https://academia.test', modalidade: 'mensal_livre', combo: 'nenhum' });
  const [, p1] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.strictEqual(p1.valorCentavos, 7000);
  const s1 = (await db.execute({ sql: `SELECT valor_centavos, combo_id, adicional_centavos FROM assinaturas_mp WHERE matricula_id='m-combo2'` })).rows[0];
  assert.deepStrictEqual({ v: s1.valor_centavos, id: s1.combo_id, add: s1.adicional_centavos }, { v: 7000, id: null, add: 0 });

  // Desativar o combo esconde da lista pública e bloqueia novas adesões, sem mexer em contratos existentes.
  await assinaturas.salvarCombos([{ id: 'avaliacao', nome: 'Plano + avaliação física', adicional_centavos: 9999, ativo: false }]);
  assert.deepStrictEqual((await assinaturas.listarPlanosCadastroPublicos()).find((x) => x.id === 'mensal_livre').combos, []);
  await assert.rejects(() => assinaturas.buscarCombo('avaliacao'), /não está disponível/);
  const antigo = (await db.execute({ sql: `SELECT valor_centavos, adicional_centavos FROM assinaturas_mp WHERE matricula_id='m-combo1'` })).rows[0];
  assert.deepStrictEqual({ v: antigo.valor_centavos, add: antigo.adicional_centavos }, { v: 11000, add: 4000 });
  // restaura os combos padrão para os testes seguintes
  await assinaturas.salvarCombos([{ id: 'avaliacao', nome: 'Plano + avaliação física', adicional_centavos: 4000, ativo: true }, { id: 'avaliacao_completa', nome: 'Plano + avaliação completa', adicional_centavos: 5000, ativo: true }]);
});

test('combo: aluno existente (painel/portal) cobra o valor com combo e a conta não muda antes do pagamento', async () => {
  await novoAlunoComMatricula('combo3');
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, vencimento) VALUES ('c-combo3', 'combo3', 'm-combo3', 9900, 'pendente', 'recorrencia', date('now'))` });
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'combo3', baseUrl: 'https://academia.test', modalidade: 'mensal_livre', combo: 'avaliacao_completa' });
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.strictEqual(payload.valorCentavos, 12000);
  const conta = (await db.execute({ sql: `SELECT valor_centavos FROM cobrancas WHERE id='c-combo3'` })).rows[0];
  assert.strictEqual(conta.valor_centavos, 9900); // só muda quando o cartão for aprovado
  // Trocar o combo da pendente cria outra assinatura (e cancela a anterior).
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'combo3', baseUrl: 'https://academia.test', modalidade: 'mensal_livre', combo: 'avaliacao' });
  const ativas = (await db.execute({ sql: `SELECT combo_id, status FROM assinaturas_mp WHERE matricula_id='m-combo3' ORDER BY criado_em` })).rows.map((r) => `${r.combo_id}:${r.status}`);
  assert.deepStrictEqual(ativas, ['avaliacao_completa:cancelled', 'avaliacao:pending']);
});

test('combo restrito: só CPF/categoria liberados enxergam e contratam; os demais recebem 404; painel enxerga todos', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf, categoria) VALUES ('cb-prof', 'Prof Combo', 'cbp@teste.com', '91919191919', 'professor')` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf, categoria) VALUES ('cb-teste', 'Teste Combo', 'cbt@teste.com', '929.292.929-29', 'aluno')` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf, categoria) VALUES ('cb-comum', 'Comum Combo', 'cbc@teste.com', '93939393939', 'aluno')` });
  await assinaturas.salvarCombos([
    { id: 'avaliacao', nome: 'Plano + avaliação física', adicional_centavos: 4000, ativo: true },
    { id: 'combo_teste', nome: 'Plano + combo teste', adicional_centavos: 100, ativo: true, restrito: true, cpfs_permitidos: ['929.292.929-29', 'lixo'], categorias_permitidas: ['professor', 'inexistente'] },
  ]);
  const ids = async (arg) => (await assinaturas.listarCombosPublicos(arg)).map((c) => c.id).sort();
  assert.deepStrictEqual(await ids({}), ['avaliacao']);                                  // anônimo
  assert.deepStrictEqual(await ids({ alunoId: 'cb-comum' }), ['avaliacao']);              // aluno comum
  assert.deepStrictEqual(await ids({ cpf: '92929292929' }), ['avaliacao', 'combo_teste']); // CPF liberado
  assert.deepStrictEqual(await ids({ alunoId: 'cb-prof' }), ['avaliacao', 'combo_teste']); // categoria liberada
  const salvo = (await assinaturas.obterCombos()).find((c) => c.id === 'combo_teste');
  assert.deepStrictEqual([salvo.cpfs_permitidos, salvo.categorias_permitidas], [['92929292929'], ['professor']]);

  await assert.rejects(() => assinaturas.buscarCombo('combo_teste', { alunoId: 'cb-comum' }), /não está disponível/);
  assert.strictEqual((await assinaturas.buscarCombo('combo_teste', { alunoId: 'cb-prof' })).id, 'combo_teste');
  assert.strictEqual((await assinaturas.buscarCombo('combo_teste', { alunoId: 'cb-comum', admin: true })).id, 'combo_teste');

  // Na modalidade, o aluno comum não recebe o combo restrito na lista.
  const op = (await assinaturas.listarPlanosCadastroPublicos({ alunoId: 'cb-comum' })).find((x) => x.id === 'mensal_livre');
  assert.deepStrictEqual(op.combos.map((c) => c.id), ['avaliacao']);

  await assinaturas.salvarCombos([{ id: 'avaliacao', nome: 'Plano + avaliação física', adicional_centavos: 4000, ativo: true }, { id: 'avaliacao_completa', nome: 'Plano + avaliação completa', adicional_centavos: 5000, ativo: true }]);
});


test('nome da assinatura no MP nunca passa de 60 caracteres, mesmo com plano, modalidade e combo longos', async () => {
  await db.execute({ sql: `INSERT INTO planos (id, nome, tipo, valor_centavos) VALUES ('p-longo', 'MUSCULAÇÃO E FUNCIONAL COM ACOMPANHAMENTO - ', 'mensal', 9900)` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('longo', 'Maria Aparecida dos Santos de Albuquerque Cavalcanti', 'longo@teste.com', '70707070707')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-longo', 'longo', 'p-longo', date('now'), 'pendente')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-longo', 'longo', 'm-longo', 9900, 'pendente', 'mercadopago', 'Matrícula', date('now'))` });
  await assinaturas.salvarPlanosCadastro([{ id: 'compromisso_longo', nome: 'Compromisso anual com desconto de fidelidade especial', valor_centavos: 6500, limite_cobrancas: 12, ativo: true }]);
  await assinaturas.salvarCombos([{ id: 'avaliacao_longa', nome: 'Plano + avaliação física completa com bioimpedância', adicional_centavos: 5000, ativo: true }]);
  await assinaturas.obterOuCriarParaNovoCadastro({ alunoId: 'longo', matriculaId: 'm-longo', baseUrl: 'https://academia.test', modalidade: 'compromisso_longo', combo: 'avaliacao_longa' });
  const [, payload] = chamadas.filter((c) => c[0] === 'criar').pop();
  assert.ok(payload.razao.length <= 60, payload.razao);
  assert.ok(payload.razao.length > 10, payload.razao);
  await assinaturas.salvarCombos([{ id: 'avaliacao', nome: 'Plano + avaliação física', adicional_centavos: 4000, ativo: true }, { id: 'avaliacao_completa', nome: 'Plano + avaliação completa', adicional_centavos: 5000, ativo: true }]);
});


test('plano anual (já pago adiantado) não recebe oferta de recorrência mensal nem conta nova atrasada', async () => {
  await db.execute({ sql: `INSERT INTO planos (id, nome, tipo, valor_centavos) VALUES ('p-anual', 'ANUAL PROMOCIONAL', 'anual', 53984)` });
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('anual1', 'Aluna Anual', 'anual@teste.com', '40404040404')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, data_fim, status) VALUES ('m-anual1', 'anual1', 'p-anual', date('now', '-5 months'), date('now', '+7 months'), 'ativa')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-anual1', 'anual1', 'm-anual1', 48000, 'pago', 'manual', 'Anual', date('now', '-5 months'))` });
  const d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'anual1', baseUrl: 'https://academia.test' });
  assert.strictEqual(d.disponivel, false);
  await assert.rejects(() => assinaturas.obterOuCriarParaAluno({ alunoId: 'anual1', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' }), /não está disponível/);
  const novas = (await db.execute({ sql: `SELECT COUNT(*) n FROM cobrancas WHERE matricula_id='m-anual1' AND status IN ('pendente','atrasado')`, args: [] })).rows[0].n;
  assert.strictEqual(Number(novas), 0); // nenhuma conta nova criada
});

test('plano mensal com ciclo já passado: a conta nova nasce vencendo hoje, nunca no passado', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('passado', 'Aluno Passado', 'passado@teste.com', '50404040404')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-passado', 'passado', 'p1', date('now', '-6 months'), 'ativa')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-passado', 'passado', 'm-passado', 9900, 'pago', 'manual', 'Mensalidade', date('now', '-4 months'))` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'passado', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const hoje = new Date().toISOString().slice(0, 10);
  // Não cria conta ao abrir a oferta (nada atrasado, nada bloqueando); a 1ª cobrança do cartão é pedida para hoje.
  const abertas = (await db.execute({ sql: `SELECT COUNT(*) n FROM cobrancas WHERE matricula_id='m-passado' AND status IN ('pendente','atrasado')`, args: [] })).rows[0].n;
  assert.strictEqual(Number(abertas), 0);
  const sub = (await db.execute({ sql: `SELECT data_primeira_cobranca FROM assinaturas_mp WHERE matricula_id='m-passado'`, args: [] })).rows[0];
  assert.ok(!sub.data_primeira_cobranca || sub.data_primeira_cobranca <= hoje, 'a 1ª cobrança não pode ficar no futuro nem no passado distante');
});

test('checkout parado: portal cancela em minutos, link da recepção só em horas; ao voltar ao portal desfaz a tentativa ociosa', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('ocioso', 'Aluno Ocioso', 'ocioso@teste.com', '12121212121')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-ocioso', 'ocioso', 'p1', date('now'), 'ativa')` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-ocioso', 'ocioso', 'm-ocioso', 9900, 'pendente', 'manual', 'Mensalidade', date('now', '+5 days'))` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);

  // Aluno escolhe sozinho no portal (origem 'portal').
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'ocioso', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  await db.execute({ sql: `UPDATE assinaturas_mp SET origem = 'portal' WHERE matricula_id = 'm-ocioso'` });
  // Recém-criada: nada acontece.
  assert.strictEqual((await assinaturas.expirarCheckoutsAbandonados({ minutosPortal: 60 })).cancelados, 0);
  assert.strictEqual(await assinaturas.cancelarPendentesOciosasDoAluno('ocioso', 15), 0);

  // Parada há 20 min: ao voltar ao portal (15 min) é desfeita; a conta segue como era.
  await db.execute({ sql: `UPDATE assinaturas_mp SET criado_em = datetime('now', '-20 minutes') WHERE matricula_id = 'm-ocioso'` });
  assert.strictEqual((await assinaturas.expirarCheckoutsAbandonados({ minutosPortal: 60 })).cancelados, 0); // ainda dentro dos 60 min
  assert.strictEqual(await assinaturas.cancelarPendentesOciosasDoAluno('ocioso', 15), 1);
  let a = (await db.execute({ sql: `SELECT status FROM assinaturas_mp WHERE matricula_id='m-ocioso'`, args: [] })).rows[0];
  assert.strictEqual(a.status, 'cancelled');
  const conta = (await db.execute({ sql: `SELECT valor_centavos, status FROM cobrancas WHERE id='c-ocioso'`, args: [] })).rows[0];
  assert.deepStrictEqual({ ...conta }, { valor_centavos: 9900, status: 'pendente' });

  // Outro caso: parada há 70 min, o job cancela (portal, 60 min).
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'ocioso', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  await db.execute({ sql: `UPDATE assinaturas_mp SET origem = 'portal', criado_em = datetime('now', '-70 minutes') WHERE matricula_id = 'm-ocioso' AND status = 'pending'` });
  assert.strictEqual((await assinaturas.expirarCheckoutsAbandonados({ minutosPortal: 60 })).cancelados, 1);

  // Link gerado pela recepção (origem 'painel'): 70 minutos não cancela; só depois de 48 h.
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'ocioso', baseUrl: 'https://academia.test', modalidade: 'mensal_livre', admin: true });
  await db.execute({ sql: `UPDATE assinaturas_mp SET criado_em = datetime('now', '-70 minutes') WHERE matricula_id = 'm-ocioso' AND status = 'pending'` });
  assert.strictEqual((await assinaturas.expirarCheckoutsAbandonados({ minutosPortal: 60 })).cancelados, 0);
  assert.strictEqual(await assinaturas.cancelarPendentesOciosasDoAluno('ocioso', 15), 0); // não mexe em link da recepção
  await db.execute({ sql: `UPDATE assinaturas_mp SET criado_em = datetime('now', '-3 days') WHERE matricula_id = 'm-ocioso' AND status = 'pending'` });
  assert.strictEqual((await assinaturas.expirarCheckoutsAbandonados({ minutosPortal: 60 })).cancelados, 1);
});

test('verificar na volta do MP: se o código da página não existir, acha pelo preapproval_id que o MP devolve', async () => {
  const sub = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp ORDER BY criado_em DESC LIMIT 1`, args: [] })).rows[0];
  assert.strictEqual(await assinaturas.verificarOferta('codigo-que-nao-existe'), null);
  const r = await assinaturas.verificarOferta('codigo-que-nao-existe', { preapprovalId: sub.preapproval_id });
  assert.ok(r && r.oferta, 'deveria achar pela assinatura do MP');
});

test('portal: assinar plano em modo "escolher" cria a pré-matrícula sem Pix e retoma a mesma se o aluno voltar', async () => {
  const express = require('express');
  const http = require('http');
  const portal = require('../src/routes/portal.routes');
  await db.execute({ sql: `INSERT OR IGNORE INTO planos (id, nome, tipo, valor_centavos, ativo) VALUES ('p-up', 'MUSCULAÇÃO UP', 'mensal', 9900, 1)`, args: [] });
  await db.execute({ sql: `INSERT OR IGNORE INTO alunos (id, nome, email, cpf, biometria_id) VALUES ('al-up', 'Aluno Up', 'up@teste.com', '60606060606', '7777')`, args: [] });
  const app = express();
  app.use(express.json());
  app.use('/api/portal', portal);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ erro: err.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const porta = server.address().port;
  const chamar = (corpo) => new Promise((resolve, reject) => {
    const txt = JSON.stringify(corpo);
    const r = http.request({ port: porta, path: '/api/portal/upgrade', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(txt) } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d || '{}') })); });
    r.on('error', reject); r.end(txt);
  });
  try {
    const um = await chamar({ cpf: '60606060606', senha: '7777', plano_id: 'p-up', escolher: true });
    assert.strictEqual(um.status, 201);
    assert.strictEqual(um.json.plano_tipo, 'mensal');
    assert.strictEqual(um.json.valor_centavos, 9900);
    const conta = (await db.execute({ sql: `SELECT provedor_referencia, status FROM cobrancas WHERE id = ?`, args: [um.json.cobranca_id] })).rows[0];
    assert.strictEqual(conta.provedor_referencia, null); // nenhum Pix foi gerado
    // O aluno voltou sem terminar: retoma a mesma pré-matrícula, sem duplicar.
    const dois = await chamar({ cpf: '60606060606', senha: '7777', plano_id: 'p-up', escolher: true });
    assert.strictEqual(dois.status, 200);
    assert.strictEqual(dois.json.retomada, true);
    assert.strictEqual(dois.json.matricula_id, um.json.matricula_id);
    const n = (await db.execute({ sql: `SELECT COUNT(*) n FROM matriculas WHERE aluno_id = 'al-up'`, args: [] })).rows[0].n;
    assert.strictEqual(Number(n), 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cartão automático só para a mensalidade do mês corrente: mês anterior em aberto bloqueia e vai por Pix', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('mes1', 'Aluno Mes', 'mes@teste.com', '45454545454')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-mes1', 'mes1', 'p1', date('now', '-90 days'), 'ativa')` });
  // Mensalidade do mês anterior (vencida) + a do mês corrente.
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-mes-ant', 'mes1', 'm-mes1', 7000, 'atrasado', 'recorrencia', 'Mensalidade - MUSCULAÇÃO', date('now', 'start of month', '-1 day', 'start of month', '+9 days'))` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-mes-cor', 'mes1', 'm-mes1', 7000, 'pendente', 'recorrencia', 'Mensalidade - MUSCULAÇÃO', date('now'))` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);

  let d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'mes1', baseUrl: 'https://academia.test' });
  assert.strictEqual(d.disponivel, false);
  assert.strictEqual(d.motivo, 'mensalidades_anteriores');
  assert.deepStrictEqual(d.mensalidades_anteriores.map((c) => c.id), ['c-mes-ant']);
  assert.strictEqual(d.total_anteriores_centavos, 7000);
  // O servidor também recusa (painel e portal), com mensagem clara.
  await assert.rejects(() => assinaturas.obterOuCriarParaAluno({ alunoId: 'mes1', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' }), /mês anterior em aberto/);

  // Pagou a de mês anterior por Pix: o cartão volta, e a cobrança cobre a do mês corrente.
  await db.execute({ sql: `UPDATE cobrancas SET status = 'pago' WHERE id = 'c-mes-ant'` });
  d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'mes1', baseUrl: 'https://academia.test' });
  assert.strictEqual(d.disponivel, true);
});

test('cartão automático nunca baixa conta de serviço/produto, mesmo mais antiga que a mensalidade', async () => {
  await db.execute({ sql: `INSERT INTO alunos (id, nome, email, cpf) VALUES ('serv1', 'Aluno Serv', 'serv@teste.com', '46464646464')` });
  await db.execute({ sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status) VALUES ('m-serv1', 'serv1', 'p1', date('now', '-30 days'), 'ativa')` });
  // Serviço atrasado (mês anterior) ligado à matrícula + mensalidade do mês corrente.
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-serv', 'serv1', 'm-serv1', 15978, 'atrasado', 'manual', 'Serviço - Avaliação adipometria+postural', date('now', '-40 days'))` });
  await db.execute({ sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento) VALUES ('c-mens', 'serv1', 'm-serv1', 7000, 'pendente', 'recorrencia', 'Mensalidade - MUSCULAÇÃO', date('now'))` });
  await assinaturas.salvarPlanosCadastro([{ id: 'mensal_livre', nome: 'Mensal', valor_centavos: 7000, limite_cobrancas: null, ativo: true }]);

  // O serviço de mês anterior não bloqueia o cartão (só mensalidades contam).
  const d = await assinaturas.disponibilidadeParaAluno({ alunoId: 'serv1', baseUrl: 'https://academia.test' });
  assert.strictEqual(d.disponivel, true);
  await assinaturas.obterOuCriarParaAluno({ alunoId: 'serv1', baseUrl: 'https://academia.test', modalidade: 'mensal_livre' });
  const { id, preapproval_id: pre } = (await db.execute({ sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE matricula_id='m-serv1'`, args: [] })).rows[0];
  estadoMp.assinaturas[pre].status = 'authorized';
  estadoMp.pagamentosRef = { ...(estadoMp.pagamentosRef || {}), [id]: [{ id: 9701, status: 'approved', transaction_amount: 70, payment_type_id: 'credit_card' }] };
  estadoMp.cobrancas = { ...(estadoMp.cobrancas || {}), [pre]: [] };
  await assinaturas.sincronizarAgora({ assinaturaId: id });
  const st = Object.fromEntries((await db.execute({ sql: `SELECT id, status, valor_centavos FROM cobrancas WHERE id IN ('c-serv','c-mens')`, args: [] })).rows.map((r) => [r.id, [r.status, Number(r.valor_centavos)]]));
  assert.deepStrictEqual(st['c-serv'], ['atrasado', 15978]); // o serviço continua aberto, com o valor original
  assert.deepStrictEqual(st['c-mens'], ['pago', 7000]);      // a mensalidade do mês é a quitada
});
