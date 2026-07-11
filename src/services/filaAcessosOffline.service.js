/**
 * Fila local (outbox) de registros de acesso do TOTEM (facial/QR/CPF) —
 * mesma filosofia e mesmo formato em disco da fila já usada pra biometria da
 * catraca (ver agente-local/filaAcessos.js), só que rodando dentro do mesmo
 * processo do totem em vez de precisar de HTTP entre duas máquinas.
 *
 * Só é usada quando MODO_TOTEM_OFFLINE=true e uma gravação em acessos_catraca
 * falha contra o Turso (ver acessoTerminal.registrarAcesso) — o evento é
 * gravado aqui em vez de perdido, e reenviado automaticamente (flush()) assim
 * que o Turso voltar a responder.
 *
 * Formato em disco: `fila-acessos-totem.jsonl` (uma linha JSON por evento,
 * append-only) — cada evento já tem o `id` (UUID) que o teria no banco, então
 * o reenvio usa INSERT OR IGNORE (idempotente): reenviar o mesmo evento duas
 * vezes (ex.: o processo reiniciou antes de confirmar) nunca duplica o
 * registro.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/client');
const dbResiliente = require('./dbResiliente.service');

const CAMINHO_FILA = process.env.CAMINHO_FILA_ACESSOS_TOTEM || path.join(__dirname, '..', '..', 'fila-acessos-totem.jsonl');
const CAMINHO_FILA_TMP = `${CAMINHO_FILA}.tmp`;

function log(...args) {
  console.log(`[filaAcessosOffline ${new Date().toISOString()}]`, ...args);
}

/**
 * Acrescenta um evento de acesso à fila em disco. Síncrono e best-effort de
 * propósito: se a escrita falhar (disco cheio etc.), loga o erro mas nunca
 * lança — o pior caso é perder o REGISTRO desse acesso específico, nunca
 * travar a decisão de liberar (que já foi tomada antes desta chamada).
 *
 * @param {{id: string, alunoId: string|null, metodo: string, resultado: string, mensagem: string|null, criadoEm: string}} evento
 */
function registrar(evento) {
  try {
    fs.appendFileSync(CAMINHO_FILA, `${JSON.stringify(evento)}\n`);
  } catch (err) {
    log('Falha ao gravar evento na fila local (seguindo sem persistir este registro de acesso):', err.message);
  }
}

/**
 * Lê todos os eventos pendentes na fila. Tolerante a linhas corrompidas
 * (ex.: gravação interrompida por queda de energia no meio de um
 * appendFileSync) — pula a linha ilegível em vez de descartar a fila
 * inteira.
 */
function listarPendentes() {
  if (!fs.existsSync(CAMINHO_FILA)) return [];
  let bruto;
  try {
    bruto = fs.readFileSync(CAMINHO_FILA, 'utf8');
  } catch (err) {
    log('Falha ao ler a fila local:', err.message);
    return [];
  }
  const eventos = [];
  for (const linha of bruto.split('\n')) {
    const linhaLimpa = linha.trim();
    if (!linhaLimpa) continue;
    try {
      eventos.push(JSON.parse(linhaLimpa));
    } catch {
      log('Linha ilegível na fila local, ignorando:', linhaLimpa.slice(0, 100));
    }
  }
  return eventos;
}

/**
 * Remove da fila os eventos cujo `id` está em `idsEnviados` (confirmados no
 * Turso). Reescreve o arquivo inteiro de forma atômica (tmp+rename).
 */
function marcarEnviados(idsEnviados) {
  if (!idsEnviados || !idsEnviados.length) return;
  const confirmados = new Set(idsEnviados);
  const restantes = listarPendentes().filter((evento) => !confirmados.has(evento.id));
  try {
    fs.writeFileSync(CAMINHO_FILA_TMP, restantes.map((evento) => JSON.stringify(evento)).join('\n') + (restantes.length ? '\n' : ''));
    fs.renameSync(CAMINHO_FILA_TMP, CAMINHO_FILA);
  } catch (err) {
    log('Falha ao regravar a fila local após confirmação (eventos já enviados podem ser reenviados no próximo flush, sem problema — o Turso é idempotente):', err.message);
  }
}

// Nota deliberada: esta gravação reimplementa a mesma SQL de
// acessoTerminal.registrarAcessoIdempotente (INSERT OR IGNORE, pela mesma
// PK). É uma pequena duplicação aceita de propósito pra evitar um require
// circular entre este arquivo e acessoTerminal.service.js — se o esquema de
// acessos_catraca mudar, ajuste os dois lugares.
async function gravarNoTurso(evento) {
  if (evento.criadoEm) {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem, criado_em) VALUES (?, ?, ?, ?, ?, ?)',
      args: [evento.id, evento.alunoId || null, evento.metodo, evento.resultado, evento.mensagem || null, evento.criadoEm],
    });
  } else {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem) VALUES (?, ?, ?, ?, ?)',
      args: [evento.id, evento.alunoId || null, evento.metodo, evento.resultado, evento.mensagem || null],
    });
  }
}

let flushEmAndamento = false;

/**
 * Tenta esvaziar a fila local reenviando cada evento pendente pro Turso.
 * Nunca lança: falha aqui só significa "os eventos continuam na fila, tenta
 * de novo no próximo flush" (chamado por timer periódico — ver server.js).
 */
async function flush() {
  if (flushEmAndamento) return;
  const pendentes = listarPendentes();
  if (!pendentes.length) return;

  flushEmAndamento = true;
  const enviados = [];
  try {
    for (const evento of pendentes) {
      try {
        await gravarNoTurso(evento);
        enviados.push(evento.id);
      } catch (err) {
        // Se um evento falhou, os próximos provavelmente vão falhar pela
        // mesma causa (Turso ainda fora) — para o loop aqui em vez de
        // martelar N tentativas fadadas a falhar, e tenta todos de novo no
        // próximo flush.
        log(`Falha reenviando evento ${evento.id} (${enviados.length}/${pendentes.length} confirmados nesta rodada), parando por aqui:`, err.message);
        break;
      }
    }
  } finally {
    flushEmAndamento = false;
  }

  if (enviados.length) {
    marcarEnviados(enviados);
    dbResiliente.registrarRecuperacaoSeNecessario();
    const restantes = pendentes.length - enviados.length;
    log(`${enviados.length} evento(s) de acesso reenviado(s) ao Turso e removido(s) da fila local${restantes ? ` (${restantes} ainda pendente(s))` : ''}.`);
  }
}

module.exports = { registrar, listarPendentes, marcarEnviados, flush };
