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
  // Login curto opcional (ex.: "joao"), alternativo ao e-mail na tela de login.
  // Aceita letras/números/ponto/hífen/underscore; vazio ou ausente vira null.
  usuario: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/, 'Use apenas letras, números, ponto, hífen ou underscore.').optional().or(z.literal('')),
  senha: z.string().min(6),
  papel: z.enum(['admin', 'professor', 'recepcao']).default('admin'),
});

// GET /api/usuarios — lista usuários do sistema (sem o hash da senha)
router.get('/', async (req, res, next) => {
  try {
    const result = await db.execute('SELECT id, nome, usuario, email, papel, criado_em FROM usuarios ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/usuarios — cria um novo usuário para gerenciar o sistema
router.post('/', async (req, res, next) => {
  try {
    const dados = usuarioSchema.parse(req.body);
    const usuarioLogin = dados.usuario ? dados.usuario : null;

    // 2026-09-10: comparação por LOWER() — login (auth.routes.js) passou a
    // aceitar usuario/email em qualquer caixa, então a checagem de duplicata
    // aqui precisa ser igualmente insensível a maiúsculas/minúsculas, senão
    // dava pra cadastrar "Junior" mesmo já existindo "junior", e o login
    // ficaria ambíguo entre os dois.
    const existenteEmail = await db.execute({ sql: 'SELECT id FROM usuarios WHERE LOWER(email) = LOWER(?)', args: [dados.email] });
    if (existenteEmail.rows[0]) return res.status(409).json({ erro: 'Já existe um usuário com este e-mail.' });

    if (usuarioLogin) {
      const existenteUsuario = await db.execute({ sql: 'SELECT id FROM usuarios WHERE LOWER(usuario) = LOWER(?)', args: [usuarioLogin] });
      if (existenteUsuario.rows[0]) return res.status(409).json({ erro: 'Já existe um usuário com esse nome de login.' });
    }

    const id = uuid();
    const senhaHash = await bcrypt.hash(dados.senha, 10);
    await db.execute({
      sql: 'INSERT INTO usuarios (id, nome, usuario, email, senha_hash, papel) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, dados.nome, usuarioLogin, dados.email, senhaHash, dados.papel],
    });

    res.status(201).json({ id, nome: dados.nome, usuario: usuarioLogin, email: dados.email, papel: dados.papel });
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

// PUT /api/usuarios/:id/senha — redefine a senha de um usuário existente
// (2026-09-08: não existia nenhum jeito de trocar a senha de alguém sem
// excluir e recriar a conta inteira, perdendo o vínculo do id em qualquer
// referência antiga — ex.: banners_portal.criado_por. Ficou necessário na
// hora de restaurar um backup pra um banco novo: o backup NUNCA inclui
// senha_hash de propósito, então toda conta precisa de uma senha nova depois
// de uma restauração — ver escreverBackupStream em config.routes.js).
router.put('/:id/senha', async (req, res, next) => {
  try {
    const senha = z.string().min(6).parse(req.body.senha);
    const senhaHash = await bcrypt.hash(senha, 10);
    const result = await db.execute({ sql: 'UPDATE usuarios SET senha_hash = ? WHERE id = ?', args: [senhaHash, req.params.id] });
    if (!result.rowsAffected) return res.status(404).json({ erro: 'Usuário não encontrado.' });
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
