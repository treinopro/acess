/**
 * Produtos e Serviços (2026-08-14) — catálogo separado de "planos" de
 * propósito: plano é a mensalidade/matrícula que controla acesso (atraso
 * bloqueia a catraca); produto/serviço é uma venda avulsa que gera cobrança
 * normal em Contas a Receber, mas NUNCA bloqueia acesso. Isso funciona sem
 * mexer em nenhuma regra de autorização porque a cobrança criada aqui
 * sempre tem matricula_id NULL, e toda checagem de atraso já filtra
 * "matricula_id IS NOT NULL" (ver acessoTerminal.service.js).
 */
const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const produtoServicoSchema = z.object({
  nome: z.string().min(2),
  tipo: z.enum(['produto', 'servico']),
  valor_centavos: z.number().int().positive(),
  duracao_dias: z.number().int().positive().optional().nullable(),
});

// GET /api/produtos-servicos?todos=1 — por padrão só ativos
router.get('/', async (req, res, next) => {
  try {
    const sql = req.query.todos
      ? 'SELECT * FROM produtos_servicos ORDER BY ativo DESC, nome'
      : 'SELECT * FROM produtos_servicos WHERE ativo = 1 ORDER BY nome';
    const result = await db.execute(sql);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const dados = produtoServicoSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: 'INSERT INTO produtos_servicos (id, nome, tipo, valor_centavos, duracao_dias) VALUES (?, ?, ?, ?, ?)',
      args: [id, dados.nome, dados.tipo, dados.valor_centavos, dados.duracao_dias || null],
    });
    res.status(201).json({ id, ...dados });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const dados = produtoServicoSchema.parse(req.body);
    const result = await db.execute({
      sql: 'UPDATE produtos_servicos SET nome = ?, tipo = ?, valor_centavos = ?, duracao_dias = ? WHERE id = ?',
      args: [dados.nome, dados.tipo, dados.valor_centavos, dados.duracao_dias || null, req.params.id],
    });
    if (result.rowsAffected === 0) return res.status(404).json({ erro: 'Produto/serviço não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/desativar', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE produtos_servicos SET ativo = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/reativar', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE produtos_servicos SET ativo = 1 WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/produtos-servicos/:id — bloqueado se houver vendas vinculadas (mesmo padrão de planos/matrículas)
router.delete('/:id', async (req, res, next) => {
  try {
    const vinculos = await db.execute({
      sql: 'SELECT COUNT(*) as total FROM vendas_produtos_servicos WHERE produto_servico_id = ?',
      args: [req.params.id],
    });
    if (Number(vinculos.rows[0].total) > 0) {
      return res.status(409).json({
        erro: 'Este item tem vendas vinculadas e não pode ser excluído. Desative-o em vez de excluir.',
      });
    }
    await db.execute({ sql: 'DELETE FROM produtos_servicos WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/produtos-servicos/vender { aluno_id, produto_servico_id, data_inicio, vencimento_cobranca? }
// Cria a venda + a cobrança correspondente (matricula_id sempre NULL — ver
// comentário no topo do arquivo). vencimento_cobranca é opcional (senão usa
// data_inicio, mesmo padrão de "Incluir conta").
router.post('/vender', async (req, res, next) => {
  try {
    const schema = z.object({
      aluno_id: z.string(),
      produto_servico_id: z.string(),
      data_inicio: z.string(),
      vencimento_cobranca: z.string().optional(),
    });
    const dados = schema.parse(req.body);

    const item = await db.execute({ sql: 'SELECT * FROM produtos_servicos WHERE id = ?', args: [dados.produto_servico_id] });
    if (!item.rows[0]) return res.status(404).json({ erro: 'Produto/serviço não encontrado.' });
    const produtoServico = item.rows[0];

    const dataVencimento = produtoServico.duracao_dias
      ? new Date(new Date(dados.data_inicio).getTime() + produtoServico.duracao_dias * 86400000).toISOString().slice(0, 10)
      : null;

    const cobrancaId = uuid();
    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento)
            VALUES (?, ?, NULL, ?, 'pendente', 'manual', ?, ?)`,
      args: [
        cobrancaId, dados.aluno_id, produtoServico.valor_centavos,
        `${produtoServico.tipo === 'servico' ? 'Serviço' : 'Produto'} - ${produtoServico.nome}`,
        dados.vencimento_cobranca || dados.data_inicio,
      ],
    });

    const vendaId = uuid();
    await db.execute({
      sql: `INSERT INTO vendas_produtos_servicos
              (id, aluno_id, produto_servico_id, nome_produto_servico, cobranca_id, data_inicio, data_vencimento, criado_por)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        vendaId, dados.aluno_id, dados.produto_servico_id, produtoServico.nome,
        cobrancaId, dados.data_inicio, dataVencimento, req.usuario?.id || null,
      ],
    });

    res.status(201).json({ id: vendaId, cobranca_id: cobrancaId, data_vencimento: dataVencimento });
  } catch (err) {
    next(err);
  }
});

// GET /api/produtos-servicos/vendas?aluno_id=... — histórico de vendas; sem
// aluno_id, lista todas (mais recentes primeiro, limitado a 200 — tela
// "Vendas recentes" em Produtos e Serviços).
router.get('/vendas', async (req, res, next) => {
  try {
    const { aluno_id: alunoId } = req.query;
    const base = `SELECT v.*, a.nome as aluno_nome, c.status as cobranca_status, c.valor_centavos as cobranca_valor_centavos
            FROM vendas_produtos_servicos v
            JOIN alunos a ON a.id = v.aluno_id
            LEFT JOIN cobrancas c ON c.id = v.cobranca_id`;
    const result = alunoId
      ? await db.execute({ sql: `${base} WHERE v.aluno_id = ? ORDER BY v.data_inicio DESC`, args: [alunoId] })
      : await db.execute(`${base} ORDER BY v.data_inicio DESC LIMIT 200`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/produtos-servicos/pendencias — serviços vencidos ainda não resolvidos
// (consumido pela tela de Pendências, ver src/routes/pendencias.routes.js).
// Exportado como função também pra reaproveitar sem round-trip HTTP.
async function listarPendenciasServicosVencidos() {
  const result = await db.execute(`
    SELECT v.id, v.aluno_id, a.nome as aluno_nome, v.nome_produto_servico, v.data_vencimento
    FROM vendas_produtos_servicos v
    JOIN alunos a ON a.id = v.aluno_id
    WHERE v.data_vencimento IS NOT NULL AND v.data_vencimento < date('now') AND v.pendencia_resolvida_em IS NULL
    ORDER BY v.data_vencimento ASC
  `);
  return result.rows;
}

router.get('/pendencias', async (req, res, next) => {
  try {
    res.json(await listarPendenciasServicosVencidos());
  } catch (err) {
    next(err);
  }
});

// PATCH /api/produtos-servicos/vendas/:id/resolver-pendencia — professor marcou como tratado (ex.: renovou, conversou com o aluno)
router.patch('/vendas/:id/resolver-pendencia', async (req, res, next) => {
  try {
    await db.execute({
      sql: "UPDATE vendas_produtos_servicos SET pendencia_resolvida_em = datetime('now') WHERE id = ?",
      args: [req.params.id],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, listarPendenciasServicosVencidos };
