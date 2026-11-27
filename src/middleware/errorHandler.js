// Middleware central de tratamento de erros. Mantém as respostas de erro
// consistentes em toda a API.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(err);

  if (err.name === 'ZodError') {
    return res.status(400).json({ erro: 'Dados inválidos.', detalhes: err.issues });
  }

  // 2026-11: erro INESPERADO (sem status definido pelo código) pode trazer detalhe interno — mensagem de banco,
  // resposta crua do Mercado Pago, caminho de arquivo. Para quem não é funcionário logado (portal, totem, páginas
  // públicas) devolve só uma mensagem genérica; o detalhe continua no log do servidor. Funcionário logado
  // (req.usuario) continua vendo a mensagem completa para poder diagnosticar.
  const status = err.status || 500;
  const mostrarDetalhe = Boolean(err.status) || Boolean(req.usuario);
  return res.status(status).json({ erro: (mostrarDetalhe && err.message) || 'Erro interno do servidor.' });
}

module.exports = { errorHandler };
