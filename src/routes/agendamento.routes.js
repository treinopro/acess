const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const turmaSchema = z.object({
  nome: z.string().min(2),
  modalidade: z.string().optional().nullable(),
  professor_id: z.string().optional().nullable(),
  capacidade_maxima: z.number().int().positive().default(20),
  dia_semana: z.number().int().min(0).max(6),
  horario_inicio: z.string(),
  horario_fim: z.string(),
});

// ---- Turmas ----
router.get('/turmas', async (req, res, next) => {
  try {
    const result = await db.execute('SELECT * FROM turmas ORDER BY dia_semana, horario_inicio');
    res.json(result.rows);
  } catch (err) { next(err); }
});

router.post('/turmas', async (req, res, next) => {
  try {
    const dados = turmaSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO turmas (id, nome, modalidade, professor_id, capacidade_maxima, dia_semana, horario_inicio, horario_fim)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.nome, dados.modalidade || null, dados.professor_id || null,
        dados.capacidade_maxima, dados.dia_semana, dados.horario_inicio, dados.horario_fim],
    });
    res.status(201).json({ id, ...dados });
  } catch (err) { next(err); }
});

// ---- Agendamentos (marcação de aula pelo aluno) ----

// GET /api/agendamentos?data=YYYY-MM-DD&turma_id=...&incluir_inativos=true — por padrão só
// mostra agendamentos de alunos com status='ativo'; passe incluir_inativos=true (checkbox
// "mostrar inativos") pra ver todos.
router.get('/', async (req, res, next) => {
  try {
    const { data, turma_id: turmaId, incluir_inativos: incluirInativos } = req.query;
    const condicoes = [];
    const args = [];

    if (data) { condicoes.push('ag.data_aula = ?'); args.push(data); }
    if (turmaId) { condicoes.push('ag.turma_id = ?'); args.push(turmaId); }
    if (!(incluirInativos === 'true' || incluirInativos === '1')) { condicoes.push("a.status = 'ativo'"); }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const result = await db.execute({
      sql: `SELECT ag.*, a.nome as aluno_nome, t.nome as turma_nome, t.horario_inicio, t.horario_fim
            FROM agendamentos ag
            JOIN alunos a ON a.id = ag.aluno_id
            JOIN turmas t ON t.id = ag.turma_id
            ${where}
            ORDER BY ag.data_aula, t.horario_inicio`,
      args,
    });
    res.json(result.rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const schema = z.object({
      aluno_id: z.string(),
      turma_id: z.string(),
      data_aula: z.string(),
    });
    const dados = schema.parse(req.body);

    const turma = await db.execute({ sql: 'SELECT * FROM turmas WHERE id = ?', args: [dados.turma_id] });
    if (!turma.rows[0]) return res.status(404).json({ erro: 'Turma não encontrada.' });

    const ocupacao = await db.execute({
      sql: `SELECT COUNT(*) as total FROM agendamentos
            WHERE turma_id = ? AND data_aula = ? AND status = 'marcada'`,
      args: [dados.turma_id, dados.data_aula],
    });

    if (Number(ocupacao.rows[0].total) >= turma.rows[0].capacidade_maxima) {
      return res.status(409).json({ erro: 'Turma lotada para esta data.' });
    }

    const id = uuid();
    await db.execute({
      sql: `INSERT INTO agendamentos (id, aluno_id, turma_id, data_aula) VALUES (?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.turma_id, dados.data_aula],
    });
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.patch('/:id/cancelar', async (req, res, next) => {
  try {
    await db.execute({
      sql: `UPDATE agendamentos SET status = 'cancelada' WHERE id = ?`,
      args: [req.params.id],
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Check-in (catraca / QR code / app / manual) ----
router.post('/checkin', async (req, res, next) => {
  try {
    const schema = z.object({
      aluno_id: z.string(),
      agendamento_id: z.string().optional().nullable(),
      metodo: z.enum(['qrcode', 'catraca', 'biometria', 'app', 'manual']).default('qrcode'),
    });
    const dados = schema.parse(req.body);
    const id = uuid();

    await db.execute({
      sql: `INSERT INTO checkins (id, aluno_id, agendamento_id, metodo) VALUES (?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.agendamento_id || null, dados.metodo],
    });

    if (dados.agendamento_id) {
      await db.execute({
        sql: `UPDATE agendamentos SET status = 'realizada' WHERE id = ?`,
        args: [dados.agendamento_id],
      });
    }

    res.status(201).json({ id });
  } catch (err) { next(err); }
});

module.exports = router;
