const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar, apenasAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const exercicioSchema = z.object({
  grupo_muscular: z.string().min(1),
  nome: z.string().min(1),
  video_url: z.string().optional().nullable(),
  imagem_url: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
  equipamento: z.string().optional().nullable(),
  dificuldade: z.enum(['iniciante', 'intermediario', 'avancado']).optional().nullable(),
  instrucoes: z.string().optional().nullable(),
  musculos_secundarios: z.string().optional().nullable(),
});

// GET /api/biblioteca-exercicios — lista completa (uso interno do painel:
// tela "Biblioteca de Exercícios" e o seletor "escolher da biblioteca" ao
// montar um treino). Sem paginação de propósito: são só ~100-300 linhas,
// bem abaixo do que justificaria complicar o front com paginação.
router.get('/', async (req, res, next) => {
  try {
    const resultado = await db.execute(
      'SELECT * FROM exercicio_biblioteca ORDER BY grupo_muscular, nome',
    );
    res.json(resultado.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/biblioteca-exercicios — só admin (a biblioteca é única e global,
// compartilhada por todos os treinos da academia).
router.post('/', apenasAdmin, async (req, res, next) => {
  try {
    const dados = exercicioSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO exercicio_biblioteca
              (id, grupo_muscular, nome, video_url, imagem_url, notas, equipamento, dificuldade, instrucoes, musculos_secundarios)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.grupo_muscular, dados.nome, dados.video_url || null, dados.imagem_url || null,
        dados.notas || null, dados.equipamento || null, dados.dificuldade || null,
        dados.instrucoes || null, dados.musculos_secundarios || null],
    });
    res.status(201).json({ id, ...dados });
  } catch (err) {
    next(err);
  }
});

// PUT /api/biblioteca-exercicios/:id
router.put('/:id', apenasAdmin, async (req, res, next) => {
  try {
    const dados = exercicioSchema.partial().parse(req.body);
    const campos = Object.keys(dados);
    if (!campos.length) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    const sets = campos.map((c) => `${c} = ?`).join(', ');
    const args = [...campos.map((c) => dados[c]), req.params.id];
    await db.execute({ sql: `UPDATE exercicio_biblioteca SET ${sets} WHERE id = ?`, args });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/biblioteca-exercicios/:id — exercícios de treinos que já
// referenciam este item (treino_exercicios.biblioteca_id) não são afetados:
// eles guardam sua própria cópia de nome/vídeo/imagem, então continuam
// funcionando normalmente mesmo depois que o item sai da biblioteca (a FK
// não tem ON DELETE CASCADE nem RESTRICT — fica só como um vínculo
// histórico "de onde veio").
router.delete('/:id', apenasAdmin, async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM exercicio_biblioteca WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
