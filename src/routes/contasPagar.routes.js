// Contas a Pagar (2026-07-28): despesas da própria academia (aluguel, contas
// fixas, fornecedores, folha, etc.) — espelha Contas a Receber (ver
// pagamentos.routes.js), só que do lado de saída do caixa. Alimenta o
// relatório de Balanço (GET /relatorio/balanco) junto com pagamentos_cobranca
// (entradas) e o saldo inicial configurável.
const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar, apenasAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const contaPagarSchema = z.object({
  credor: z.string().min(1),
  descricao: z.string().optional().nullable(),
  valor_centavos: z.number().int().positive(),
  vencimento: z.string().optional().nullable(),
  forma_pagamento: z.string().optional().nullable(),
});

// GET /api/contas-pagar?status=&busca=&vencimento_de=&vencimento_ate=&ordenar_por=&decrescente=
router.get('/', async (req, res, next) => {
  try {
    const {
      status, busca, vencimento_de: vencimentoDe, vencimento_ate: vencimentoAte,
      ordenar_por: ordenarPor, decrescente,
    } = req.query;
    const condicoes = [];
    const args = [];
    if (status) { condicoes.push('status = ?'); args.push(status); }
    if (busca) { condicoes.push('credor LIKE ?'); args.push(`%${busca}%`); }
    if (vencimentoDe) { condicoes.push('vencimento >= ?'); args.push(vencimentoDe); }
    if (vencimentoAte) { condicoes.push('vencimento <= ?'); args.push(vencimentoAte); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const colunasOrdenacao = { vencimento: 'vencimento', valor: 'valor_centavos', credor: 'credor', status: 'status' };
    const colunaOrdenacao = colunasOrdenacao[ordenarPor] || 'vencimento';
    const direcao = decrescente === 'true' || decrescente === '1' ? 'DESC' : 'ASC';

    const result = await db.execute({
      sql: `SELECT * FROM contas_pagar ${where} ORDER BY ${colunaOrdenacao} ${direcao}`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/contas-pagar
router.post('/', async (req, res, next) => {
  try {
    const dados = contaPagarSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO contas_pagar (id, credor, descricao, valor_centavos, vencimento, forma_pagamento)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, dados.credor, dados.descricao || null, dados.valor_centavos, dados.vencimento || null, dados.forma_pagamento || null],
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// PUT /api/contas-pagar/:id — edição (valor/vencimento/etc) e também usado
// pra marcar como paga (status='pago'), preenchendo pago_em automaticamente
// e, se valor_pago_centavos não vier explícito, assumindo o valor cheio da
// conta (mesmo padrão de cobrancas.routes.js pra Contas a Receber).
router.put('/:id', async (req, res, next) => {
  try {
    const schema = z.object({
      credor: z.string().min(1).optional(),
      descricao: z.string().optional().nullable(),
      valor_centavos: z.number().int().positive().optional(),
      vencimento: z.string().optional().nullable(),
      status: z.enum(['pendente', 'pago', 'atrasado', 'cancelado']).optional(),
      forma_pagamento: z.string().optional().nullable(),
      valor_pago_centavos: z.number().int().positive().optional().nullable(),
    });
    const dados = schema.parse(req.body);
    const campos = Object.keys(dados);
    if (campos.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    if (dados.status === 'pago') {
      if (!campos.includes('pago_em')) { campos.push('pago_em'); dados.pago_em = new Date().toISOString(); }
      if (!campos.includes('valor_pago_centavos')) {
        const atual = await db.execute({ sql: 'SELECT valor_centavos FROM contas_pagar WHERE id = ?', args: [req.params.id] });
        if (atual.rows[0]) { campos.push('valor_pago_centavos'); dados.valor_pago_centavos = atual.rows[0].valor_centavos; }
      }
    }

    const sets = campos.map((c) => `${c} = ?`).join(', ');
    const args = [...campos.map((c) => dados[c]), req.params.id];
    const result = await db.execute({ sql: `UPDATE contas_pagar SET ${sets} WHERE id = ?`, args });
    if (result.rowsAffected === 0) return res.status(404).json({ erro: 'Conta não encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contas-pagar/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'DELETE FROM contas_pagar WHERE id = ?', args: [req.params.id] });
    if (result.rowsAffected === 0) return res.status(404).json({ erro: 'Conta não encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- Saldo inicial (admin) ----------------
// Guardado em `configuracoes` (mesma tabela chave/valor de nome_app etc.),
// mas por endpoints próprios aqui (não em config.routes.js) porque GET
// /api/config é PÚBLICO de propósito (a tela de login precisa dele antes de
// autenticar) — não dava pra expor saldo de caixa ali.
router.get('/saldo-inicial', apenasAdmin, async (req, res, next) => {
  try {
    const result = await db.execute("SELECT chave, valor FROM configuracoes WHERE chave IN ('saldo_inicial_centavos', 'saldo_inicial_data')");
    const config = {};
    result.rows.forEach((r) => { config[r.chave] = r.valor; });
    res.json({
      saldo_inicial_centavos: Number(config.saldo_inicial_centavos || 0),
      saldo_inicial_data: config.saldo_inicial_data || null,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/saldo-inicial', apenasAdmin, async (req, res, next) => {
  try {
    const { saldo_inicial_centavos: saldo, saldo_inicial_data: data } = z.object({
      saldo_inicial_centavos: z.number().int(),
      saldo_inicial_data: z.string().min(1),
    }).parse(req.body);
    await db.execute({
      sql: `INSERT INTO configuracoes (chave, valor) VALUES ('saldo_inicial_centavos', ?)
            ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      args: [String(saldo)],
    });
    await db.execute({
      sql: `INSERT INTO configuracoes (chave, valor) VALUES ('saldo_inicial_data', ?)
            ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      args: [data],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- Relatório de Balanço ----------------
// GET /api/contas-pagar/relatorio/balanco?de=&ate= — "de"/"ate" definem o
// PERÍODO do balanço (padrão: mês corrente). Devolve:
//   - saldo_inicial: valor configurado manualmente (ponto de partida)
//   - saldo_atual: saldo_inicial + tudo que já entrou - tudo que já saiu, até
//     HOJE (sempre "agora", independente do período escolhido — é o caixa
//     real neste instante)
//   - recebido_periodo / pago_periodo / resultado_periodo: só o que entrou e
//     saiu DENTRO do período escolhido
//   - previsto_receber / previsto_pagar: cobranças e contas a pagar ainda
//     pendentes/atrasadas com vencimento dentro do período — o que "falta
//     acontecer"
//   - saldo_projetado: saldo_atual + previsto_receber - previsto_pagar — se
//     tudo que está previsto pro período realmente entrar/sair, onde o caixa
//     deve terminar
router.get('/relatorio/balanco', apenasAdmin, async (req, res, next) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const de = req.query.de || `${hoje.slice(0, 7)}-01`;
    const ate = req.query.ate || hoje;

    const configResult = await db.execute("SELECT chave, valor FROM configuracoes WHERE chave IN ('saldo_inicial_centavos', 'saldo_inicial_data')");
    const config = {};
    configResult.rows.forEach((r) => { config[r.chave] = r.valor; });
    const saldoInicialCentavos = Number(config.saldo_inicial_centavos || 0);
    const saldoInicialData = config.saldo_inicial_data || null;

    // "Recebido": pagamentos_cobranca é a fonte real de entrada de caixa;
    // fallback pra cobrancas.pago_em/valor_centavos só quando não existe
    // NENHUMA linha de pagamento pra aquela cobrança (cobranças antigas/
    // legado marcadas pagas direto, sem detalhamento — mesmo padrão já usado
    // em pagamentos.routes.js/GET /cobrancas).
    async function totalRecebido(dataDe, dataAte) {
      const r = await db.execute({
        sql: `SELECT COALESCE(SUM(valor_centavos), 0) as total FROM (
                SELECT p.valor_centavos, date(p.data) as data_efetiva FROM pagamentos_cobranca p
                UNION ALL
                SELECT c.valor_centavos, date(c.pago_em) as data_efetiva FROM cobrancas c
                WHERE c.status = 'pago' AND c.pago_em IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM pagamentos_cobranca p2 WHERE p2.cobranca_id = c.id)
              ) WHERE data_efetiva BETWEEN ? AND ?`,
        args: [dataDe, dataAte],
      });
      return r.rows[0].total;
    }
    async function totalPago(dataDe, dataAte) {
      const r = await db.execute({
        sql: `SELECT COALESCE(SUM(valor_pago_centavos), 0) as total FROM contas_pagar
              WHERE status = 'pago' AND date(pago_em) BETWEEN ? AND ?`,
        args: [dataDe, dataAte],
      });
      return r.rows[0].total;
    }
    async function totalPrevisto(tabela, dataDe, dataAte) {
      const r = await db.execute({
        sql: `SELECT COALESCE(SUM(valor_centavos), 0) as total FROM ${tabela}
              WHERE status IN ('pendente', 'atrasado') AND vencimento BETWEEN ? AND ?`,
        args: [dataDe, dataAte],
      });
      return r.rows[0].total;
    }

    const INICIO_DOS_TEMPOS = '1970-01-01';
    const [
      recebidoTotal, pagoTotal, recebidoPeriodo, pagoPeriodo, previstoReceber, previstoPagar,
    ] = await Promise.all([
      totalRecebido(INICIO_DOS_TEMPOS, hoje),
      totalPago(INICIO_DOS_TEMPOS, hoje),
      totalRecebido(de, ate),
      totalPago(de, ate),
      totalPrevisto('cobrancas', de, ate),
      totalPrevisto('contas_pagar', de, ate),
    ]);

    const saldoAtual = saldoInicialCentavos + recebidoTotal - pagoTotal;

    res.json({
      periodo: { de, ate },
      saldo_inicial_centavos: saldoInicialCentavos,
      saldo_inicial_data: saldoInicialData,
      saldo_atual_centavos: saldoAtual,
      recebido_periodo_centavos: recebidoPeriodo,
      pago_periodo_centavos: pagoPeriodo,
      resultado_periodo_centavos: recebidoPeriodo - pagoPeriodo,
      previsto_receber_centavos: previstoReceber,
      previsto_pagar_centavos: previstoPagar,
      saldo_projetado_centavos: saldoAtual + previstoReceber - previstoPagar,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
