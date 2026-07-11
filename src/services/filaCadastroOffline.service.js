/**
 * Fila local (outbox) de ALTERAÇÕES DE CADASTRO feitas no "modo totem
 * offline-resiliente" (MODO_TOTEM_OFFLINE=true) quando o Turso não responde
 * na hora — ex.: editar dados de um aluno, trancar/liberar manualmente, ou
 * registrar um pagamento na recepção. Mesma filosofia de arquivo .jsonl da
 * fila de acessos (ver filaAcessosOffline.service.js), mas com uma diferença
 * importante: aqui NUNCA aplicamos a alteração de volta no Turso às cegas.
 *
 * Regra de conflito (pedida pelo dono do sistema, 2026-07): quando a conexão
 * voltar e formos sincronizar uma pendência, primeiro conferimos se o valor
 * atual no Turso ainda é o mesmo que estava quando a edição foi feita offline
 * (guardado em `valoresAnterioresConhecidos`/`statusConhecidoAntes` no
 * momento da tentativa). Se ninguém mexeu nisso enquanto estava offline,
 * aplicamos automaticamente. Se algo mudou (ex.: um pagamento chegou pelo
 * Mercado Pago, ou o job de recorrência gerou algo novo, ou outra pessoa
 * editou o mesmo aluno por outro caminho), a pendência fica marcada como
 * "conflito" e NUNCA é aplicada sozinha — fica esperando o admin decidir, no
 * painel ("Pendências de sincronização"), se mantém o valor atual do Turso ou
 * aplica a edição feita offline mesmo assim.
 *
 * Isso é deliberadamente mais conservador que a fila de acessos: cadastro e
 * financeiro são dados com estado (podem ter mudado por outro caminho
 * enquanto a academia estava offline), diferente de um acesso (que é só um
 * registro novo, nunca sobrescreve nada). Evita repetir o tipo de bug que já
 * causou o incidente de "cobrança fantasma" antes.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('../db/client');

const CAMINHO_FILA = process.env.CAMINHO_FILA_CADASTRO_TOTEM || path.join(__dirname, '..', '..', 'fila-cadastro-totem.jsonl');
const CAMINHO_FILA_TMP = `${CAMINHO_FILA}.tmp`;

function log(...args) {
  console.log(`[filaCadastroOffline ${new Date().toISOString()}]`, ...args);
}

/** Lê todos os itens da fila (pendentes de aplicar + já marcados em conflito). Tolerante a linhas corrompidas. */
function listarPendentes() {
  if (!fs.existsSync(CAMINHO_FILA)) return [];
  let bruto;
  try {
    bruto = fs.readFileSync(CAMINHO_FILA, 'utf8');
  } catch (err) {
    log('Falha ao ler a fila local de cadastro:', err.message);
    return [];
  }
  const itens = [];
  for (const linha of bruto.split('\n')) {
    const linhaLimpa = linha.trim();
    if (!linhaLimpa) continue;
    try {
      itens.push(JSON.parse(linhaLimpa));
    } catch {
      log('Linha ilegível na fila local de cadastro, ignorando:', linhaLimpa.slice(0, 100));
    }
  }
  return itens;
}

/** Regrava o arquivo inteiro de forma atômica (tmp+rename) — usado depois de aplicar/descartar/marcar conflito. */
function regravarArquivo(itens) {
  try {
    fs.writeFileSync(CAMINHO_FILA_TMP, itens.map((item) => JSON.stringify(item)).join('\n') + (itens.length ? '\n' : ''));
    fs.renameSync(CAMINHO_FILA_TMP, CAMINHO_FILA);
  } catch (err) {
    log('Falha ao regravar a fila local de cadastro (tentativa será refeita no próximo flush, sem problema):', err.message);
  }
}

/**
 * Registra uma pendência (edição que falhou contra o Turso). `item` já vem
 * montado pelo chamador (ver acessoTerminal.service.js e as rotas que usam
 * esta fila) com o formato certo pro `tipo` (`update_campo` ou `pagamento`).
 */
function registrar(item) {
  const registro = {
    id: uuid(),
    criadoEm: new Date().toISOString(),
    conflito: false,
    valoresAtuaisNoConflito: null,
    ...item,
  };
  try {
    fs.appendFileSync(CAMINHO_FILA, `${JSON.stringify(registro)}\n`);
  } catch (err) {
    log('Falha ao gravar pendência de cadastro na fila local (a alteração pode ser perdida — considere refazer manualmente quando a internet voltar):', err.message);
  }
  return registro;
}

/** Lê do TURSO (só chamado durante o flush, quando já sabemos que ele está respondendo) os valores atuais das colunas pedidas. */
async function lerValoresAtuaisNoTurso(tabela, registroId, colunas) {
  const result = await db.execute({ sql: `SELECT ${colunas.join(', ')} FROM ${tabela} WHERE id = ?`, args: [registroId] });
  return result.rows[0] || null;
}

async function aplicarUpdateCampo(item) {
  const colunas = Object.keys(item.campos);
  const sets = colunas.map((c) => `${c} = ?`).join(', ');
  const args = [...colunas.map((c) => item.campos[c]), item.registroId];
  await db.execute({ sql: `UPDATE ${item.tabela} SET ${sets} WHERE id = ?`, args });
}

// Nota deliberada (mesmo padrão de filaAcessosOffline.service.js): reimplementa
// uma versão mínima de "aplicar pagamento + recalcular status da cobrança" em
// vez de importar de pagamentos.routes.js, pra evitar require circular. Se a
// regra de quitação mudar lá, ajuste aqui também.
async function aplicarPagamentoEAtualizarStatus(item) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO pagamentos_cobranca (id, cobranca_id, data, valor_centavos, tipo, conta_corrente)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [item.pagamentoId, item.registroId, item.pagamento.data, item.pagamento.valor_centavos,
      item.pagamento.tipo || null, item.pagamento.conta_corrente || null],
  });

  const cobranca = await lerValoresAtuaisNoTurso('cobrancas', item.registroId, ['id', 'aluno_id', 'valor_centavos', 'status']);
  if (!cobranca) return;

  const somaResult = await db.execute({
    sql: `SELECT COALESCE(SUM(valor_centavos), 0) as total, MAX(data) as ultima_data FROM pagamentos_cobranca WHERE cobranca_id = ?`,
    args: [item.registroId],
  });
  const { total, ultima_data: ultimaData } = somaResult.rows[0];

  if (cobranca.status === 'cancelado' || cobranca.status === 'estornado') return;

  if (Number(total) >= cobranca.valor_centavos) {
    await db.execute({ sql: `UPDATE cobrancas SET status = 'pago', pago_em = ? WHERE id = ?`, args: [ultimaData, item.registroId] });
  } else {
    const vencida = item.pagamento.data && item.pagamento.data < new Date().toISOString().slice(0, 10);
    await db.execute({ sql: `UPDATE cobrancas SET status = ?, pago_em = NULL WHERE id = ?`, args: [vencida ? 'atrasado' : 'pendente', item.registroId] });
  }
}

let flushEmAndamento = false;

/**
 * Tenta aplicar cada pendência ainda não resolvida (`conflito: false`) contra
 * o Turso. Pra cada uma, primeiro CONFERE se o estado que ela esperava ainda
 * bate com o que está no Turso agora — só aplica automaticamente se bater. Se
 * não bater, marca `conflito: true` (guardando o valor atual pra mostrar no
 * painel) e deixa esperando decisão manual — nunca reaplica sozinha depois
 * disso (evita martelar o mesmo conflito a cada flush).
 */
async function flush() {
  if (flushEmAndamento) return;
  const todos = listarPendentes();
  const pendentesNaoResolvidas = todos.filter((item) => !item.conflito);
  if (!pendentesNaoResolvidas.length) return;

  flushEmAndamento = true;
  const idsAplicados = new Set();
  const conflitosNovos = new Map(); // id -> item atualizado com conflito

  try {
    for (const item of pendentesNaoResolvidas) {
      try {
        if (item.tipo === 'update_campo') {
          const colunas = Object.keys(item.campos);
          const atual = await lerValoresAtuaisNoTurso(item.tabela, item.registroId, colunas);
          if (!atual) {
            // Registro não existe mais (ex.: aluno excluído enquanto estava offline) — não há o que aplicar.
            idsAplicados.add(item.id);
            log(`Pendência ${item.id} (${item.descricaoResumo}) descartada — registro não existe mais no Turso.`);
            continue;
          }
          const divergiu = colunas.some((c) => String(atual[c] ?? '') !== String((item.valoresAnterioresConhecidos || {})[c] ?? ''));
          if (divergiu) {
            conflitosNovos.set(item.id, { ...item, conflito: true, valoresAtuaisNoConflito: atual });
            log(`Conflito de sincronização detectado — pendência ${item.id} (${item.descricaoResumo}) aguardando decisão manual no painel.`);
            continue;
          }
          await aplicarUpdateCampo(item);
          idsAplicados.add(item.id);
        } else if (item.tipo === 'pagamento') {
          const atual = await lerValoresAtuaisNoTurso('cobrancas', item.registroId, ['status']);
          if (!atual) {
            idsAplicados.add(item.id);
            log(`Pendência de pagamento ${item.id} descartada — conta não existe mais no Turso.`);
            continue;
          }
          if (atual.status !== item.statusConhecidoAntes) {
            conflitosNovos.set(item.id, { ...item, conflito: true, valoresAtuaisNoConflito: atual });
            log(`Conflito de sincronização detectado — pendência de pagamento ${item.id} aguardando decisão manual no painel.`);
            continue;
          }
          await aplicarPagamentoEAtualizarStatus(item);
          idsAplicados.add(item.id);
        }
      } catch (err) {
        // Mesma filosofia da fila de acessos: se uma pendência falhar (provavelmente
        // o Turso caiu de novo no meio do flush), para por aqui e tenta tudo de novo
        // no próximo flush, em vez de martelar as seguintes.
        log(`Falha aplicando pendência ${item.id}, parando por aqui e tentando de novo no próximo flush:`, err.message);
        break;
      }
    }
  } finally {
    flushEmAndamento = false;
  }

  if (idsAplicados.size || conflitosNovos.size) {
    const restantes = todos
      .filter((item) => !idsAplicados.has(item.id))
      .map((item) => conflitosNovos.get(item.id) || item);
    regravarArquivo(restantes);

    if (idsAplicados.size) {
      log(`${idsAplicados.size} pendência(s) de cadastro sincronizada(s) com o Turso.`);
    }
  }
}

/**
 * Resolução manual de uma pendência em conflito (chamado pelo painel,
 * "Pendências de sincronização"): `decisao` é 'aplicar' (usa o valor editado
 * offline mesmo assim, sobrescrevendo o que está no Turso agora) ou
 * 'descartar' (mantém o que já está no Turso, joga fora a edição offline).
 */
async function resolverPendencia(id, decisao) {
  const todos = listarPendentes();
  const item = todos.find((i) => i.id === id);
  if (!item) {
    const erro = new Error('Pendência não encontrada (pode já ter sido resolvida).');
    erro.status = 404;
    throw erro;
  }

  if (decisao === 'descartar') {
    regravarArquivo(todos.filter((i) => i.id !== id));
    return { ok: true, descartado: true };
  }
  if (decisao === 'aplicar') {
    if (item.tipo === 'update_campo') {
      await aplicarUpdateCampo(item);
    } else if (item.tipo === 'pagamento') {
      await aplicarPagamentoEAtualizarStatus(item);
    }
    regravarArquivo(todos.filter((i) => i.id !== id));
    return { ok: true, aplicado: true };
  }
  const erro = new Error('Decisão inválida — use "aplicar" ou "descartar".');
  erro.status = 400;
  throw erro;
}

module.exports = { registrar, listarPendentes, flush, resolverPendencia };
