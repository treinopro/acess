const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const treinoSchema = z.object({
  aluno_id: z.string(),
  nome: z.string().min(1),
  dias_semana: z.array(z.number().int().min(0).max(6)).optional().default([]),
});

const exercicioSchema = z.object({
  exercicio: z.string().min(1),
  series: z.string().optional().nullable(),
  carga: z.string().optional().nullable(),
  intervalo: z.string().optional().nullable(),
  observacao: z.string().optional().nullable(),
  ordem: z.number().int().optional(),
});

function linhaParaTreino(row) {
  let dias = [];
  try {
    dias = row.dias_semana ? JSON.parse(row.dias_semana) : [];
  } catch {
    dias = [];
  }
  return { ...row, dias_semana: dias };
}

// GET /api/treinos?aluno_id=X — lista os treinos do aluno, cada um já com seus
// exercícios (evita N+1 chamada do front pra montar as abas de uma vez).
router.get('/', async (req, res, next) => {
  try {
    const { aluno_id: alunoId } = req.query;
    if (!alunoId) return res.status(400).json({ erro: 'aluno_id é obrigatório.' });

    const treinos = await db.execute({
      sql: `SELECT * FROM treinos WHERE aluno_id = ? AND ativo = 1 ORDER BY ordem, criado_em`,
      args: [alunoId],
    });

    const resultado = [];
    for (const t of treinos.rows) {
      const exercicios = await db.execute({
        sql: `SELECT * FROM treino_exercicios WHERE treino_id = ? ORDER BY ordem, criado_em`,
        args: [t.id],
      });
      resultado.push({ ...linhaParaTreino(t), exercicios: exercicios.rows });
    }
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/treinos { aluno_id, nome, dias_semana }
router.post('/', async (req, res, next) => {
  try {
    const dados = treinoSchema.parse(req.body);
    const id = uuid();
    const ultimaOrdem = await db.execute({
      sql: `SELECT COALESCE(MAX(ordem), -1) as maxOrdem FROM treinos WHERE aluno_id = ?`,
      args: [dados.aluno_id],
    });
    const ordem = Number(ultimaOrdem.rows[0].maxOrdem) + 1;
    await db.execute({
      sql: `INSERT INTO treinos (id, aluno_id, nome, dias_semana, ordem) VALUES (?, ?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.nome, JSON.stringify(dados.dias_semana), ordem],
    });
    res.status(201).json({ id, ...dados, ordem, exercicios: [] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/treinos/:id { nome?, dias_semana?, ordem? }
router.put('/:id', async (req, res, next) => {
  try {
    const dados = treinoSchema.omit({ aluno_id: true }).partial().parse(req.body);
    const campos = Object.keys(dados);
    if (!campos.length) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    const sets = [];
    const args = [];
    if (dados.nome !== undefined) { sets.push('nome = ?'); args.push(dados.nome); }
    if (dados.dias_semana !== undefined) { sets.push('dias_semana = ?'); args.push(JSON.stringify(dados.dias_semana)); }
    args.push(req.params.id);

    await db.execute({ sql: `UPDATE treinos SET ${sets.join(', ')} WHERE id = ?`, args });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/treinos/:id — remove o treino e seus exercícios (cascade).
router.delete('/:id', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM treinos WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/treinos/:id/exercicios — adiciona um exercício ao treino.
router.post('/:id/exercicios', async (req, res, next) => {
  try {
    const dados = exercicioSchema.parse(req.body);
    const id = uuid();
    const ultimaOrdem = await db.execute({
      sql: `SELECT COALESCE(MAX(ordem), -1) as maxOrdem FROM treino_exercicios WHERE treino_id = ?`,
      args: [req.params.id],
    });
    const ordem = dados.ordem ?? (Number(ultimaOrdem.rows[0].maxOrdem) + 1);
    await db.execute({
      sql: `INSERT INTO treino_exercicios (id, treino_id, exercicio, series, carga, intervalo, observacao, ordem)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.id, dados.exercicio, dados.series || null, dados.carga || null,
        dados.intervalo || null, dados.observacao || null, ordem],
    });
    res.status(201).json({ id, treino_id: req.params.id, ...dados, ordem });
  } catch (err) {
    next(err);
  }
});

// PUT /api/treinos/exercicios/:id — edita um exercício.
router.put('/exercicios/:id', async (req, res, next) => {
  try {
    const dados = exercicioSchema.partial().parse(req.body);
    const campos = Object.keys(dados);
    if (!campos.length) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    const sets = campos.map((c) => `${c} = ?`).join(', ');
    const args = [...campos.map((c) => dados[c]), req.params.id];
    await db.execute({ sql: `UPDATE treino_exercicios SET ${sets} WHERE id = ?`, args });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/treinos/exercicios/:id
router.delete('/exercicios/:id', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM treino_exercicios WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
