/**
 * Simulador de catraca Henry (Primme Acesso/Argos) via TCP, pro protocolo já
 * implementado em src/services/henryCatraca.service.js — serve pra testar,
 * SEM hardware real, tanto os comandos que o servidor/agente MANDAM pra
 * catraca (liberar, permitir_entrada, impedir_entrada, testar conexão)
 * quanto o fluxo de ESCUTA (agente-local/agente.js -> loopBiometria), onde é
 * a catraca quem envia um evento sem ter sido solicitada (leitura de digital
 * no próprio leitor).
 *
 * Uso:
 *   node scripts/simular-catraca-henry.js [porta]     (padrão: porta 4000)
 *
 * Com o simulador rodando, aponte HENRY_CATRACA_IP=127.0.0.1 e
 * HENRY_CATRACA_PORT=<porta> no .env do agente-local (ou do servidor, se
 * testando em modo TCP direto — ver catracaGateway.service.js) e rode o
 * agente/servidor normalmente contra ele.
 *
 * Comandos digitados no terminal do simulador (funcionam com um ou mais
 * clientes conectados agora via escutar(), ex.: agente-local com
 * BIOMETRIA_CATRACA_ATIVA=true rodando):
 *   bio <biometria_id>   — envia um evento de LEITURA DE BIOMETRIA de verdade
 *                           (campo de índice 1 preenchido, formato documentado
 *                           em agente-local/agente.js) pra todos os clientes
 *                           conectados agora.
 *   ruido                 — envia um evento "ruído" (campo de índice 1 vazio —
 *                           ex.: giro manual da catraca sem tocar o leitor),
 *                           que o agente deve IGNORAR por completo.
 *   sair                  — encerra o simulador.
 *
 * Qualquer comando de ação (liberar/permitir_entrada/impedir_entrada/testar)
 * recebido de um cliente é só logado no console — este simulador não precisa
 * responder nada, porque henryCatraca.service.js manda esses comandos com
 * aguardarResposta:false (não espera resposta da catraca de verdade).
 */

const net = require('net');
const readline = require('readline');

const PORTA = Number(process.argv[2]) || 4000;

const STX = 0x02;
const ETX = 0x03;

function checksum(bytes) {
  if (!bytes.length) return 0;
  let cs = bytes[0];
  for (let i = 1; i < bytes.length; i++) cs ^= bytes[i];
  return cs;
}

// Mesma lógica de montagem de frame de src/services/henryCatraca.service.js
// (função montarFrame) — duplicada aqui de propósito: este script simula o
// EQUIPAMENTO físico, então não deve depender do módulo cliente que ele
// mesmo está testando.
function montarFrame(index, mensagem) {
  const data = `${index}+${mensagem}`;
  const dataBuf = Buffer.from(data, 'latin1');
  const size = Buffer.from([dataBuf.length, 0x00]);
  const semStxEtx = Buffer.concat([size, dataBuf]);
  const cs = checksum(Array.from(semStxEtx));
  return Buffer.concat([Buffer.from([STX]), semStxEtx, Buffer.from([cs]), Buffer.from([ETX])]);
}

// Monta um frame de EVENTO (catraca -> cliente, não solicitado) — mesmo
// formato de frame de sempre, só que o "corpo" já vem com os três campos que
// interpretarResposta() espera encontrar separados por "+": command,
// errOrVersion e data (esse último é o que loopBiometria realmente usa,
// com subcampos internos separados por "]" — ver formato documentado em
// agente-local/agente.js).
function montarFrameEvento({ index = '00', command = 'EVENTO', errOrVersion = '00', data }) {
  return montarFrame(index, `${command}+${errOrVersion}+${data}`);
}

/** Interpreta (de forma simplificada) um frame recebido de um cliente — só pra log. */
function interpretarFrameRecebido(buf) {
  const bytes = Array.from(buf);
  if (!bytes.length || bytes[0] !== STX || bytes[bytes.length - 1] !== ETX) return null;
  const index = String.fromCharCode(bytes[3]) + String.fromCharCode(bytes[4]);
  let i = 6;
  let corpo = '';
  while (i < bytes.length - 2) { corpo += String.fromCharCode(bytes[i]); i++; }
  return { index, corpo };
}

const clientes = new Set();

const servidor = net.createServer((socket) => {
  clientes.add(socket);
  const endereco = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[simulador] Cliente conectado (${endereco}). Total conectado agora: ${clientes.size}`);

  socket.on('data', (chunk) => {
    const frame = interpretarFrameRecebido(chunk);
    if (!frame) {
      console.log(`[simulador] Frame ilegível recebido de ${endereco}: ${chunk.toString('latin1')}`);
      return;
    }
    console.log(`[simulador] Comando recebido de ${endereco} — index="${frame.index}" corpo="${frame.corpo}"`);
  });

  socket.on('close', () => {
    clientes.delete(socket);
    console.log(`[simulador] Cliente desconectado (${endereco}). Total conectado agora: ${clientes.size}`);
  });

  socket.on('error', () => {
    clientes.delete(socket);
  });
});

servidor.listen(PORTA, () => {
  console.log(`[simulador] Catraca Henry simulada ouvindo em 127.0.0.1:${PORTA}`);
  console.log('[simulador] Comandos disponíveis: "bio <biometria_id>", "ruido", "sair"');
});

function enviarParaTodos(frame, descricao) {
  if (!clientes.size) {
    console.log(`[simulador] Nenhum cliente conectado agora (ninguém chamando escutar()) — "${descricao}" não foi enviado a ninguém.`);
    return;
  }
  for (const socket of clientes) socket.write(frame);
  console.log(`[simulador] Evento "${descricao}" enviado para ${clientes.size} cliente(s).`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (linhaBruta) => {
  const linha = linhaBruta.trim();
  if (!linha) return;

  if (linha === 'sair') {
    console.log('[simulador] Encerrando.');
    process.exit(0);
  }

  if (linha === 'ruido') {
    // Formato documentado em agente-local/agente.js como "NÃO é leitura de
    // biometria" (campo de índice 1, dentro de `data`, vazio) — confirmado
    // contra testes reais em 08/07/2026 (giro manual da catraca).
    const agora = new Date().toLocaleString('pt-BR');
    const frame = montarFrameEvento({ data: `81]]${agora}]2]0]0g` });
    enviarParaTodos(frame, 'ruído (deve ser ignorado)');
    return;
  }

  const match = linha.match(/^bio\s+(\S+)$/);
  if (match) {
    const biometriaIdPadded = match[1].padStart(20, '0');
    const agora = new Date().toLocaleString('pt-BR');
    const frame = montarFrameEvento({ data: `0]${biometriaIdPadded}]${agora}]1]0]5I` });
    enviarParaTodos(frame, `biometria "${match[1]}"`);
    return;
  }

  console.log('[simulador] Comando não reconhecido. Use "bio <biometria_id>", "ruido" ou "sair".');
});
