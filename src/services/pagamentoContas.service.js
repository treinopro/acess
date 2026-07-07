/**
 * Pagamento agregado de contas em atraso (uma cobrança OU várias, num único
 * Pix). Compartilhado entre o totem físico (terminal.routes.js, que libera a
 * catraca ao confirmar) e o portal remoto (portal.routes.js, que NUNCA libera
 * a catraca) — a única diferença entre os dois é o valor de `liberarAcesso`
 * passado na criação, guardado junto com o pagamento; o resto do fluxo
 * (consulta, geração do Pix, confirmação, quitação das cobranças) é idêntico.
 */

const { v4: uuid } = require('uuid');
const db = require('./../db/client');
const mercadopago = require('./payment/mercadopago.service');
const acessoTerminal = require('./acessoTerminal.service');

/** Lista as contas em aberto (pendente/atrasado) de um aluno pelo CPF. */
async function consultarContasAbertas(cpf) {
  const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
  if (!aluno) return null;

  const result = await db.execute({
    sql: `SELECT id, descricao, valor_centavos, vencimento, status FROM cobrancas
          WHERE aluno_id = ? AND status IN ('pendente', 'atrasado')
          ORDER BY vencimento ASC`,
    args: [aluno.id],
  });

  return { aluno, contas: result.rows };
}

/**
 * Gera um pagamento Pix agregado cobrindo as cobrancaIds informadas (todas
 * precisam pertencer ao mesmo aluno e estar em aberto). liberarAcesso decide
 * se, ao confirmar o pagamento, deve tentar abrir a catraca também.
 */
async function criarPagamentoAgregado({ cpf, cobrancaIds, liberarAcesso }) {
  const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
  if (!aluno) throw Object.assign(new Error('CPF não encontrado.'), { status: 404 });

  const placeholders = cobrancaIds.map(() => '?').join(', ');
  const contas = await db.execute({
    sql: `SELECT * FROM cobrancas WHERE aluno_id = ? AND id IN (${placeholders}) AND status IN ('pendente', 'atrasado')`,
    args: [aluno.id, ...cobrancaIds],
  });
  if (contas.rows.length === 0) {
    throw Object.assign(new Error('Nenhuma das contas informadas está em aberto para este CPF.'), { status: 404 });
  }
  if (contas.rows.length !== cobrancaIds.length) {
    throw Object.assign(new Error('Uma ou mais contas selecionadas já não estão mais em aberto. Atualize a lista e tente de novo.'), { status: 409 });
  }

  const valorTotalCentavos = contas.rows.reduce((soma, c) => soma + Number(c.valor_centavos), 0);
  const pagamentoId = uuid();
  const descricao = contas.rows.length === 1
    ? contas.rows[0].descricao || 'Conta em atraso'
    : `${contas.rows.length} contas em atraso`;

  const emailTeste = process.env.MERCADOPAGO_TEST_PAYER_EMAIL;
  const emailPagador = emailTeste || aluno.email || `aluno-${String(aluno.cpf).replace(/\D/g, '')}@academia-gestao.com`;
  const firstNamePagador = emailTeste ? 'APRO' : undefined;

  const order = await mercadopago.criarOrderPix({
    descricao,
    valorCentavos: valorTotalCentavos,
    referenciaExterna: pagamentoId,
    email: emailPagador,
    firstName: firstNamePagador,
  });
  const metodoPix = order.transactions?.payments?.[0]?.payment_method || {};

  await db.execute({
    sql: `INSERT INTO pagamentos_totem (id, aluno_id, cobranca_ids, valor_centavos, provedor, provedor_referencia, liberar_acesso)
          VALUES (?, ?, ?, ?, 'mercadopago', ?, ?)`,
    args: [pagamentoId, aluno.id, JSON.stringify(cobrancaIds), valorTotalCentavos, String(order.id), liberarAcesso ? 1 : 0],
  });

  return {
    pagamento_id: pagamentoId,
    qr_code_pix: metodoPix.qr_code || null,
    qr_code_pix_imagem: metodoPix.qr_code_base64 || null,
    valor_centavos: valorTotalCentavos,
    aluno_nome: aluno.nome,
    contas: contas.rows.map((c) => ({ id: c.id, descricao: c.descricao, valor_centavos: c.valor_centavos, vencimento: c.vencimento })),
  };
}

/**
 * Consulta/confirma o status de um pagamento agregado. Quando aprovado, quita
 * (idempotente) todas as cobrancas cobertas — com registro em
 * pagamentos_cobranca, pro histórico/relatórios ficarem consistentes com um
 * pagamento lançado manualmente — e, só se o pagamento foi criado com
 * liberarAcesso=true, tenta abrir a catraca.
 */
async function consultarStatusPagamento(pagamentoId) {
  const result = await db.execute({ sql: 'SELECT * FROM pagamentos_totem WHERE id = ?', args: [pagamentoId] });
  let p = result.rows[0];
  if (!p) throw Object.assign(new Error('Pagamento não encontrado.'), { status: 404 });

  if (p.status !== 'pago') {
    try {
      const order = await mercadopago.consultarOrder(p.provedor_referencia);
      const pagamentoOrder = order.transactions?.payments?.[0] || {};
      const aprovado = order.status === 'processed' || pagamentoOrder.status === 'approved';
      if (aprovado) {
        await db.execute({ sql: `UPDATE pagamentos_totem SET status = 'pago' WHERE id = ?`, args: [p.id] });
        p = { ...p, status: 'pago' };
      }
    } catch (err) {
      // Falha pontual na consulta não interrompe o polling — quem chama tenta de novo.
    }
  }

  if (p.status !== 'pago') return { pago: false };

  const cobrancaIds = JSON.parse(p.cobranca_ids);
  const hoje = new Date().toISOString().slice(0, 10);

  const itens = [];
  for (const cobrancaId of cobrancaIds) {
    const cobrancaResult = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [cobrancaId] });
    const cobranca = cobrancaResult.rows[0];
    if (!cobranca) continue;
    itens.push({ id: cobranca.id, descricao: cobranca.descricao, valor_centavos: cobranca.valor_centavos });
    if (cobranca.status === 'pago') continue; // já quitada num poll anterior — idempotente

    await db.execute({
      sql: `INSERT INTO pagamentos_cobranca (id, cobranca_id, data, valor_centavos, tipo, conta_corrente)
            VALUES (?, ?, ?, ?, 'pix', NULL)`,
      args: [uuid(), cobranca.id, hoje, cobranca.valor_centavos],
    });
    await db.execute({
      sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = 'pix', pago_em = datetime('now') WHERE id = ?`,
      args: [cobranca.id],
    });
  }

  const alunoResult = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [p.aluno_id] });
  const aluno = alunoResult.rows[0];
  if (!aluno) throw Object.assign(new Error('Aluno não encontrado.'), { status: 404 });

  let autorizado = null;
  let motivo = null;
  if (p.liberar_acesso) {
    const resultadoLiberacao = await acessoTerminal.tentarLiberar({ aluno, metodo: 'pagamento_contas' });
    autorizado = resultadoLiberacao.autorizado;
    motivo = resultadoLiberacao.motivo;
  }

  return {
    pago: true,
    autorizado,
    motivo,
    aluno_nome: aluno.nome,
    valor_centavos: p.valor_centavos,
    itens,
    pago_em: new Date().toISOString(),
  };
}

module.exports = { consultarContasAbertas, criarPagamentoAgregado, consultarStatusPagamento };
