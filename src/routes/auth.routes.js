const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db/client');
const { assinarToken } = require('../utils/jwt');

const router = express.Router();

const loginSchema = z.object({
  identificador: z.string().min(1), // pode ser e-mail ou nome de usuario
  senha: z.string().min(6),
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
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
