const jwt = require('jsonwebtoken');

// SEM valor padrão de propósito: um fallback fixo no código significa que,
// se a variável de ambiente falhar por qualquer motivo (typo no nome, deploy
// mal configurado), o servidor assinaria tokens com um segredo previsível e
// público (visível a quem vir este arquivo no repositório) em vez de
// simplesmente recusar subir. Gere um valor com `openssl rand -hex 64` e
// configure JWT_SECRET no .env (local) e nas variáveis de ambiente do
// Northflank (produção).
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET não configurado. Defina essa variável de ambiente antes de iniciar o servidor (gere um valor com `openssl rand -hex 64`).');
}

function assinarToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '8h' });
}

function verificarToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { assinarToken, verificarToken };
