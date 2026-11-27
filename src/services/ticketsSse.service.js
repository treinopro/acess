/**
 * Códigos de uso único para abrir conexões SSE (EventSource) do painel admin.
 *
 * O EventSource do navegador não aceita cabeçalhos, então antes o token de login do administrador (JWT) ia na URL
 * (?token=...) — e a URL aparece nos logs do servidor, no histórico e em proxies, expondo uma sessão de admin.
 * Agora o painel pede um código curto (POST autenticado com o JWT no cabeçalho) e abre o stream com ele:
 * vale uma única vez e por poucos segundos, então um código que vaze num log já é inútil.
 */
const crypto = require('crypto');

const VALIDADE_MS = 30 * 1000;
const MAXIMO_PENDENTES = 1000;
const tickets = new Map(); // codigo -> { usuario, expira }

function limparExpirados() {
  const agora = Date.now();
  for (const [codigo, t] of tickets) if (t.expira < agora) tickets.delete(codigo);
}

function emitir(usuario) {
  limparExpirados();
  if (tickets.size >= MAXIMO_PENDENTES) {
    // Proteção contra emissão em massa: descarta o mais antigo.
    tickets.delete(tickets.keys().next().value);
  }
  const codigo = crypto.randomBytes(24).toString('hex');
  tickets.set(codigo, { usuario, expira: Date.now() + VALIDADE_MS });
  return codigo;
}

/** Devolve o usuário dono do código e o invalida (uso único), ou null se for inválido/expirado/já usado. */
function consumir(codigo) {
  if (!codigo) return null;
  const t = tickets.get(String(codigo));
  if (!t) return null;
  tickets.delete(String(codigo));
  return t.expira >= Date.now() ? t.usuario : null;
}

module.exports = { emitir, consumir, VALIDADE_MS };
