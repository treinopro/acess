const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');
const mercadopago = require('../services/payment/mercadopago.service');
const infinitepay = require('../services/payment/infinitepay.service');

const router = express.Router();

// POST /api/pagamentos/cobrar  { aluno_id, matricula_id, valor_centavos, provedor }
// Cria a cobrança no banco e gera o link de pagamento no provedor escolhido
// (ou no provedor padrão definido em PAYMENT_PROVIDER).
router.post('/cobrar', autenticar, async (req, res, next) => {
  try {
    const schema = z.object({
      aluno_id: z.string(),
      matricula_id: z.string().optional().nullable(),
      valor_centavos: z.number().int().positive(),
      descricao: z.string().default('Mensalidade'),
      vencimento: z.string().optional().nullable(),
      provedor: z.enum(['mercadopago', 'infinitepay']).optional(),
    });
    const dados = schema.parse(req.body);
    const provedor = dados.provedor || process.env.PAYMENT_PROVIDER || 'mercadopago';
    const id = uuid();

    let linkPagamento;
    if (provedor === 'mercadopago') {
      const pref = await mercadopago.criarPreferencia({
        titulo: dados.descricao,
        valorCentavos: dados.valor_centavos,
        referenciaExterna: id,
        urlRetorno: process.env.APP_URL || 'http://localhost:3000',
      });
      linkPagamento = pref.init_point;
    } else {
      const link = await infinitepay.criarLinkPagamento({
        descricao: dados.descricao,
        valorCentavos: dados.valor_centavos,
        orderNsu: id,
        redirectUrl: process.env.APP_URL || 'http://localhost:3000',
      });
      linkPagamento = link.url || link.checkout_url;
    }

    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, provedor, provedor_referencia, descricao, vencimento)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.matricula_id || null, dados.valor_centavos, provedor, id,
        dados.descricao, dados.vencimento || null],
    });

    res.status(201).json({ id, link_pagamento: linkPagamento, provedor });
  } catch (err) {
    next(err);
  }
});

// POST /api/pagamentos/cobrancas — conta a receber manual (sem gerar link de gateway;
// útil para pagamento em dinheiro, boleto físico ou valores já recebidos por fora).
router.post('/cobrancas', autenticar, async (req, res, next) => {
  try {
    const schema = z.object({
      aluno_id: z.string(),
      matricula_id: z.string().optional().nullable(),
      valor_centavos: z.number().int().positive(),
      descricao: z.string().default('Mensalidade'),
      vencimento: z.string().optional().nullable(),
      status: z.enum(['pendente', 'pago', 'atrasado', 'cancelado', 'estornado']).default('pendente'),
      metodo_pagamento: z.string().optional().nullable(),
    });
    const dados = schema.parse(req.body);
    const id = uuid();
    const agora = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento, metodo_pagamento, pago_em)
            VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.matricula_id || null, dados.valor_centavos, dados.status,
        dados.descricao, dados.vencimento || null, dados.metodo_pagamento || null,
        dados.status === 'pago' ? agora : null],
    });

    // Se a conta já nasce quitada, registra também um pagamento (mantém o histórico da
    // aba "Pagamentos" consistente com o que seria criado pelo fluxo normal de quitação).
    if (dados.status === 'pago') {
      await db.execute({
        sql: `INSERT INTO pagamentos_cobranca (id, cobranca_id, data, valor_centavos, tipo, conta_corrente)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [uuid(), id, agora.slice(0, 10), dados.valor_centavos, dados.metodo_pagamento || 'manual', null],
      });
    }

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// GET /api/pagamentos/cobrancas?aluno_id=&status=&busca=&vencimento_de=&vencimento_ate=&ordenar_por=&decrescente=&incluir_inativos=
// busca/lista contas a receber (busca = filtro por nome do aluno). Os parâmetros de
// vencimento/ordenação são usados pelo relatório "Contas a Receber" (Relatórios > Financeiro),
// mas funcionam em qualquer chamada — inclusive a tela normal de Contas a Receber, que
// simplesmente não os envia. Por padrão só traz cobranças de alunos com status='ativo';
// passe incluir_inativos=true (checkbox "mostrar inativos") pra incluir todo mundo. Quando
// aluno_id é informado (tela do próprio aluno) não filtra por status do aluno.
router.get('/cobrancas', autenticar, async (req, res, next) => {
  try {
    const {
      aluno_id: alunoId, status, busca,
      vencimento_de: vencimentoDe, vencimento_ate: vencimentoAte,
      ordenar_por: ordenarPor, decrescente, incluir_inativos: incluirInativos,
    } = req.query;
    const condicoes = [];
    const args = [];
    if (alunoId) { condicoes.push('c.aluno_id = ?'); args.push(alunoId); }
    else if (!(incluirInativos === 'true' || incluirInativos === '1')) { condicoes.push("a.status = 'ativo'"); }
    if (status) { condicoes.push('c.status = ?'); args.push(status); }
    if (busca) { condicoes.push('a.nome LIKE ?'); args.push(`%${busca}%`); }
    if (vencimentoDe) { condicoes.push('c.vencimento >= ?'); args.push(vencimentoDe); }
    if (vencimentoAte) { condicoes.push('c.vencimento <= ?'); args.push(vencimentoAte); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const colunasOrdenacao = { vencimento: 'c.vencimento', valor: 'c.valor_centavos', aluno: 'a.nome', status: 'c.status' };
    const colunaOrdenacao = colunasOrdenacao[ordenarPor] || 'c.criado_em';
    const direcao = decrescente === 'true' || decrescente === '1' ? 'DESC' : (ordenarPor ? 'ASC' : 'DESC');

    const result = await db.execute({
      sql: `SELECT c.*, a.nome as aluno_nome,
              (SELECT COALESCE(SUM(p.valor_centavos), 0) FROM pagamentos_cobranca p WHERE p.cobranca_id = c.id) as valor_pago_centavos,
              (SELECT MAX(p.data) FROM pagamentos_cobranca p WHERE p.cobranca_id = c.id) as data_pago_calc
            FROM cobrancas c
            JOIN alunos a ON a.id = c.aluno_id
            ${where}
            ORDER BY ${colunaOrdenacao} ${direcao}`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PUT /api/pagamentos/cobrancas/:id — edição manual (valor, descrição, vencimento, status)
router.put('/cobrancas/:id', autenticar, async (req, res, next) => {
  try {
    const schema = z.object({
      valor_centavos: z.number().int().positive().optional(),
      descricao: z.string().optional(),
      vencimento: z.string().optional().nullable(),
      status: z.enum(['pendente', 'pago', 'atrasado', 'cancelado', 'estornado']).optional(),
      metodo_pagamento: z.string().optional().nullable(),
    });
    const dados = schema.parse(req.body);
    const campos = Object.keys(dados);
    if (campos.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    if (dados.status === 'pago') {
      campos.push('pago_em');
      dados.pago_em = new Date().toISOString();
    }

    const sets = campos.map((c) => `${c} = ?`).join(', ');
    const args = [...campos.map((c) => dados[c]), req.params.id];

    const result = await db.execute({ sql: `UPDATE cobrancas SET ${sets} WHERE id = ?`, args });
    if (result.rowsAffected === 0) return res.status(404).json({ erro: 'Cobrança não encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/pagamentos/cobrancas/:id
router.delete('/cobrancas/:id', autenticar, async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- Pagamentos de uma conta (parcial/parcelado, estilo Secullum) ----------------
// Uma conta pode receber vários pagamentos (dinheiro, pix, cartão...) até a soma bater
// o valor total, momento em que ela é marcada como quitada automaticamente.

async function buscarCobranca(id) {
  const result = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [id] });
  return result.rows[0] || null;
}

// Recalcula o total já pago e ajusta o status da conta (quita ou volta a pendente/atrasado).
async function recalcularStatusCobranca(cobrancaId) {
  const cobranca = await buscarCobranca(cobrancaId);
  if (!cobranca) return null;

  const somaResult = await db.execute({
    sql: `SELECT COALESCE(SUM(valor_centavos), 0) as total, MAX(data) as ultima_data
          FROM pagamentos_cobranca WHERE cobranca_id = ?`,
    args: [cobrancaId],
  });
  const { total, ultima_data: ultimaData } = somaResult.rows[0];

  // Não mexe em contas canceladas/estornadas — só no ciclo pendente/atrasado/pago.
  if (cobranca.status === 'cancelado' || cobranca.status === 'estornado') {
    return { ...cobranca, valor_pago_centavos: total };
  }

  if (Number(total) >= cobranca.valor_centavos) {
    await db.execute({
      sql: `UPDATE cobrancas SET status = 'pago', pago_em = ? WHERE id = ?`,
      args: [ultimaData, cobrancaId],
    });
  } else {
    const vencida = cobranca.vencimento && cobranca.vencimento < new Date().toISOString().slice(0, 10);
    await db.execute({
      sql: `UPDATE cobrancas SET status = ?, pago_em = NULL WHERE id = ?`,
      args: [vencida ? 'atrasado' : 'pendente', cobrancaId],
    });
  }

  return { ...(await buscarCobranca(cobrancaId)), valor_pago_centavos: total };
}

// GET /api/pagamentos/cobrancas/:id/pagamentos — lista os pagamentos registrados de uma conta
router.get('/cobrancas/:id/pagamentos', autenticar, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM pagamentos_cobranca WHERE cobranca_id = ? ORDER BY data ASC, criado_em ASC',
      args: [req.params.id],
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/pagamentos/cobrancas/:id/pagamentos { data, valor_centavos, tipo, conta_corrente }
// Registra um pagamento (total ou parcial). Quando a soma bate o valor da conta, ela é
// quitada automaticamente.
router.post('/cobrancas/:id/pagamentos', autenticar, async (req, res, next) => {
  try {
    const cobranca = await buscarCobranca(req.params.id);
    if (!cobranca) return res.status(404).json({ erro: 'Conta não encontrada.' });

    const schema = z.object({
      data: z.string(),
      valor_centavos: z.number().int().positive(),
      tipo: z.string().optional().nullable(),
      conta_corrente: z.string().optional().nullable(),
    });
    const dados = schema.parse(req.body);
    const id = uuid();

    await db.execute({
      sql: `INSERT INTO pagamentos_cobranca (id, cobranca_id, data, valor_centavos, tipo, conta_corrente)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.id, dados.data, dados.valor_centavos, dados.tipo || null, dados.conta_corrente || null],
    });

    const cobrancaAtualizada = await recalcularStatusCobranca(req.params.id);
    res.status(201).json({ id, cobranca: cobrancaAtualizada });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/pagamentos/cobrancas/:id/pagamentos/:pagamentoId — remove um pagamento
// lançado indevidamente e recalcula o status da conta (pode voltar a pendente/atrasado).
router.delete('/cobrancas/:id/pagamentos/:pagamentoId', autenticar, async (req, res, next) => {
  try {
    await db.execute({
      sql: 'DELETE FROM pagamentos_cobranca WHERE id = ? AND cobranca_id = ?',
      args: [req.params.pagamentoId, req.params.id],
    });
    const cobrancaAtualizada = await recalcularStatusCobranca(req.params.id);
    res.json({ ok: true, cobranca: cobrancaAtualizada });
  } catch (err) {
    next(err);
  }
});

// POST /api/pagamentos/cobrancas/:id/remover-quitacao — desfaz a quitação (volta a
// conta para pendente/atrasado) sem apagar o histórico de pagamentos já lançados.
router.post('/cobrancas/:id/remover-quitacao', autenticar, async (req, res, next) => {
  try {
    const cobranca = await buscarCobranca(req.params.id);
    if (!cobranca) return res.status(404).json({ erro: 'Conta não encontrada.' });

    const vencida = cobranca.vencimento && cobranca.vencimento < new Date().toISOString().slice(0, 10);
    await db.execute({
      sql: `UPDATE cobrancas SET status = ?, pago_em = NULL WHERE id = ?`,
      args: [vencida ? 'atrasado' : 'pendente', req.params.id],
    });

    res.json({ ok: true, cobranca: await buscarCobranca(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// ---------------- Parcelamento de contas (estilo Secullum "Parcelar Conta" / "Incluir Conta Parcelada") ----------------

// Gera o array de parcelas (data + valor) a partir dos parâmetros do parcelamento.
// Mesma lógica é replicada no front (app.js) só para a "Prévia" instantânea sem round-trip;
// esta função aqui é a que efetivamente vale pra gravar no banco.
function gerarParcelas({
  valorTotalCentavos, numParcelas, dataPrimeiraParcela, diaVencimento,
  valorPrimeiraEspecialCentavos, taxaJurosPercentual, tipoJuros, arredondar,
}) {
  const temPrimeiraEspecial = valorPrimeiraEspecialCentavos != null;
  const restante = temPrimeiraEspecial ? valorTotalCentavos - valorPrimeiraEspecialCentavos : valorTotalCentavos;
  const qtdRestantes = temPrimeiraEspecial ? numParcelas - 1 : numParcelas;
  const valorBase = qtdRestantes > 0 ? restante / qtdRestantes : restante;
  const taxa = (taxaJurosPercentual || 0) / 100;

  const parcelas = [];
  for (let i = 0; i < numParcelas; i++) {
    let valor;
    if (i === 0 && temPrimeiraEspecial) {
      valor = valorPrimeiraEspecialCentavos;
    } else {
      valor = taxa > 0
        ? (tipoJuros === 'composto' ? valorBase * Math.pow(1 + taxa, i) : valorBase * (1 + taxa * i))
        : valorBase;
    }
    valor = arredondar ? Math.round(valor / 100) * 100 : Math.round(valor);

    const data = new Date(`${dataPrimeiraParcela}T00:00:00`);
    data.setMonth(data.getMonth() + i);
    if (diaVencimento) data.setDate(Math.min(diaVencimento, 28)); // evita rolar de mês em fev/abr/etc
    parcelas.push({ data: data.toISOString().slice(0, 10), valor_centavos: valor });
  }

  // A soma dos arredondamentos pode ficar alguns centavos longe do total — a última
  // parcela absorve a diferença pra fechar exatamente o valor da conta.
  const soma = parcelas.reduce((acc, p) => acc + p.valor_centavos, 0);
  const diferenca = valorTotalCentavos - soma;
  if (diferenca !== 0) parcelas[parcelas.length - 1].valor_centavos += diferenca;

  return parcelas;
}

const schemaParcelamento = z.object({
  parcelas: z.number().int().min(2).max(60),
  dia_vencimento: z.number().int().min(1).max(28).optional().nullable(),
  data_primeira_parcela: z.string(),
  valor_primeira_especial_centavos: z.number().int().positive().optional().nullable(),
  taxa_juros_percentual: z.number().min(0).max(100).default(0),
  tipo_juros: z.enum(['simples', 'composto']).default('simples'),
  arredondar: z.boolean().default(false),
  lancar_quitadas: z.boolean().default(false),
});

// Insere no banco as cobranças já geradas por gerarParcelas() pra um aluno/matrícula.
async function inserirParcelas({ alunoId, matriculaId, descricaoBase, parcelas, lancarQuitadas }) {
  const criadas = [];
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i];
    const id = uuid();
    const status = lancarQuitadas ? 'pago' : (p.data < new Date().toISOString().slice(0, 10) ? 'atrasado' : 'pendente');
    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento, pago_em)
            VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
      args: [id, alunoId, matriculaId || null, p.valor_centavos, status,
        `${descricaoBase} (parcela ${i + 1}/${parcelas.length})`, p.data, lancarQuitadas ? p.data : null],
    });
    if (lancarQuitadas) {
      await db.execute({
        sql: `INSERT INTO pagamentos_cobranca (id, cobranca_id, data, valor_centavos, tipo, conta_corrente)
              VALUES (?, ?, ?, ?, 'manual', NULL)`,
        args: [uuid(), id, p.data, p.valor_centavos],
      });
    }
    criadas.push({ id, valor_centavos: p.valor_centavos, vencimento: p.data, status });
  }
  return criadas;
}

// POST /api/pagamentos/cobrancas/:id/parcelar — divide uma conta já existente (pendente,
// sem pagamentos lançados) em N parcelas, apagando a conta original.
router.post('/cobrancas/:id/parcelar', autenticar, async (req, res, next) => {
  try {
    const cobranca = await buscarCobranca(req.params.id);
    if (!cobranca) return res.status(404).json({ erro: 'Conta não encontrada.' });

    const somaPagamentos = await db.execute({
      sql: 'SELECT COALESCE(SUM(valor_centavos), 0) as total FROM pagamentos_cobranca WHERE cobranca_id = ?',
      args: [req.params.id],
    });
    if (Number(somaPagamentos.rows[0].total) > 0) {
      return res.status(400).json({ erro: 'Esta conta já tem pagamentos lançados. Remova-os antes de parcelar.' });
    }

    const dados = schemaParcelamento.parse(req.body);
    const parcelas = gerarParcelas({
      valorTotalCentavos: cobranca.valor_centavos,
      numParcelas: dados.parcelas,
      dataPrimeiraParcela: dados.data_primeira_parcela,
      diaVencimento: dados.dia_vencimento,
      valorPrimeiraEspecialCentavos: dados.valor_primeira_especial_centavos,
      taxaJurosPercentual: dados.taxa_juros_percentual,
      tipoJuros: dados.tipo_juros,
      arredondar: dados.arredondar,
    });

    await db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: [req.params.id] });
    const criadas = await inserirParcelas({
      alunoId: cobranca.aluno_id,
      matriculaId: cobranca.matricula_id,
      descricaoBase: cobranca.descricao || 'Mensalidade',
      parcelas,
      lancarQuitadas: dados.lancar_quitadas,
    });

    res.status(201).json({ ok: true, parcelas: criadas });
  } catch (err) {
    next(err);
  }
});

// POST /api/pagamentos/cobrancas/parceladas — cria uma conta já nascendo parcelada
// (equivalente ao "Incluir Conta Parcelada" do Secullum), sem precisar de uma conta prévia.
router.post('/cobrancas/parceladas', autenticar, async (req, res, next) => {
  try {
    const schema = schemaParcelamento.extend({
      aluno_id: z.string(),
      matricula_id: z.string().optional().nullable(),
      descricao: z.string().default('Mensalidade'),
      valor_centavos: z.number().int().positive(),
    });
    const dados = schema.parse(req.body);

    const parcelas = gerarParcelas({
      valorTotalCentavos: dados.valor_centavos,
      numParcelas: dados.parcelas,
      dataPrimeiraParcela: dados.data_primeira_parcela,
      diaVencimento: dados.dia_vencimento,
      valorPrimeiraEspecialCentavos: dados.valor_primeira_especial_centavos,
      taxaJurosPercentual: dados.taxa_juros_percentual,
      tipoJuros: dados.tipo_juros,
      arredondar: dados.arredondar,
    });

    const criadas = await inserirParcelas({
      alunoId: dados.aluno_id,
      matriculaId: dados.matricula_id,
      descricaoBase: dados.descricao,
      parcelas,
      lancarQuitadas: dados.lancar_quitadas,
    });

    res.status(201).json({ ok: true, parcelas: criadas });
  } catch (err) {
    next(err);
  }
});

// Webhook do Mercado Pago (configurar a URL no painel do app / preferência)
// Docs: https://www.mercadopago.com.br/developers/pt/docs/subscriptions/additional-content/your-integrations/notifications/webhooks
router.post('/webhook/mercadopago', express.json(), async (req, res, next) => {
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data?.id) {
      const pagamento = await mercadopago.consultarPagamento(data.id);
      const referenciaExterna = pagamento.external_reference;

      if (pagamento.status === 'approved' && referenciaExterna) {
        await db.execute({
          sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = ?, pago_em = datetime('now')
                WHERE id = ?`,
          args: [pagamento.payment_type_id || null, referenciaExterna],
        });
      }
    }
    res.sendStatus(200); // Mercado Pago espera 200 rapidamente
  } catch (err) {
    next(err);
  }
});

// Webhook da InfinitePay (configurar via INFINITEPAY_WEBHOOK_URL)
// Docs: https://www.infinitepay.io/checkout-documentacao
router.post('/webhook/infinitepay', express.json(), async (req, res, next) => {
  try {
    const { order_nsu, paid_amount, capture_method } = req.body;

    if (order_nsu) {
      await db.execute({
        sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = ?, pago_em = datetime('now')
              WHERE id = ?`,
        args: [capture_method || null, order_nsu],
      });
    }
    res.sendStatus(200); // responder rápido evita reenvio pela InfinitePay
  } catch (err) {
    res.sendStatus(400); // InfinitePay reenvia o webhook em caso de erro 400
  }
});

// GET /api/pagamentos/inadimplentes
router.get('/inadimplentes', autenticar, async (req, res, next) => {
  try {
    const result = await db.execute(`
      SELECT c.*, a.nome as aluno_nome FROM cobrancas c
      JOIN alunos a ON a.id = c.aluno_id
      WHERE c.status IN ('pendente', 'atrasado') AND c.vencimento < date('now')
      ORDER BY c.vencimento
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
