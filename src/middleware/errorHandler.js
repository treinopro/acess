// Middleware central de tratamento de erros. Mantém as respostas de erro
// consistentes em toda a API.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(err);

  if (err.name === 'ZodError') {
    return res.status(400).json({ erro: 'Dados inválidos.', detalhes: err.issues });
  }

  const status = err.status || 500;
  return res.status(status).json({ erro: err.message || 'Erro interno do servidor.' });
}

module.exports = { errorHandler };
