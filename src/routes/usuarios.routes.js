const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar, apenasAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar, apenasAdmin);

const usuarioSchema = z.object({
  nome: z.string().min(2),
  email: z.string().email(),
  senha: z.string().min(6),
  papel: z.enum(['admin', 'professor', 'recepcao']).default('admin'),
});

// GET /api/usuarios — lista usuários do sistema (sem o hash da senha)
router.get('/', async (req, res, next) => {
  try {
    const result = await db.execute('SELECT id, nome, email, papel, criado_em FROM usuarios ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/usuarios — cria um novo usuário para gerenciar o sistema
router.post('/', async (req, res, next) => {
  try {
    const dados = usuarioSchema.parse(req.body);

    const existente = await db.execute({ sql: 'SELECT id FROM usuarios WHERE email = ?', args: [dados.email] });
    if (existente.rows[0]) return res.status(409).json({ erro: 'Já existe um usuário com este e-mail.' });

    const id = uuid();
    const senhaHash = await bcrypt.hash(dados.senha, 10);
    await db.execute({
      sql: 'INSERT INTO usuarios (id, nome, email, senha_hash, papel) VALUES (?, ?, ?, ?, ?)',
      args: [id, dados.nome, dados.email, senhaHash, dados.papel],
    });

    res.status(201).json({ id, nome: dados.nome, email: dados.email, papel: dados.papel });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/usuarios/:id/papel — altera o papel (admin | professor | recepcao)
router.patch('/:id/papel', async (req, res, next) => {
  try {
    const papel = z.enum(['admin', 'professor', 'recepcao']).parse(req.body.papel);
    await db.execute({ sql: 'UPDATE usuarios SET papel = ? WHERE id = ?', args: [papel, req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/usuarios/:id — remove um usuário (não permite autoexclusão)
router.delete('/:id', async (req, res, next) => {
  try {
    if (req.params.id === req.usuario.id) {
      return res.status(400).json({ erro: 'Você não pode excluir seu próprio usuário enquanto está logado com ele.' });
    }
    await db.execute({ sql: 'DELETE FROM usuarios WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
