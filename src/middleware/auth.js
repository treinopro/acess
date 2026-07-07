const crypto = require('crypto');
const { verificarToken } = require('../utils/jwt');

// Comparação de string em tempo constante — evita, em teoria, ataques de
// timing pra descobrir um segredo caractere por caractere (risco baixo na
// prática aqui, mas é o padrão recomendado e o custo de implementar é zero).
function segredosIguais(recebido, esperado) {
  if (!recebido || !esperado) return false;
  const bufRecebido = Buffer.from(String(recebido));
  const bufEsperado = Buffer.from(String(esperado));
  return bufRecebido.length === bufEsperado.length && crypto.timingSafeEqual(bufRecebido, bufEsperado);
}

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
// totem FÍSICO envia o header "X-Terminal-Token" com o valor de TERMINAL_TOKEN
// (.env). Este token só deve viver num dispositivo fisicamente controlado.
function autenticarTerminal(req, res, next) {
  const esperado = process.env.TERMINAL_TOKEN;
  if (!esperado) {
    return res.status(500).json({ erro: 'TERMINAL_TOKEN não configurado no servidor.' });
  }
  const recebido = req.headers['x-terminal-token'];
  if (!segredosIguais(recebido, esperado)) {
    return res.status(401).json({ erro: 'Token do terminal inválido ou não informado.' });
  }
  return next();
}

// Autenticação por segredo compartilhado para a página pública de auto-cadastro
// pelo celular (public/cadastro-mobile.js, aberta via QR "Usar seu cel" no
// totem). Segredo separado do TERMINAL_TOKEN de propósito: diferente do
// totem, esta página é entregue a QUALQUER visitante que escaneie o QR, então
// o token embutido nela fica bem mais exposto — usar um segredo próprio,
// mais restrito (só as rotas de auto-cadastro aceitam este token; nada que
// abra a catraca ou exponha o código de acesso de outro aluno aceita), limita
// o estrago se ele vazar/for compartilhado.
function autenticarCadastroPublico(req, res, next) {
  const esperado = process.env.CADASTRO_PUBLICO_TOKEN;
  if (!esperado) {
    return res.status(500).json({ erro: 'CADASTRO_PUBLICO_TOKEN não configurado no servidor.' });
  }
  const recebido = req.headers['x-cadastro-token'];
  if (!segredosIguais(recebido, esperado)) {
    return res.status(401).json({ erro: 'Token de cadastro inválido ou não informado.' });
  }
  return next();
}

// Para rotas usadas tanto pelo totem físico quanto pela página de cadastro
// pelo celular (planos, auto-cadastro, status do pagamento, cadastro facial
// logo após o auto-cadastro): aceita qualquer um dos dois tokens.
function autenticarTerminalOuCadastroPublico(req, res, next) {
  const tokenTerminal = process.env.TERMINAL_TOKEN;
  const tokenCadastro = process.env.CADASTRO_PUBLICO_TOKEN;
  const recebidoTerminal = req.headers['x-terminal-token'];
  const recebidoCadastro = req.headers['x-cadastro-token'];

  if (segredosIguais(recebidoTerminal, tokenTerminal) || segredosIguais(recebidoCadastro, tokenCadastro)) {
    return next();
  }
  return res.status(401).json({ erro: 'Token inválido ou não informado.' });
}

module.exports = {
  autenticar,
  apenasAdmin,
  autenticarTerminal,
  autenticarCadastroPublico,
  autenticarTerminalOuCadastroPublico,
};
