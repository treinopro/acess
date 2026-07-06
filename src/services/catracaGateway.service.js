/**
 * Ponto único de acionamento da catraca Henry, usado por TODAS as rotas/
 * serviços do painel (totem, admin, pânico). Decide automaticamente entre
 * dois modos, sem precisar de configuração manual:
 *
 *   - "agente": se houver um agente local conectado (ver
 *     src/services/agenteGateway.service.js e a pasta `agente-local/`), o
 *     comando é repassado por WebSocket para ele, que fala TCP com a catraca
 *     de dentro da rede da academia. Modo necessário quando o painel está
 *     hospedado na nuvem (Northflank/Render) — a nuvem não alcança o IP
 *     privado da catraca.
 *
 *   - "direto": se nenhum agente estiver conectado, fala TCP diretamente
 *     daqui mesmo (src/services/henryCatraca.service.js). Funciona quando o
 *     servidor roda na mesma rede local da catraca (deploy 100% local/
 *     offline, sem depender de nada externo).
 *
 * As duas formas convivem: numa academia com o painel local, o modo "direto"
 * já funciona sem instalar nada a mais. Numa academia com o painel na nuvem,
 * basta rodar o agente local (pasta `agente-local/`) que o sistema passa a
 * usar o modo "agente" automaticamente, sem trocar nada nas telas do painel.
 */

const henry = require('./henryCatraca.service');
const agenteGateway = require('./agenteGateway.service');

function modoAtual() {
  return agenteGateway.estaConectado() ? 'agente' : 'direto';
}

/** Abertura "solta" da catraca (fluxo do totem e liberação manual do admin). */
async function liberarAcesso({ ip, port = 3000, mensagem = 'ACESSO LIBERADO', timeoutMs }) {
  if (agenteGateway.estaConectado()) {
    await agenteGateway.enviarComando('liberar', { ip, port, mensagem });
    return;
  }
  return henry.liberarAcesso({ ip, port, mensagem, timeoutMs });
}

/** Testa conectividade (TCP direto ou, se aplicável, TCP feito pelo agente). */
async function testarConexao({ ip, port = 3000, timeoutMs }) {
  const modo = modoAtual();
  if (modo === 'agente') {
    try {
      const resultado = await agenteGateway.enviarComando('testar', { ip, port });
      return { ...resultado, modo };
    } catch (err) {
      return { ok: false, erro: err.message, modo };
    }
  }
  const resultado = await henry.testarConexao({ ip, port, timeoutMs });
  return { ...resultado, modo };
}

/** Confirma entrada após evento capturado pela própria catraca (biometria/RFID). */
async function permitirEntrada({ ip, port = 3000, index, mensagem, timeoutMs }) {
  if (agenteGateway.estaConectado()) {
    await agenteGateway.enviarComando('permitir_entrada', { ip, port, index, mensagem });
    return;
  }
  return henry.permitirEntrada({ ip, port, index, mensagem, timeoutMs });
}

/** Bloqueia entrada após evento capturado pela própria catraca. */
async function impedirEntrada({ ip, port = 3000, index, mensagem, timeoutMs }) {
  if (agenteGateway.estaConectado()) {
    await agenteGateway.enviarComando('impedir_entrada', { ip, port, index, mensagem });
    return;
  }
  return henry.impedirEntrada({ ip, port, index, mensagem, timeoutMs });
}

/** Status do agente local, para o painel mostrar "agente conectado" ou não. */
function statusAgente() {
  return { ...agenteGateway.status(), modo: modoAtual() };
}

module.exports = {
  modoAtual,
  liberarAcesso,
  testarConexao,
  permitirEntrada,
  impedirEntrada,
  statusAgente,
};
