const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');
const notificacaoTreino = require('../services/notificacaoTreino.service');

const router = express.Router();
router.use(autenticar);

const treinoSchema = z.object({
  aluno_id: z.string(),
  nome: z.string().min(1),
  dias_semana: z.array(z.number().int().min(0).max(6)).optional().default([]),
  // Portal do aluno (2026-08-15) — ver comentário completo junto da
  // definição de "treinos" em schema.sql. visivel_portal: toggle manual do
  // professor. data_fim: fim do período (auto-oculta no portal ao passar).
  visivel_portal: z.boolean().optional(),
  data_fim: z.string().optional().nullable(),
});

const exercicioSchema = z.object({
  exercicio: z.string().min(1),
  series: z.string().optional().nullable(),
  carga: z.string().optional().nullable(),
  intervalo: z.string().optional().nullable(),
  observacao: z.string().optional().nullable(),
  ordem: z.number().int().optional(),
  // Campos do port do TreinoPro (2026-08): ver comentário em schema.sql
  // junto de "treino_exercicios". biblioteca_id vincula o exercício a um
  // item da biblioteca — se video_url/imagem_url não vierem preenchidos, o
  // handler abaixo herda do item da biblioteca no momento da criação.
  biblioteca_id: z.string().optional().nullable(),
  video_url: z.string().optional().nullable(),
  imagem_url: z.string().optional().nullable(),
  metodo: z.string().optional().nullable(),
  dica: z.string().optional().nullable(),
  concluido: z.boolean().optional(),
});

// Se um exercício referencia um item da biblioteca mas não veio com
// vídeo/imagem próprios no corpo da requisição, herda do item da biblioteca
// (1 SELECT). Mesma lógica do TreinoPro original (server.js, criação de
// exercício) — o exercício guarda sua própria cópia, então trocar/excluir o
// item da biblioteca depois não afeta treinos já montados.
async function herdarMidiaDaBiblioteca(dados) {
  if (!dados.biblioteca_id || (dados.video_url && dados.imagem_url)) return dados;
  const item = await db.execute({
    sql: 'SELECT video_url, imagem_url FROM exercicio_biblioteca WHERE id = ?',
    args: [dados.biblioteca_id],
  });
  const row = item.rows[0];
  if (!row) return dados;
  return {
    ...dados,
    video_url: dados.video_url || row.video_url || null,
    imagem_url: dados.imagem_url || row.imagem_url || null,
  };
}

// Dispara notificacaoTreino.notificarAtualizacaoTreinoSeguro pro aluno DONO
// do treino identificado por treinoId — busca aluno_id/nome/email/nome do
// treino via JOIN (nenhuma das rotas abaixo tem isso à mão de propósito,
// treino_exercicios só guarda treino_id). Fire-and-forget: nunca é
// `await`ado por quem chama, pra não atrasar a resposta HTTP por causa de
// push/e-mail lento (mesmo padrão de POST / acima). Pedido explícito do
// dono do sistema (2026-08-27): qualquer atualização em um treino já
// existente avisa o aluno.
function dispararNotificacaoAtualizacao(treinoId, detalhe) {
  db.execute({
    sql: `SELECT t.nome as treino_nome, a.id as aluno_id, a.nome as aluno_nome, a.email as aluno_email
          FROM treinos t JOIN alunos a ON a.id = t.aluno_id WHERE t.id = ?`,
    args: [treinoId],
  })
    .then((r) => {
      const row = r.rows[0];
      if (!row) return;
      notificacaoTreino.notificarAtualizacaoTreinoSeguro(
        { id: row.aluno_id, nome: row.aluno_nome, email: row.aluno_email },
        { treinoNome: row.treino_nome, detalhe },
      );
    })
    .catch(() => { /* best-effort — não deve afetar a resposta da rota que chamou */ });
}

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
    const visivelPortal = dados.visivel_portal === false ? 0 : 1;
    await db.execute({
      sql: `INSERT INTO treinos (id, aluno_id, nome, dias_semana, ordem, visivel_portal, data_fim) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.nome, JSON.stringify(dados.dias_semana), ordem, visivelPortal, dados.data_fim || null],
    });

    // Aviso automático (push + e-mail) pro aluno — best-effort, disparado sem
    // `await` de propósito (fire-and-forget) pra não atrasar a resposta da
    // criação do treino em si por causa de push/e-mail lento. Só dispara
    // quando o treino já nasce visível no portal — um treino criado
    // visivel_portal=false (ainda em montagem) não deveria avisar o aluno de
    // nada até o professor decidir mostrar de verdade.
    if (visivelPortal) {
      db.execute({ sql: 'SELECT nome, email FROM alunos WHERE id = ?', args: [dados.aluno_id] })
        .then((alunoResult) => {
          const aluno = alunoResult.rows[0];
          if (!aluno) return;
          notificacaoTreino.notificarNovoTreinoSeguro(
            { id: dados.aluno_id, nome: aluno.nome, email: aluno.email },
            { treinoNome: dados.nome },
          );
        })
        .catch(() => { /* best-effort — não deve afetar a resposta da criação do treino */ });
    }

    res.status(201).json({
      id, ...dados, ordem, exercicios: [], visivel_portal: Boolean(visivelPortal), data_fim: dados.data_fim || null,
    });
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
    if (dados.visivel_portal !== undefined) { sets.push('visivel_portal = ?'); args.push(dados.visivel_portal ? 1 : 0); }
    if (dados.data_fim !== undefined) { sets.push('data_fim = ?'); args.push(dados.data_fim || null); }
    args.push(req.params.id);

    await db.execute({ sql: `UPDATE treinos SET ${sets.join(', ')} WHERE id = ?`, args });
    // Só avisa o aluno quando algo que ele realmente vê no portal mudou —
    // reordenar (ordem, editado em outra rota) ou trocar visivel_portal pra
    // false não deveria gerar "seu treino foi atualizado" (no 2o caso o
    // treino nem aparece mais pra ele ver o que mudou).
    if (dados.nome !== undefined || dados.dias_semana !== undefined || dados.data_fim !== undefined
      || dados.visivel_portal === true) {
      dispararNotificacaoAtualizacao(req.params.id, 'informações do treino atualizadas');
    }
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
    const dados = await herdarMidiaDaBiblioteca(exercicioSchema.parse(req.body));
    const id = uuid();
    const ultimaOrdem = await db.execute({
      sql: `SELECT COALESCE(MAX(ordem), -1) as maxOrdem FROM treino_exercicios WHERE treino_id = ?`,
      args: [req.params.id],
    });
    const ordem = dados.ordem ?? (Number(ultimaOrdem.rows[0].maxOrdem) + 1);
    await db.execute({
      sql: `INSERT INTO treino_exercicios
              (id, treino_id, exercicio, series, carga, intervalo, observacao, ordem, biblioteca_id, video_url, imagem_url, metodo, dica)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.id, dados.exercicio, dados.series || null, dados.carga || null,
        dados.intervalo || null, dados.observacao || null, ordem, dados.biblioteca_id || null,
        dados.video_url || null, dados.imagem_url || null, dados.metodo || null, dados.dica || null],
    });
    dispararNotificacaoAtualizacao(req.params.id, `exercício "${dados.exercicio}" adicionado`);
    res.status(201).json({ id, treino_id: req.params.id, ...dados, ordem });
  } catch (err) {
    next(err);
  }
});

// PUT /api/treinos/exercicios/:id — edita um exercício.
router.put('/exercicios/:id', async (req, res, next) => {
  try {
    const dados = await herdarMidiaDaBiblioteca(exercicioSchema.partial().parse(req.body));
    const campos = Object.keys(dados);
    if (!campos.length) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    // Precisa do treino_id (pra notificar o aluno certo) e do nome atual do
    // exercício (pra mensagem, caso `exercicio` não venha no PATCH) ANTES do
    // UPDATE — depois não dá mais pra buscar de forma confiável.
    const atual = await db.execute({
      sql: 'SELECT treino_id, exercicio FROM treino_exercicios WHERE id = ?',
      args: [req.params.id],
    });
    if (!atual.rows[0]) return res.status(404).json({ erro: 'Exercício não encontrado.' });
    const nomeExercicio = dados.exercicio || atual.rows[0].exercicio;

    const sets = campos.map((c) => `${c} = ?`).join(', ');
    const args = [...campos.map((c) => (typeof dados[c] === 'boolean' ? (dados[c] ? 1 : 0) : dados[c])), req.params.id];
    // carga (2026-08-27): o professor está ajustando a carga em resposta ao
    // aluno ter reportado muitas repetições no portal — desliga o
    // sinalizador de pendência (ver POST /treino/exercicio/:id/concluir em
    // portal.routes.js e listarPendenciasAjusteCarga em pendencias.routes.js).
    const sqlFinal = dados.carga !== undefined
      ? `UPDATE treino_exercicios SET ${sets}, precisa_ajuste_carga = 0 WHERE id = ?`
      : `UPDATE treino_exercicios SET ${sets} WHERE id = ?`;
    await db.execute({ sql: sqlFinal, args });

    const detalhe = dados.carga !== undefined
      ? `carga do exercício "${nomeExercicio}" ajustada para ${dados.carga || '—'}`
      : `exercício "${nomeExercicio}" atualizado`;
    dispararNotificacaoAtualizacao(atual.rows[0].treino_id, detalhe);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/treinos/exercicios/:id
router.delete('/exercicios/:id', async (req, res, next) => {
  try {
    const atual = await db.execute({
      sql: 'SELECT treino_id, exercicio FROM treino_exercicios WHERE id = ?',
      args: [req.params.id],
    });
    await db.execute({ sql: 'DELETE FROM treino_exercicios WHERE id = ?', args: [req.params.id] });
    if (atual.rows[0]) {
      dispararNotificacaoAtualizacao(atual.rows[0].treino_id, `exercício "${atual.rows[0].exercicio}" removido`);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
