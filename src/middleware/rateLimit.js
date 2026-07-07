// Limitador de requisições simples, em memória — sem dependência externa
// (express-rate-limit não pôde ser instalado neste ambiente por falta de
// acesso a npm/rede; esta implementação cobre o mesmo objetivo prático:
// frear brute-force de senha, automação de CPFs e abuso de webhooks).
//
// Limitações assumidas conscientemente:
// - O contador vive na memória do processo Node — zera a cada restart/deploy.
// - Não é compartilhado entre múltiplas instâncias caso o serviço escale
//   horizontalmente (não é o caso hoje: Render/Northflank roda uma instância
//   só deste serviço).
// Para um volume maior de tráfego ou múltiplas instâncias, trocar por
// `express-rate-limit` + um store compartilhado (Redis) é o próximo passo.

const registros = new Map(); // chave -> array de timestamps (ms) das requisições recentes

// Limpeza periódica pra não deixar o Map crescer pra sempre com chaves antigas.
setInterval(() => {
  const agora = Date.now();
  for (const [chave, timestamps] of registros) {
    const validos = timestamps.filter((t) => agora - t < 60 * 60 * 1000); // guarda até 1h
    if (validos.length === 0) registros.delete(chave);
    else registros.set(chave, validos);
  }
}, 10 * 60 * 1000).unref();

/**
 * Cria um middleware que limita a `maximo` requisições por `janelaMs`
 * milissegundos, contadas por chave (IP por padrão — pode ser combinada com
 * outro dado da requisição, ex: CPF, via `chavePor`).
 */
function criarLimitador({ janelaMs, maximo, mensagem, chavePor }) {
  const obterChave = chavePor || ((req) => req.ip);
  return (req, res, next) => {
    const chave = `${req.baseUrl}${req.path}::${obterChave(req)}`;
    const agora = Date.now();
    const timestamps = (registros.get(chave) || []).filter((t) => agora - t < janelaMs);

    if (timestamps.length >= maximo) {
      return res.status(429).json({ erro: mensagem || 'Muitas tentativas. Aguarde um pouco e tente novamente.' });
    }

    timestamps.push(agora);
    registros.set(chave, timestamps);
    next();
  };
}

module.exports = { criarLimitador };
