/**
 * Camada de resiliência do banco pro "modo totem offline-resiliente"
 * (2026-07 — ver checklist acordado com o dono do sistema). Só entra em
 * ação quando MODO_TOTEM_OFFLINE=true no .env deste processo; fora disso,
 * comFallback() simplesmente chama a versão online direto, sem nenhum
 * overhead nem mudança de comportamento — ou seja, a produção normal na
 * nuvem (que não define essa variável) continua se comportando exatamente
 * como antes.
 *
 * Filosofia igual à já usada pra biometria da própria catraca
 * (agente-local/cacheAutorizacao.js + filaAcessos.js), só que dentro do
 * MESMO processo (sem precisar de HTTP entre duas máquinas): tenta o Turso
 * primeiro, com um timeout curto pra não travar a resposta do totem por
 * muito tempo; se falhar OU estourar o timeout, cai pro local.db (ver
 * src/db/clientOffline.js), aceitando que o dado ali pode estar
 * desatualizado — risco já aceito pelo dono do sistema pra manter o totem
 * funcionando durante uma queda de internet.
 *
 * NUNCA usado para escritas de cadastro (aluno/plano/pagamento/rosto) —
 * só para as leituras de DECISÃO de acesso (CPF/QR/facial/biometria) e para
 * o registro do acesso em si (ver acessoTerminal.service.js).
 */

const MODO_TOTEM_OFFLINE = String(process.env.MODO_TOTEM_OFFLINE || 'false').toLowerCase() === 'true';

// Timeout "normal": usado na primeira tentativa depois de uma recuperação
// (ou logo no início). Timeout "em queda": bem mais curto, usado enquanto já
// sabemos que o Turso está indisponível — não faz sentido esperar o mesmo
// tanto de novo a cada tentativa, mas ainda tentamos toda vez pra detectar a
// volta o quanto antes.
const TIMEOUT_TURSO_MS = Number(process.env.TIMEOUT_TURSO_MS) || 4000;
const TIMEOUT_TURSO_EM_QUEDA_MS = Number(process.env.TIMEOUT_TURSO_EM_QUEDA_MS) || 1500;

// Repete o aviso de "ainda offline" no console a cada esse intervalo, em vez
// de logar a cada tentativa individual (poderia ser várias por segundo).
const ALERTA_REPETICAO_MS = Number(process.env.ALERTA_OFFLINE_REPETICAO_MS) || 60 * 1000;

let emModoOffline = false;
let offlineDesde = null;
let ultimoAlertaEm = 0;
let falhasConsecutivas = 0;

function agoraISO() {
  return new Date().toISOString();
}

function imprimirBanner(mensagem) {
  const linha = '='.repeat(Math.min(78, mensagem.length + 4));
  // Banner bem visível de propósito (pedido do dono do sistema): quem olhar
  // a janela do terminal/console onde este processo está rodando no PC deve
  // conseguir notar isso sem precisar procurar nos logs.
  console.log(`\n${linha}\n[${agoraISO()}] ${mensagem}\n${linha}\n`);
}

function timeoutAtual() {
  return emModoOffline ? TIMEOUT_TURSO_EM_QUEDA_MS : TIMEOUT_TURSO_MS;
}

function logAlertaOffline(operacao, err) {
  const agora = Date.now();
  falhasConsecutivas += 1;

  if (!emModoOffline) {
    emModoOffline = true;
    offlineDesde = agora;
    ultimoAlertaEm = agora;
    imprimirBanner(
      `🔴 MODO OFFLINE ATIVADO — o Turso (banco online) não respondeu em "${operacao}": ${err.message}. ` +
      'Caindo pro local.db (dados podem estar desatualizados). Os acessos continuam sendo liberados/negados ' +
      'com a última informação conhecida, e ficam numa fila local até o Turso voltar.',
    );
    return;
  }

  if (agora - ultimoAlertaEm >= ALERTA_REPETICAO_MS) {
    ultimoAlertaEm = agora;
    const duracaoS = Math.round((agora - offlineDesde) / 1000);
    imprimirBanner(
      `🔴 AINDA EM MODO OFFLINE (há ${duracaoS}s, ${falhasConsecutivas} falha(s) consecutiva(s)) — ` +
      `última falha em "${operacao}": ${err.message}.`,
    );
  }
}

function registrarRecuperacaoSeNecessario() {
  if (!emModoOffline) return;
  const duracaoS = Math.round((Date.now() - offlineDesde) / 1000);
  imprimirBanner(
    `🟢 TURSO RECUPERADO — ficou ${duracaoS}s em modo offline (${falhasConsecutivas} falha(s) consecutiva(s) registrada(s)). ` +
    'Voltando a usar o banco online normalmente.',
  );
  emModoOffline = false;
  offlineDesde = null;
  falhasConsecutivas = 0;
}

function comTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tempo esgotado (${ms}ms) esperando resposta do Turso`)), ms);
    promise.then(
      (valor) => { clearTimeout(timer); resolve(valor); },
      (erro) => { clearTimeout(timer); reject(erro); },
    );
  });
}

/**
 * Executa `fnOnline` (contra o Turso); se MODO_TOTEM_OFFLINE não estiver
 * ativo, chama direto sem nenhum overhead (comportamento idêntico ao de
 * antes desta mudança). Se estiver ativo, aplica timeout e cai pra
 * `fnOffline` (contra o local.db) em caso de falha, logando o alerta.
 *
 * @param {string} nomeOperacao só para o log ficar legível
 * @param {() => Promise<any>} fnOnline
 * @param {() => Promise<any>} fnOffline
 */
async function comFallback(nomeOperacao, fnOnline, fnOffline) {
  if (!MODO_TOTEM_OFFLINE) return fnOnline();

  try {
    const resultado = await comTimeout(fnOnline(), timeoutAtual());
    registrarRecuperacaoSeNecessario();
    return resultado;
  } catch (err) {
    logAlertaOffline(nomeOperacao, err);
    return fnOffline();
  }
}

function estaEmModoOffline() {
  return emModoOffline;
}

module.exports = {
  MODO_TOTEM_OFFLINE,
  comFallback,
  comTimeout,
  timeoutAtual,
  logAlertaOffline,
  registrarRecuperacaoSeNecessario,
  estaEmModoOffline,
};
