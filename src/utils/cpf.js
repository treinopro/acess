// CPF costuma vir digitado ou colado de formas diferentes (com ou sem
// pontos/traço, com espaços). Normalizar pra só dígitos ANTES de gravar ou
// comparar é o que garante que "707.013.529-69" e "70701352969" sejam
// tratados como o mesmo CPF em todo o sistema — sem isso, a checagem de
// duplicado (e o índice único do banco) não pegam a mesma pessoa cadastrada
// duas vezes com formatação diferente (bug real, 2026-08-04).
function normalizarCpf(cpf) {
  if (cpf === null || cpf === undefined) return cpf;
  const digitos = String(cpf).replace(/\D/g, '');
  return digitos || null;
}

module.exports = { normalizarCpf };
