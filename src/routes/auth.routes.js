const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db/client');
const { assinarToken } = require('../utils/jwt');
const { criarLimitador } = require('../middleware/rateLimit');

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

module.exports = router;
