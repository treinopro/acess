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

    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento, metodo_pagamento, pago_em)
            VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.matricula_id || null, dados.valor_centavos, dados.status,
        dados.descricao, dados.vencimento || null, dados.metodo_pagamento || null,
        dados.status === 'pago' ? new Date().toISOString() : null],
    });

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// GET /api/pagamentos/cobrancas?aluno_id=&status= — busca/lista contas a receber
router.get('/cobrancas', autenticar, async (req, res, next) => {
  try {
    const { aluno_id: alunoId, status } = req.query;
    const condicoes = [];
    const args = [];
    if (alunoId) { condicoes.push('c.aluno_id = ?'); args.push(alunoId); }
    if (status) { condicoes.push('c.status = ?'); args.push(status); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const result = await db.execute({
      sql: `SELECT c.*, a.nome as aluno_nome FROM cobrancas c
            JOIN alunos a ON a.id = c.aluno_id
            ${where}
            ORDER BY c.criado_em DESC`,
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
