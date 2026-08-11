const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const templateSchema = z.object({
  nome: z.string().min(1),
  categoria: z.string().optional().nullable(),
});

const aplicarSchema = z.object({
  aluno_id: z.string().min(1),
  nome: z.string().optional(),
  dias_semana: z.array(z.number().int().min(0).max(6)).optional().default([]),
});

// GET /api/treino-templates — lista os modelos salvos, cada um já com seus
// exercícios (mesmo padrão de GET /api/treinos, evita N+1 do front).
router.get('/', async (req, res, next) => {
  try {
    const templates = await db.execute('SELECT * FROM treino_templates ORDER BY categoria, nome');
    const resultado = [];
    for (const t of templates.rows) {
      const exercicios = await db.execute({
        sql: 'SELECT * FROM treino_template_exercicios WHERE template_id = ? ORDER BY ordem, id',
        args: [t.id],
      });
      resultado.push({ ...t, exercicios: exercicios.rows });
    }
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/treino-templates — cria um modelo vazio ou a partir de uma lista
// de exercícios já pronta (usado pelo botão "Salvar como modelo" na aba
// Treino do perfil, que manda os exercícios do treino atual do aluno).
router.post('/', async (req, res, next) => {
  try {
    const dados = templateSchema.parse(req.body);
    const exerciciosEntrada = Array.isArray(req.body.exercicios) ? req.body.exercicios : [];
    const id = uuid();
    const stmts = [{
      sql: 'INSERT INTO treino_templates (id, nome, categoria) VALUES (?, ?, ?)',
      args: [id, dados.nome, dados.categoria || null],
    }];
    exerciciosEntrada.forEach((ex, idx) => {
      stmts.push({
        sql: `INSERT INTO treino_template_exercicios
                (id, template_id, biblioteca_id, exercicio, series, carga, intervalo, metodo, observacao, dica, video_url, imagem_url, ordem)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [uuid(), id, ex.biblioteca_id || null, ex.exercicio, ex.series || null, ex.carga || null,
          ex.intervalo || null, ex.metodo || null, ex.observacao || null, ex.dica || null,
          ex.video_url || null, ex.imagem_url || null, idx],
      });
    });
    await db.batch(stmts, 'write');
    res.status(201).json({ id, ...dados });
  } catch (err) {
    next(err);
  }
});

// PUT /api/treino-templates/:id — renomeia/recategoriza.
router.put('/:id', async (req, res, next) => {
  try {
    const dados = templateSchema.partial().parse(req.body);
    const campos = Object.keys(dados);
    if (!campos.length) return res.status(400).json({ erro: 'Nenhum campo informado.' });
    const sets = campos.map((c) => `${c} = ?`).join(', ');
    const args = [...campos.map((c) => dados[c]), req.params.id];
    await db.execute({ sql: `UPDATE treino_templates SET ${sets} WHERE id = ?`, args });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/treino-templates/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM treino_templates WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/treino-templates/:id/aplicar { aluno_id, nome?, dias_semana? } —
// copia os exercícios do modelo para um treino novo e independente do
// aluno (editar o treino do aluno depois não altera o modelo, e vice-versa).
router.post('/:id/aplicar', async (req, res, next) => {
  try {
    const dados = aplicarSchema.parse(req.body);
    const template = await db.execute({ sql: 'SELECT * FROM treino_templates WHERE id = ?', args: [req.params.id] });
    if (!template.rows[0]) return res.status(404).json({ erro: 'Modelo não encontrado.' });

    const exercicios = await db.execute({
      sql: 'SELECT * FROM treino_template_exercicios WHERE template_id = ? ORDER BY ordem, id',
      args: [req.params.id],
    });

    const treinoId = uuid();
    const ultimaOrdem = await db.execute({
      sql: 'SELECT COALESCE(MAX(ordem), -1) as maxOrdem FROM treinos WHERE aluno_id = ?',
      args: [dados.aluno_id],
    });
    const ordemTreino = Number(ultimaOrdem.rows[0].maxOrdem) + 1;

    const stmts = [{
      sql: 'INSERT INTO treinos (id, aluno_id, nome, dias_semana, ordem) VALUES (?, ?, ?, ?, ?)',
      args: [treinoId, dados.aluno_id, dados.nome || template.rows[0].nome, JSON.stringify(dados.dias_semana), ordemTreino],
    }];
    exercicios.rows.forEach((ex, idx) => {
      stmts.push({
        sql: `INSERT INTO treino_exercicios
                (id, treino_id, biblioteca_id, exercicio, series, carga, intervalo, metodo, observacao, dica, video_url, imagem_url, ordem)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [uuid(), treinoId, ex.biblioteca_id, ex.exercicio, ex.series, ex.carga, ex.intervalo,
          ex.metodo, ex.observacao, ex.dica, ex.video_url, ex.imagem_url, idx],
      });
    });
    await db.batch(stmts, 'write');
    res.status(201).json({ id: treinoId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
