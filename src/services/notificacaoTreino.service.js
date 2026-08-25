/**
 * Aviso automático (push + e-mail) pro aluno quando o professor cadastra um
 * treino NOVO pra ele (2026-08-24) — disparado só na criação do treino em si
 * (POST /api/treinos), nunca ao adicionar/editar um exercício dentro de um
 * treino já existente. Segue o mesmo padrão "Seguro" (nunca lança) usado em
 * emailBoasVindas.service.js: quem chama não precisa (nem deve) tratar erro
 * daqui — a criação do treino já aconteceu de verdade antes disso rodar.
 */

const { v4: uuid } = require('uuid');
const db = require('../db/client');
const emailService = require('./email.service');
const webPush = require('./webPush.service');

const ASSUNTO_NOVO_TREINO = 'Novo treino disponível';

function primeiroNome(nomeCompleto) {
  return String(nomeCompleto || '').trim().split(/\s+/)[0] || nomeCompleto;
}

function obterAppUrl() {
  const valor = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return valor || null;
}

function montarMensagemNovoTreino({ nome, treinoNome, linkPortal }) {
  const linhas = [
    `Olá ${primeiroNome(nome)}! Seu professor acabou de montar um novo treino pra você: "${treinoNome}".`,
    '',
    'Acesse o Portal do Aluno para ver os exercícios completos:',
    linkPortal || 'Peça o link do Portal do Aluno na recepção.',
  ];
  return linhas.join('\n');
}

/**
 * Monta e envia o e-mail de novo treino pra UM aluno. Lança erro se não for
 * possível (aluno sem e-mail, envio não configurado no servidor, Gmail
 * recusando etc.) — quem chama decide se trata isso como best-effort (ver
 * notificarNovoTreinoSeguro abaixo).
 */
async function enviarEmailNovoTreino({ id, nome, email }, { treinoNome }) {
  if (!email) throw new Error('Aluno sem e-mail cadastrado.');
  if (!emailService.emailConfigurado()) throw new Error('Envio de e-mail não configurado no servidor.');

  const appUrl = obterAppUrl();
  const linkPortal = appUrl ? `${appUrl}/portal.html` : null;
  const mensagem = montarMensagemNovoTreino({ nome, treinoNome, linkPortal });

  await emailService.enviarEmail({ para: email, assunto: ASSUNTO_NOVO_TREINO, texto: mensagem });
  await db.execute({
    sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, assunto, mensagem, destino, status)
          VALUES (?, ?, 'email', ?, ?, ?, 'enviado')`,
    args: [uuid(), id, ASSUNTO_NOVO_TREINO, mensagem, email],
  });
}

/**
 * Notifica o aluno (push + e-mail) que um treino novo foi criado pra ele.
 * Nunca lança — chamada logo depois do INSERT em POST /api/treinos
 * (treinos.routes.js), sem `await` (fire-and-forget), pra não atrasar a
 * resposta da criação do treino em si por causa de push/e-mail lento ou
 * indisponível.
 */
async function notificarNovoTreinoSeguro({ id, nome, email }, { treinoNome }) {
  // Push: webPush.enviarParaAluno já é best-effort por dentro (nunca lança) —
  // silenciosamente não faz nada se o aluno não tiver nenhum dispositivo
  // inscrito, ou se o push não estiver configurado no servidor (VAPID).
  try {
    await webPush.enviarParaAluno(id, {
      titulo: ASSUNTO_NOVO_TREINO,
      corpo: `Seu professor criou o treino "${treinoNome}". Toque para ver.`,
      url: '/portal.html',
      tag: 'novo-treino',
    });
  } catch { /* enviarParaAluno já não lança — só por segurança extra, nunca deixa isso quebrar o e-mail abaixo */ }

  try {
    await enviarEmailNovoTreino({ id, nome, email }, { treinoNome });
  } catch (err) {
    try {
      await db.execute({
        sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, assunto, mensagem, destino, status, erro)
              VALUES (?, ?, 'email', ?, '', ?, 'erro', ?)`,
        args: [uuid(), id, ASSUNTO_NOVO_TREINO, email || null, err.message],
      });
    } catch {
      // Se nem o log conseguir gravar, não há mais nada de seguro a fazer
      // aqui — best-effort de verdade (mesma lógica de emailBoasVindas.service.js).
    }
  }
}

module.exports = { ASSUNTO_NOVO_TREINO, notificarNovoTreinoSeguro };
