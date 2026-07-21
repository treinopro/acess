const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');
const { criarCobrancaDoCiclo } = require('../services/cobrancas.service');

const router = express.Router();
router.use(autenticar);

const planoSchema = z.object({
  nome: z.string().min(2),
  tipo: z.enum(['mensal', 'trimestral', 'semestral', 'anual', 'avulso', 'pacote_aulas']),
  valor_centavos: z.number().int().positive(),
  duracao_dias: z.number().int().positive().optional().nullable(),
  aulas_incluidas: z.number().int().positive().optional().nullable(),
  // Desconto opcional (ex: "desconto pagamento em dinheiro") — desconto_tipo
  // nulo/ausente significa que o plano não tem desconto configurado.
  desconto_tipo: z.enum(['percentual', 'valor']).optional().nullable(),
  desconto_percentual: z.number().positive().max(100).optional().nullable(),
  desconto_valor_centavos: z.number().int().positive().optional().nullable(),
  desconto_forma_pagamento: z.enum(['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'transferencia', 'boleto', 'outro']).optional().nullable(),
});

// GET /api/planos?todos=1 — por padrão retorna só os ativos; ?todos=1 traz também os desativados
router.get('/', async (req, res, next) => {
  try {
    const sql = req.query.todos
      ? 'SELECT * FROM planos ORDER BY ativo DESC, valor_centavos'
      : 'SELECT * FROM planos WHERE ativo = 1 ORDER BY valor_centavos';
    const result = await db.execute(sql);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const dados = planoSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO planos (id, nome, tipo, valor_centavos, duracao_dias, aulas_incluidas,
              desconto_tipo, desconto_percentual, desconto_valor_centavos, desconto_forma_pagamento)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.nome, dados.tipo, dados.valor_centavos,
        dados.duracao_dias || null, dados.aulas_incluidas || null,
        dados.desconto_tipo || null, dados.desconto_percentual || null,
        dados.desconto_valor_centavos || null, dados.desconto_forma_pagamento || null],
    });
    res.status(201).json({ id, ...dados });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/desativar', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE planos SET ativo = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/reativar', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE planos SET ativo = 1 WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/planos/:id — edição completa do plano
router.put('/:id', async (req, res, next) => {
  try {
    const dados = planoSchema.parse(req.body);
    const result = await db.execute({
      sql: `UPDATE planos SET nome = ?, tipo = ?, valor_centavos = ?, duracao_dias = ?, aulas_incluidas = ?,
              desconto_tipo = ?, desconto_percentual = ?, desconto_valor_centavos = ?, desconto_forma_pagamento = ?
            WHERE id = ?`,
      args: [dados.nome, dados.tipo, dados.valor_centavos,
        dados.duracao_dias || null, dados.aulas_incluidas || null,
        dados.desconto_tipo || null, dados.desconto_percentual || null,
        dados.desconto_valor_centavos || null, dados.desconto_forma_pagamento || null, req.params.id],
    });
    if (result.rowsAffected === 0) return res.status(404).json({ erro: 'Plano não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/planos/:id — exclusão definitiva (bloqueada se houver matrículas vinculadas)
router.delete('/:id', async (req, res, next) => {
  try {
    const vinculos = await db.execute({
      sql: 'SELECT COUNT(*) as total FROM matriculas WHERE plano_id = ?',
      args: [req.params.id],
    });
    if (Number(vinculos.rows[0].total) > 0) {
      return res.status(409).json({
        erro: 'Este plano tem matrículas vinculadas e não pode ser excluído. Desative-o em vez de excluir, ou remova as matrículas primeiro.',
      });
    }
    await db.execute({ sql: 'DELETE FROM planos WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/planos/matricular  { aluno_id, plano_id, data_inicio }
// Bloqueia matrícula duplicada (mesmo aluno + mesmo plano já ativos) e já gera
// a primeira cobrança do ciclo automaticamente — a partir daí, planos recorrentes
// (mensal/trimestral/semestral/anual) seguem gerando as próximas cobranças
// sozinhos via gerarCobrancasRecorrentes (ver src/jobs/recorrencia.js).
router.post('/matricular', async (req, res, next) => {
  try {
    const schema = z.object({
      aluno_id: z.string(),
      plano_id: z.string(),
      data_inicio: z.string(),
      renovacao_automatica: z.boolean().optional(),
    });
    const dados = schema.parse(req.body);
    const id = uuid();

    const plano = await db.execute({ sql: 'SELECT * FROM planos WHERE id = ?', args: [dados.plano_id] });
    if (!plano.rows[0]) return res.status(404).json({ erro: 'Plano não encontrado.' });

    const existente = await db.execute({
      sql: `SELECT id FROM matriculas WHERE aluno_id = ? AND plano_id = ? AND status = 'ativa'`,
      args: [dados.aluno_id, dados.plano_id],
    });
    if (existente.rows[0]) {
      return res.status(409).json({ erro: 'Este aluno já tem uma matrícula ativa neste plano.' });
    }

    const duracao = plano.rows[0].duracao_dias;
    const dataFim = duracao
      ? new Date(new Date(dados.data_inicio).getTime() + duracao * 86400000).toISOString().slice(0, 10)
      : null;

    const renovacaoAutomatica = dados.renovacao_automatica === false ? 0 : 1;

    await db.execute({
      sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, data_fim, renovacao_automatica)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.plano_id, dados.data_inicio, dataFim, renovacaoAutomatica],
    });

    const cobrancaId = await criarCobrancaDoCiclo({
      matriculaId: id,
      alunoId: dados.aluno_id,
      descricao: `Mensalidade - ${plano.rows[0].nome}`,
      valorCentavos: plano.rows[0].valor_centavos,
      vencimento: dados.data_inicio,
    });

    res.status(201).json({ id, data_fim: dataFim, cobranca_id: cobrancaId });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/planos/matriculas/:id/status — cancelar/trancar/reativar uma matrícula.
// Importante para interromper a geração automática de cobranças recorrentes.
router.patch('/matriculas/:id/status', async (req, res, next) => {
  try {
    const status = z.enum(['ativa', 'cancelada', 'trancada', 'expirada']).parse(req.body.status);
    const result = await db.execute({
      sql: 'UPDATE matriculas SET status = ? WHERE id = ?',
      args: [status, req.params.id],
    });
    if (result.rowsAffected === 0) return res.status(404).json({ erro: 'Matrícula não encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/planos/matriculas?aluno_id=...&incluir_inativos=true — lista matrículas
// (todas ou de um aluno). Ao listar todos os alunos, por padrão só mostra quem está com
// status='ativo'; passe incluir_inativos=true (checkbox "mostrar inativos") pra ver todos.
// Quando aluno_id é informado (tela do próprio aluno) não filtra por status.
router.get('/matriculas', async (req, res, next) => {
  try {
    const { aluno_id: alunoId, incluir_inativos: incluirInativos } = req.query;
    const mostrarTodos = incluirInativos === 'true' || incluirInativos === '1';
    const sql = alunoId
      ? `SELECT m.*, a.nome as aluno_nome, p.nome as plano_nome FROM matriculas m
         JOIN alunos a ON a.id = m.aluno_id JOIN planos p ON p.id = m.plano_id
         WHERE m.aluno_id = ? ORDER BY m.data_inicio DESC`
      : `SELECT m.*, a.nome as aluno_nome, p.nome as plano_nome FROM matriculas m
         JOIN alunos a ON a.id = m.aluno_id JOIN planos p ON p.id = m.plano_id
         ${mostrarTodos ? '' : "WHERE a.status = 'ativo'"}
         ORDER BY m.data_inicio DESC`;
    const result = await db.execute({ sql, args: alunoId ? [alunoId] : [] });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
