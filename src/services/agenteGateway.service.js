/**
 * Gateway WebSocket para o "agente local" — um processo Node.js pequeno,
 * rodando num PC dentro da rede da academia (ver pasta `agente-local/` na raiz
 * do repositório), que é o único a falar TCP de verdade com a catraca Henry
 * quando este painel está hospedado na nuvem (Northflank/Render). A nuvem não
 * alcança o IP privado da catraca (ex.: 192.168.0.x) — por isso o agente
 * conecta DE DENTRO da rede local PARA FORA, até este servidor, e fica
 * esperando comandos.
 *
 * Fluxo:
 *   1. Agente local abre uma conexão WebSocket de saída para
 *      wss://<servidor>/agente/socket?token=AGENTE_TOKEN.
 *   2. Este módulo valida o token, guarda a conexão (só uma por vez — 1
 *      academia = 1 agente, por enquanto).
 *   3. Quando o painel admin pede uma ação na catraca (ver
 *      catracaGateway.service.js), este módulo manda `{ id, tipo, payload }`
 *      pro agente e espera a resposta `{ id, ok, resultado?, erro? }`,
 *      casando pelo `id` (uuid), com timeout.
 *
 * Se nenhum agente estiver conectado, catracaGateway.service.js cai para a
 * conexão TCP direta (modo "local/offline": servidor e catraca na mesma
 * rede) — este módulo só entra em cena quando existe um agente conectado.
 */

const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const CAMINHO_WS = '/agente/socket';
const PING_INTERVALO_MS = 30000;
const TIMEOUT_PADRAO_MS = 10000;

let wss = null;
let agenteSocket = null;
let conectadoDesde = null;
let ultimoPong = null;
const pendentes = new Map(); // id -> { resolve, reject, timer }

function rejeitarTodosPendentes(mensagem) {
  for (const [id, { reject, timer }] of pendentes) {
    clearTimeout(timer);
    reject(new Error(mensagem));
    pendentes.delete(id);
  }
}

function limparAgente() {
  agenteSocket = null;
  conectadoDesde = null;
  ultimoPong = null;
  rejeitarTodosPendentes('Conexão com o agente local foi encerrada.');
}

function tratarMensagem(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return; // mensagem inválida, ignora
  }
  if (!msg || !msg.id || !pendentes.has(msg.id)) return;

  const { resolve, reject, timer } = pendentes.get(msg.id);
  clearTimeout(timer);
  pendentes.delete(msg.id);

  if (msg.ok) resolve(msg.resultado);
  else reject(new Error(msg.erro || 'Erro desconhecido reportado pelo agente local.'));
}

/**
 * Liga o servidor WebSocket a um http.Server já criado (feito em server.js).
 * Usa `noServer: true` + evento 'upgrade' manual para poder validar o token
 * antes de aceitar a conexão (e para dividir a mesma porta com o Express).
 */
function attach(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== CAMINHO_WS) return; // deixa outros upgrades (se houver) passarem

    const token = url.searchParams.get('token');
    const esperado = process.env.AGENTE_TOKEN;
    if (!esperado) {
      console.error('[agenteGateway] AGENTE_TOKEN não configurado no servidor — recusando conexão do agente.');
      socket.destroy();
      return;
    }
    if (token !== esperado) {
      console.warn('[agenteGateway] Tentativa de conexão do agente com token inválido.');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    // Só um agente por vez: se já havia um conectado, encerra o antigo.
    if (agenteSocket) {
      try { agenteSocket.terminate(); } catch { /* ignora */ }
    }
    agenteSocket = ws;
    agenteSocket.isAlive = true;
    conectadoDesde = new Date().toISOString();
    ultimoPong = new Date().toISOString();
    console.log('[agenteGateway] Agente local conectado.');

    ws.on('message', tratarMensagem);
    ws.on('pong', () => {
      ws.isAlive = true;
      ultimoPong = new Date().toISOString();
    });
    ws.on('close', () => {
      if (agenteSocket === ws) {
        console.log('[agenteGateway] Agente local desconectou.');
        limparAgente();
      }
    });
    ws.on('error', () => {
      if (agenteSocket === ws) limparAgente();
    });
  });

  // Heartbeat: derruba a conexão se o agente não responder a um "pong" dentro
  // do intervalo (queda de rede sem fechar o socket "educadamente" — comum em
  // quedas de energia/internet do PC do agente).
  setInterval(() => {
    if (!agenteSocket) return;
    if (agenteSocket.isAlive === false) {
      agenteSocket.terminate(); // dispara 'close' -> limparAgente()
      return;
    }
    agenteSocket.isAlive = false;
    try {
      agenteSocket.ping();
    } catch {
      limparAgente();
    }
  }, PING_INTERVALO_MS).unref();
}

function estaConectado() {
  return Boolean(agenteSocket && agenteSocket.readyState === WebSocket.OPEN);
}

function status() {
  return {
    conectado: estaConectado(),
    conectado_desde: conectadoDesde,
    ultimo_pong: ultimoPong,
  };
}

/**
 * Envia um comando ao agente e espera a resposta, casando pelo `id`.
 * Rejeita se não houver agente conectado ou se ele não responder a tempo.
 */
function enviarComando(tipo, payload = {}, { timeoutMs = TIMEOUT_PADRAO_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!estaConectado()) {
      reject(new Error('Agente local não está conectado.'));
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendentes.delete(id);
      reject(new Error('Agente local não respondeu a tempo.'));
    }, timeoutMs);

    pendentes.set(id, { resolve, reject, timer });

    try {
      agenteSocket.send(JSON.stringify({ id, tipo, payload }));
    } catch (err) {
      clearTimeout(timer);
      pendentes.delete(id);
      reject(err);
    }
  });
}

module.exports = {
  attach,
  estaConectado,
  status,
  enviarComando,
};
