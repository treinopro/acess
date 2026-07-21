/**
 * Cliente TCP/IP para catracas/relógios Henry (linha 7x: Primme Acesso 8X,
 * Primme Acesso SF, Argos). Fala diretamente o protocolo proprietário da
 * Henry por socket TCP (porta padrão 3000) — não depende do Kernel7x.dll,
 * de COM, nem de nenhum software terceiro (Secullum, etc). O equipamento
 * fica na mesma rede local do servidor/terminal.
 *
 * Protocolo (visão geral):
 *   Cada mensagem é um frame:  STX(0x02) + LEN(1 byte) + 0x00 + DADOS + CHECKSUM(1 byte) + ETX(0x03)
 *   DADOS = "<index 2 dígitos>+<comando>"
 *   CHECKSUM = XOR de todos os bytes entre STX e o próprio checksum (exclusive), ou seja, LEN+0x00+DADOS
 *
 * Referência de implementação: porta do protocolo documentado publicamente
 * para os chips Henry Primme Acesso 8X/SF e Argos (mesma família usada pelo
 * Kernel7x/Secullum). Ajuste comandos específicos conforme o manual do seu
 * equipamento se o modelo divergir.
 */

const net = require('net');

const STX = 0x02;
const ETX = 0x03;
const MSG_MAX_LEN = 1024;

// Tempo de liberação da catraca (quanto tempo ela fica destravada esperando
// a pessoa girar, antes de travar sozinha de novo), em décimos de segundo —
// 100 = 10.0s. 2026-07-19: antes não havia um valor pensado de propósito
// (ficava em 4s, "40", herdado do exemplo original) — 10s dá tempo suficiente
// pra girar sem segurar a catraca aberta por tempo demais entre uma pessoa e
// outra. Configurável via HENRY_RELEASE_TIME_DECIMOS (décimos de segundo) pra
// ajustar sem precisar mexer em código, caso o equipamento físico se comporte
// diferente do esperado — teste no equipamento real antes de confiar num
// valor novo em produção.
const RELEASE_TIME = String(Number(process.env.HENRY_RELEASE_TIME_DECIMOS) || 100);

function checksum(bytes) {
  if (!bytes.length) return 0;
  let cs = bytes[0];
  for (let i = 1; i < bytes.length; i++) cs ^= bytes[i];
  return cs;
}

function montarFrame(index, mensagem) {
  const data = `${index}+${mensagem}`;
  const dataBuf = Buffer.from(data, 'latin1');
  const size = Buffer.from([dataBuf.length, 0x00]);
  const semStxEtx = Buffer.concat([size, dataBuf]);
  const cs = checksum(Array.from(semStxEtx));
  return Buffer.concat([Buffer.from([STX]), semStxEtx, Buffer.from([cs]), Buffer.from([ETX])]);
}

function indexAleatorio() {
  const n = Math.floor(Math.random() * 10);
  return `${n}${n}`;
}

/**
 * Interpreta um frame de resposta recebido da catraca.
 * Lança erro se o frame não tiver STX/ETX nas posições esperadas.
 */
function interpretarResposta(buf) {
  const bytes = Array.from(buf);
  const length = bytes.length;
  if (!length || bytes[0] !== STX) throw new Error('Frame inválido: STX ausente.');
  if (bytes[length - 1] !== ETX) throw new Error('Frame inválido: ETX ausente.');

  const size = bytes[1];
  const index = String.fromCharCode(bytes[3]) + String.fromCharCode(bytes[4]);

  let i = 6;
  let command = '';
  while (i < length - 1 && bytes[i] !== 0x2b /* '+' */) { command += String.fromCharCode(bytes[i]); i++; }
  i++;
  let errOrVersion = '';
  while (i < length - 1 && bytes[i] !== 0x2b) { errOrVersion += String.fromCharCode(bytes[i]); i++; }
  i++;
  let data = '';
  while (i < length - 1) { data += String.fromCharCode(bytes[i]); i++; }

  return { size, index, command, errOrVersion, data, raw: buf };
}

/**
 * Envia um comando genérico e opcionalmente aguarda a resposta.
 * @param {object} opts
 * @param {string} opts.ip
 * @param {number} [opts.port=3000]
 * @param {string} opts.index - índice de 2 dígitos (string)
 * @param {string} opts.mensagem - corpo do comando, conforme protocolo Henry
 * @param {number} [opts.timeoutMs=5000]
 * @param {boolean} [opts.aguardarResposta=true]
 */
function enviarComando({ ip, port = 3000, index, mensagem, timeoutMs = 5000, aguardarResposta = true }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let finalizado = false;
    const frame = montarFrame(index, mensagem);

    const timer = setTimeout(() => {
      if (finalizado) return;
      finalizado = true;
      socket.destroy();
      reject(new Error(`Timeout ao comunicar com a catraca (${ip}:${port}).`));
    }, timeoutMs);

    socket.connect(port, ip, () => {
      socket.write(frame);
      if (!aguardarResposta) {
        finalizado = true;
        clearTimeout(timer);
        socket.end();
        resolve(null);
      }
    });

    socket.on('data', (chunk) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(interpretarResposta(chunk));
      } catch (err) {
        reject(err);
      }
    });

    socket.on('error', (err) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      reject(err);
    });

    socket.on('close', () => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Comando de abertura "solta" da catraca — usado pelo terminal/kiosk após
 * confirmar matrícula/pagamento do aluno, sem depender de leitura prévia de
 * cartão/RFID pela própria catraca (fluxo "escutar").
 */
async function liberarAcesso({ ip, port = 3000, mensagem = 'ACESSO LIBERADO', timeoutMs = 5000 }) {
  const index = indexAleatorio();
  const comando = `REON+00+4]${RELEASE_TIME}]${mensagem}]}1`;
  return enviarComando({ ip, port, index, mensagem: comando, timeoutMs, aguardarResposta: false });
}

/**
 * Confirma a liberação de entrada após a catraca ter enviado um evento (ex.:
 * leitura de RFID/biometria própria do equipamento) capturado via escutar().
 * Precisa do `index` retornado por escutar().
 */
async function permitirEntrada({ ip, port = 3000, index, mensagem = 'ENTRADA LIBERADA', timeoutMs = 5000 }) {
  const comando = `REON+00+6]${RELEASE_TIME}]${mensagem}]2`;
  return enviarComando({ ip, port, index, mensagem: comando, timeoutMs, aguardarResposta: false });
}

/**
 * Bloqueia a entrada após a catraca ter enviado um evento capturado via
 * escutar() (ex.: aluno inadimplente tentando passar com cartão próprio).
 */
async function impedirEntrada({ ip, port = 3000, index, mensagem = 'BLOQUEADO', timeoutMs = 5000 }) {
  const comando = `REON+00+30]${RELEASE_TIME}]${mensagem}]1`;
  return enviarComando({ ip, port, index, mensagem: comando, timeoutMs, aguardarResposta: false });
}

/**
 * Abre uma escuta bloqueante para capturar o próximo evento enviado pela
 * catraca (ex.: leitura de cartão/biometria feita no próprio equipamento).
 * Retorna { index, command, errOrVersion, data }.
 */
function escutar({ ip, port = 3000, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let finalizado = false;

    const timer = setTimeout(() => {
      if (finalizado) return;
      finalizado = true;
      socket.destroy();
      reject(new Error('_TIMEOUT_'));
    }, timeoutMs);

    socket.connect(port, ip, () => {});

    socket.on('data', (chunk) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(interpretarResposta(chunk));
      } catch (err) {
        reject(err);
      }
    });

    socket.on('error', (err) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Testa conectividade simples com a catraca (sem enviar comando algum). */
function testarConexao({ ip, port = 3000, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolvido = false;
    const timer = setTimeout(() => {
      if (resolvido) return;
      resolvido = true;
      socket.destroy();
      resolve({ ok: false, erro: 'timeout' });
    }, timeoutMs);

    socket.connect(port, ip, () => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timer);
      socket.end();
      resolve({ ok: true });
    });

    socket.on('error', (err) => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timer);
      resolve({ ok: false, erro: err.message });
    });
  });
}

module.exports = {
  liberarAcesso,
  permitirEntrada,
  impedirEntrada,
  escutar,
  enviarComando,
  testarConexao,
};
