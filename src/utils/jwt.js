const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-troque-em-producao';

function assinarToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '8h' });
}

function verificarToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { assinarToken, verificarToken };
