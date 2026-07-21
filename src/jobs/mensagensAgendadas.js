/**
 * Job de disparo de mensagens agendadas (2026-07-21) — só cobre o canal
 * e-mail, que é o único que pode ser enviado automaticamente de verdade
 * (WhatsApp continua exigindo o admin clicar/mandar ele mesmo, sem exceção —
 * ver comentário no topo da seção "Agendamento de envio" em
 * recuperacao.routes.js). Roda a cada minuto (ver setInterval em
 * server.js), buscando quem tem `agendado_para` já vencido e ainda
 * 'pendente'.
 */
const recuperacaoRoutes = require('../routes/recuperacao.routes');

async function rodar() {
  const processados = await recuperacaoRoutes.processarPendentesEmailAgendados();
  if (processados) {
    console.log(`[mensagensAgendadas] ${processados} mensagem(ns) agendada(s) de e-mail processada(s).`);
  }
  return processados;
}

module.exports = { rodar };
