const { verificarToken } = require('../utils/jwt');

function autenticar(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ erro: 'Token não informado.' });
  }

  try {
    req.usuario = verificarToken(token);
    return next();
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

function apenasAdmin(req, res, next) {
  if (!req.usuario || req.usuario.papel !== 'admin') {
    return res.status(403).json({ erro: 'Apenas administradores podem realizar esta ação.' });
  }
  return next();
}

// Autenticação por segredo compartilhado para o totem/terminal — os alunos não
// fazem login com usuário/senha, então não faz sentido exigir JWT aqui. O
// totem envia o header "X-Terminal-Token" com o valor de TERMINAL_TOKEN (.env).
function autenticarTerminal(req, res, next) {
  const esperado = process.env.TERMINAL_TOKEN;
  if (!esperado) {
    return res.status(500).json({ erro: 'TERMINAL_TOKEN não configurado no servidor.' });
  }
  const recebido = req.headers['x-terminal-token'];
  if (!recebido || recebido !== esperado) {
    return res.status(401).json({ erro: 'Token do terminal inválido ou não informado.' });
  }
  return next();
}

module.exports = { autenticar, apenasAdmin, autenticarTerminal };
