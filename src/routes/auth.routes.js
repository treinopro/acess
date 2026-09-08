const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db/client');
const { assinarToken } = require('../utils/jwt');
const { criarLimitador } = require('../middleware/rateLimit');
const { autenticar } = require('../middleware/auth');

const router = express.Router();

const loginSchema = z.object({
  identificador: z.string().min(1), // pode ser e-mail ou nome de usuario
  senha: z.string().min(6),
});

// Trava tentativas de login: 10 por 15 minutos, contadas por IP + identificador
// (assim um IP compartilhado — ex: rede da academia — não bloqueia login de
// contas diferentes por causa de uma tentativa errada numa delas).
const loginLimiter = criarLimitador({
  janelaMs: 15 * 60 * 1000,
  maximo: 10,
  mensagem: 'Muitas tentativas de login. Aguarde 15 minutos e tente novamente.',
  chavePor: (req) => `${req.ip}:${req.body?.identificador || ''}`,
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { identificador, senha } = loginSchema.parse(req.body);

    const result = await db.execute({
      sql: 'SELECT * FROM usuarios WHERE email = ? OR usuario = ?',
      args: [identificador, identificador],
    });

    const usuario = result.rows[0];
    if (!usuario) {
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    const token = assinarToken({ id: usuario.id, email: usuario.email, papel: usuario.papel });
    return res.json({ token, usuario: { id: usuario.id, nome: usuario.nome, papel: usuario.papel } });
  } catch (err) {
    return next(err);
  }
});

// POST /api/auth/trocar-senha — autosservico: QUALQUER usuário logado (não só
// admin — diferente de PUT /api/usuarios/:id/senha, que é o admin resetando a
// senha de outra pessoa) troca a PRÓPRIA senha, confirmando a senha atual.
// 2026-09-08: não existia nenhum jeito de um usuário (principalmente não-admin,
// que nem acessa a aba Usuários) trocar a própria senha sozinho — só um admin
// resetando pela aba Usuários. Fica em auth.routes.js (não em usuarios.routes.js,
// que exige apenasAdmin em todas as rotas) de propósito, só com autenticar.
router.post('/trocar-senha', autenticar, async (req, res, next) => {
  try {
    const { senha_atual: senhaAtual, senha_nova: senhaNova } = z.object({
      senha_atual: z.string().min(1),
      senha_nova: z.string().min(6),
    }).parse(req.body);

    const result = await db.execute({ sql: 'SELECT senha_hash FROM usuarios WHERE id = ?', args: [req.usuario.id] });
    const usuario = result.rows[0];
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const senhaValida = await bcrypt.compare(senhaAtual, usuario.senha_hash);
    if (!senhaValida) return res.status(401).json({ erro: 'Senha atual incorreta.' });

    const novoHash = await bcrypt.hash(senhaNova, 10);
    await db.execute({ sql: 'UPDATE usuarios SET senha_hash = ? WHERE id = ?', args: [novoHash, req.usuario.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
