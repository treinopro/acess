const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');
const acessoTerminal = require('../services/acessoTerminal.service');

const router = express.Router();
router.use(autenticar);

const alunoSchema = z.object({
  nome: z.string().min(2),
  email: z.string().email().optional().nullable(),
  telefone: z.string().optional().nullable(),
  cpf: z.string().optional().nullable(),
  data_nascimento: z.string().optional().nullable(),
  foto_url: z.string().url().optional().nullable(),
  observacoes: z.string().optional().nullable(),
  biometria_id: z.string().optional().nullable(),
});

const anamneseSchema = z.object({
  historico_saude: z.string().optional().nullable(),
  restricoes: z.string().optional().nullable(),
  peso_kg: z.number().positive().optional().nullable(),
  altura_cm: z.number().positive().optional().nullable(),
  observacoes_medicas: z.string().optional().nullable(),
});

const avaliacaoSchema = z.object({
  data_avaliacao: z.string(),
  peso_kg: z.number().positive().optional().nullable(),
  altura_cm: z.number().positive().optional().nullable(),
  percentual_gordura: z.number().positive().optional().nullable(),
  medida_cintura_cm: z.number().positive().optional().nullable(),
  medida_quadril_cm: z.number().positive().optional().nullable(),
  medida_peito_cm: z.number().positive().optional().nullable(),
  medida_braco_cm: z.number().positive().optional().nullable(),
  medida_coxa_cm: z.number().positive().optional().nullable(),
  objetivo: z.string().optional().nullable(),
  observacoes: z.string().optional().nullable(),
});

// GET /api/alunos?status=ativo&busca=texto — busca por nome ou ID (parcial, case-insensitive)
router.get('/', async (req, res, next) => {
  try {
    const { status, busca } = req.query;
    const condicoes = [];
    const args = [];

    if (status) { condicoes.push('status = ?'); args.push(status); }
    if (busca) {
      condicoes.push('(nome LIKE ? OR id LIKE ?)');
      args.push(`%${busca}%`, `%${busca}%`);
    }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const result = await db.execute({ sql: `SELECT * FROM alunos ${where} ORDER BY nome`, args });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/alunos/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM alunos WHERE id = ?',
      args: [req.params.id],
    });
    if (!result.rows[0]) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/alunos
router.post('/', async (req, res, next) => {
  try {
    const dados = alunoSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO alunos (id, nome, email, telefone, cpf, data_nascimento, foto_url, observacoes, biometria_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.nome, dados.email || null, dados.telefone || null, dados.cpf || null,
        dados.data_nascimento || null, dados.foto_url || null, dados.observacoes || null, dados.biometria_id || null],
    });
    res.status(201).json({ id, ...dados });
  } catch (err) {
    next(err);
  }
});

// PUT /api/alunos/:id
router.put('/:id', async (req, res, next) => {
  try {
    const dados = alunoSchema.partial().parse(req.body);
    const campos = Object.keys(dados);
    if (campos.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    const sets = campos.map((c) => `${c} = ?`).join(', ');
    const args = [...campos.map((c) => dados[c]), req.params.id];

    await db.execute({ sql: `UPDATE alunos SET ${sets} WHERE id = ?`, args });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alunos/:id/status  { status: 'ativo' | 'inativo' | 'trancado' | 'inadimplente' }
router.patch('/:id/status', async (req, res, next) => {
  try {
    const status = z.enum(['ativo', 'inativo', 'trancado', 'inadimplente']).parse(req.body.status);
    await db.execute({
      sql: 'UPDATE alunos SET status = ? WHERE id = ?',
      args: [status, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alunos/:id/biometria  { biometria_id }
// Ponto de integração com leitores biométricos/catracas: o dispositivo (ou o
// software dele) cadastra o template no leitor e envia de volta um ID/hash de
// referência, que é o que guardamos aqui — não armazenamos o template em si.
router.patch('/:id/biometria', async (req, res, next) => {
  try {
    const biometriaId = z.string().min(1).parse(req.body.biometria_id);
    await db.execute({
      sql: 'UPDATE alunos SET biometria_id = ? WHERE id = ?',
      args: [biometriaId, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/biometria', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE alunos SET biometria_id = NULL WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alunos/:id/codigo-acesso — gera (ou reaproveita) o código estável
// usado no QR "meu acesso" pessoal do aluno para o totem. Usar com
// ?regenerar=1 para invalidar o código atual e gerar um novo (ex.: celular
// perdido/comprometido).
router.patch('/:id/codigo-acesso', async (req, res, next) => {
  try {
    if (req.query.regenerar) {
      const novoCodigo = acessoTerminal.gerarCodigoAcesso();
      await db.execute({ sql: 'UPDATE alunos SET codigo_acesso = ? WHERE id = ?', args: [novoCodigo, req.params.id] });
      return res.json({ codigo_acesso: novoCodigo });
    }
    const codigo = await acessoTerminal.garantirCodigoAcesso(req.params.id);
    res.json({ codigo_acesso: codigo });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/alunos/:id/face — remove o descritor facial (permite recadastrar no totem)
router.delete('/:id/face', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE alunos SET face_descriptor = NULL WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/alunos/:id/face { descriptor } — cadastra o rosto direto pelo painel
// admin (câmera do computador da recepção), sem precisar levar o aluno ao totem.
router.put('/:id/face', async (req, res, next) => {
  try {
    const { descriptor } = z.object({ descriptor: z.array(z.number()).min(16) }).parse(req.body);
    await acessoTerminal.salvarFaceDescriptor(req.params.id, descriptor);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/alunos/:id — exclusão definitiva, com limpeza explícita dos
// registros dependentes (não contamos com ON DELETE CASCADE do SQLite/libSQL
// porque em conexões remotas ao Turso o pragma foreign_keys nem sempre persiste).
router.delete('/:id', async (req, res, next) => {
  try {
    const aluno = await db.execute({ sql: 'SELECT id FROM alunos WHERE id = ?', args: [req.params.id] });
    if (!aluno.rows[0]) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    const tabelasDependentes = ['checkins', 'agendamentos', 'cobrancas', 'matriculas', 'anamneses', 'avaliacoes_fisicas'];
    for (const tabela of tabelasDependentes) {
      await db.execute({ sql: `DELETE FROM ${tabela} WHERE aluno_id = ?`, args: [req.params.id] });
    }
    await db.execute({ sql: 'DELETE FROM alunos WHERE id = ?', args: [req.params.id] });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- Perfil agregado ----------------

// GET /api/alunos/:id/perfil — tudo que a tela de perfil do aluno precisa em uma chamada só
router.get('/:id/perfil', async (req, res, next) => {
  try {
    const alunoId = req.params.id;
    const aluno = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [alunoId] });
    if (!aluno.rows[0]) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    const [anamnese, avaliacoes, matriculas, agendamentos, cobrancas] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM anamneses WHERE aluno_id = ? ORDER BY criado_em DESC LIMIT 1', args: [alunoId] }),
      db.execute({ sql: 'SELECT * FROM avaliacoes_fisicas WHERE aluno_id = ? ORDER BY data_avaliacao DESC', args: [alunoId] }),
      db.execute({
        sql: `SELECT m.*, p.nome as plano_nome FROM matriculas m JOIN planos p ON p.id = m.plano_id
              WHERE m.aluno_id = ? ORDER BY m.data_inicio DESC`,
        args: [alunoId],
      }),
      db.execute({
        sql: `SELECT ag.*, t.nome as turma_nome FROM agendamentos ag JOIN turmas t ON t.id = ag.turma_id
              WHERE ag.aluno_id = ? ORDER BY ag.data_aula DESC LIMIT 15`,
        args: [alunoId],
      }),
      db.execute({ sql: 'SELECT * FROM cobrancas WHERE aluno_id = ? ORDER BY criado_em DESC', args: [alunoId] }),
    ]);

    res.json({
      aluno: aluno.rows[0],
      anamnese: anamnese.rows[0] || null,
      avaliacoes: avaliacoes.rows,
      matriculas: matriculas.rows,
      agendamentos: agendamentos.rows,
      cobrancas: cobrancas.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------- Anamnese (dado sensível — ver LGPD no README) ----------------

// PUT /api/alunos/:id/anamnese — cria ou atualiza a anamnese (1 por aluno)
router.put('/:id/anamnese', async (req, res, next) => {
  try {
    const dados = anamneseSchema.parse(req.body);
    const alunoId = req.params.id;

    const existente = await db.execute({
      sql: 'SELECT id FROM anamneses WHERE aluno_id = ? ORDER BY criado_em DESC LIMIT 1',
      args: [alunoId],
    });

    if (existente.rows[0]) {
      await db.execute({
        sql: `UPDATE anamneses SET historico_saude = ?, restricoes = ?, peso_kg = ?, altura_cm = ?, observacoes_medicas = ?
              WHERE id = ?`,
        args: [dados.historico_saude || null, dados.restricoes || null, dados.peso_kg || null,
          dados.altura_cm || null, dados.observacoes_medicas || null, existente.rows[0].id],
      });
      return res.json({ ok: true, id: existente.rows[0].id });
    }

    const id = uuid();
    await db.execute({
      sql: `INSERT INTO anamneses (id, aluno_id, historico_saude, restricoes, peso_kg, altura_cm, observacoes_medicas)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, alunoId, dados.historico_saude || null, dados.restricoes || null,
        dados.peso_kg || null, dados.altura_cm || null, dados.observacoes_medicas || null],
    });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// ---------------- Avaliações físicas (histórico de evolução) ----------------

// POST /api/alunos/:id/avaliacoes
router.post('/:id/avaliacoes', async (req, res, next) => {
  try {
    const dados = avaliacaoSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO avaliacoes_fisicas
            (id, aluno_id, data_avaliacao, peso_kg, altura_cm, percentual_gordura,
             medida_cintura_cm, medida_quadril_cm, medida_peito_cm, medida_braco_cm, medida_coxa_cm, objetivo, observacoes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.id, dados.data_avaliacao, dados.peso_kg || null, dados.altura_cm || null,
        dados.percentual_gordura || null, dados.medida_cintura_cm || null, dados.medida_quadril_cm || null,
        dados.medida_peito_cm || null, dados.medida_braco_cm || null, dados.medida_coxa_cm || null,
        dados.objetivo || null, dados.observacoes || null],
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// GET /api/alunos/:id/avaliacoes
router.get('/:id/avaliacoes', async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM avaliacoes_fisicas WHERE aluno_id = ? ORDER BY data_avaliacao DESC',
      args: [req.params.id],
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/alunos/avaliacoes/:avaliacaoId
router.delete('/avaliacoes/:avaliacaoId', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM avaliacoes_fisicas WHERE id = ?', args: [req.params.avaliacaoId] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
