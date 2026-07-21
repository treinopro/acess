/**
 * Utilitários de data/hora compartilhados. Fica num arquivo isolado (sem
 * depender de nenhum outro módulo do projeto) de propósito: tanto
 * acessoTerminal.service.js quanto filaAcessosOffline.service.js precisam
 * dele, e esses dois já evitam se exigir um ao outro (ver comentário em
 * filaAcessosOffline.service.js) pra não criar um require circular.
 */

// Formato que o SQLite grava quando usa a expressão `datetime('now')`
// (DEFAULT da coluna acessos_catraca.criado_em): "AAAA-MM-DD HH:MM:SS", em
// UTC, sem "T", sem milissegundos, sem "Z". Qualquer outro formato gravado
// na mesma coluna (ex.: `new Date().toISOString()`, que tem "T" e "Z")
// quebra a ordenação "ORDER BY criado_em DESC" — comparação de texto, não de
// data de verdade — porque o caractere "T" (0x54) é "maior" que o espaço
// (0x20), então qualquer linha gravada em ISO aparece como "mais recente"
// que qualquer linha gravada no formato do SQLite no mesmo dia, não importa
// a hora real de cada uma.
//
// 2026-07-21: foi exatamente isso que causou o bug relatado ("acessos por
// facial mais recentes aparecem abaixo dos por biometria da catraca") —
// acessos via facial/QR (gravados direto pelo totem, formato SQLite) e
// acessos via biometria da catraca (repassados pelo agente local em lote,
// com timestamp próprio em ISO) ficavam misturados na mesma tabela com
// formatos diferentes. Ver acessoTerminal.service.js (registrarAcesso,
// registrarAcessoIdempotenteEm) e filaAcessosOffline.service.js
// (gravarNoTurso) — os dois pontos que gravam um `criado_em` explícito agora
// passam por esta função antes do INSERT, garantindo que tudo fique no mesmo
// formato, não importa a origem.
const REGEX_JA_NO_FORMATO_SQLITE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Normaliza um valor de data (Date, string ISO com "T"/"Z", ou já no formato
 * do SQLite) para "AAAA-MM-DD HH:MM:SS" em UTC. Devolve null se o valor for
 * vazio ou não puder ser interpretado como data — quem chama deve tratar
 * `null` caindo no DEFAULT `datetime('now')` do banco em vez de gravar lixo.
 */
function formatarDataSqliteUtc(valor) {
  if (!valor) return null;
  if (typeof valor === 'string' && REGEX_JA_NO_FORMATO_SQLITE.test(valor)) return valor;
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { formatarDataSqliteUtc };
