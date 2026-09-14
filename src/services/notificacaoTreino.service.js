/**
 * Aviso automático (push) pro aluno quando o professor cadastra um treino
 * NOVO ou atualiza um já existente (exercício adicionado/editado/removido,
 * treino renomeado etc). Segue o padrão "Seguro" (nunca lança) usado no
 * resto do app: quem chama não precisa (nem deve) tratar erro daqui — a
 * mudança no treino já aconteceu de verdade antes disso rodar.
 *
 * 2026-09-14: e-mail removido de propósito (pedido explícito do dono) — só
 * push agora. E cada chamada não dispara mais um push na hora: fica
 * pendente por JANELA_DEBOUNCE_MS pra aluno, e se chegar outra mudança
 * pro MESMO aluno dentro dessa janela (comum: professor ajusta a carga de
 * vários exercícios em sequência, ou mexe em mais de um treino do mesmo
 * aluno de uma vez), tudo vira UM push só quando a janela fecha, em vez de
 * um push por exercício/treino alterado.
 */

const webPush = require('./webPush.service');

const ASSUNTO_NOVO_TREINO = 'Novo treino disponível';
const ASSUNTO_TREINO_ATUALIZADO = 'Seu treino foi atualizado';

const JANELA_DEBOUNCE_MS = 4000;

// alunoId -> { eventos: [{ tipo, treinoNome, detalhe }], timer }
const pendentesPorAluno = new Map();

function agendarPush(alunoId, evento) {
  let estado = pendentesPorAluno.get(alunoId);
  if (!estado) {
    estado = { eventos: [] };
    pendentesPorAluno.set(alunoId, estado);
  } else if (estado.timer) {
    clearTimeout(estado.timer);
  }
  estado.eventos.push(evento);
  estado.timer = setTimeout(() => dispararPushPendente(alunoId), JANELA_DEBOUNCE_MS);
}

async function dispararPushPendente(alunoId) {
  const estado = pendentesPorAluno.get(alunoId);
  if (!estado) return;
  pendentesPorAluno.delete(alunoId);
  const eventos = estado.eventos;

  var titulo;
  var corpo;
  if (eventos.length === 1) {
    var ev = eventos[0];
    titulo = ev.tipo === 'novo' ? ASSUNTO_NOVO_TREINO : ASSUNTO_TREINO_ATUALIZADO;
    corpo = ev.tipo === 'novo'
      ? `Seu professor criou o treino "${ev.treinoNome}". Toque para ver.`
      : (ev.detalhe ? `${ev.treinoNome}: ${ev.detalhe}` : `Seu treino "${ev.treinoNome}" foi atualizado. Toque para ver.`);
  } else {
    var treinos = [...new Set(eventos.map((e) => e.treinoNome))];
    titulo = ASSUNTO_TREINO_ATUALIZADO;
    corpo = treinos.length === 1
      ? `${eventos.length} alterações em "${treinos[0]}". Toque para ver.`
      : `Seu professor fez ${eventos.length} alterações em ${treinos.length} treinos. Toque para ver.`;
  }

  try {
    // webPush.enviarParaAluno já é best-effort por dentro (nunca lança) —
    // silenciosamente não faz nada se o aluno não tiver nenhum dispositivo
    // inscrito, ou se o push não estiver configurado no servidor (VAPID).
    await webPush.enviarParaAluno(alunoId, {
      titulo, corpo, url: '/portal.html', tag: 'treino-atualizado',
    });
  } catch { /* enviarParaAluno já não lança — só por segurança extra */ }
}

/**
 * Agenda o aviso de treino NOVO pro aluno. Nunca lança — chamada
 * fire-and-forget logo depois do INSERT em POST /api/treinos
 * (treinos.routes.js).
 */
function notificarNovoTreinoSeguro({ id }, { treinoNome }) {
  agendarPush(id, { tipo: 'novo', treinoNome });
}

/**
 * Agenda o aviso de que um treino já existente do aluno foi alterado —
 * exercício editado (ex.: carga ajustada), adicionado, removido, ou o
 * treino em si renomeado/reconfigurado. Pedido explícito do dono do
 * sistema (2026-08-27): "quando o professor fizer qualquer atualização
 * nos treinos o aluno deve ser notificado". Nunca lança — chamada
 * fire-and-forget nos pontos de edição de treinos.routes.js. `detalhe` é
 * um resumo curto opcional (ex.: "carga do exercício Supino ajustada"),
 * usado só quando esta é a ÚNICA mudança pendente pro aluno no momento em
 * que o push sai (ver dispararPushPendente acima) — várias mudanças
 * juntas viram uma mensagem resumida, não uma lista.
 */
function notificarAtualizacaoTreinoSeguro({ id }, { treinoNome, detalhe }) {
  agendarPush(id, { tipo: 'atualizacao', treinoNome, detalhe });
}

module.exports = {
  ASSUNTO_NOVO_TREINO, notificarNovoTreinoSeguro, ASSUNTO_TREINO_ATUALIZADO, notificarAtualizacaoTreinoSeguro,
};
