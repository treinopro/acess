/**
 * Broadcast leve (Server-Sent Events) do servidor para o(s) totem(s)
 * conectados via navegador — usado só pra empurrar "a catraca acabou de
 * liberar" em tempo real, pra tocar o som/tela verde de confirmação no
 * totem "o mais rápido possível" (2026-07-22, pedido explícito do dono do
 * sistema): toda liberação manual (painel admin, tela de liberação rápida
 * dos funcionários) ou pela própria biometria da catraca (leitor físico,
 * sem passar pela câmera do totem) precisa acender a tela verde + tocar o
 * aviso sonoro do totem, não só as liberações feitas pela própria câmera
 * dele.
 *
 * Não é WebSocket de propósito: só precisamos empurrar em UMA direção
 * (servidor -> navegador do totem), então Server-Sent Events já resolve com
 * bem menos código — EventSource é nativo do navegador e reconecta sozinho
 * se a conexão cair, sem precisar reimplementar isso aqui (diferente do
 * agenteGateway.service.js, que É bidirecional de propósito — comando vai,
 * resposta volta — e por isso precisa mesmo de WebSocket).
 *
 * Quem dispara o evento (ver emitirLiberado) é acessoTerminal.service.js, no
 * mesmo ponto único onde já grava "liberado" em acessos_catraca — assim
 * TODO caminho que já registra uma liberação (reconhecimento facial/QR do
 * próprio totem, CPF vinculado, admin "Liberar rápido"/"Liberar para este
 * aluno", pânico, biometria lida direto na catraca) automaticamente também
 * dispara este evento, sem precisar caçar cada rota manualmente.
 */

const clientes = new Set(); // Set<express.Response>

function registrarCliente(res) {
  clientes.add(res);
}

function removerCliente(res) {
  clientes.delete(res);
}

function quantidadeClientesConectados() {
  return clientes.size;
}

/** Notifica todo totem conectado agora que uma liberação acabou de acontecer. */
function emitirLiberado({ metodo } = {}) {
  if (clientes.size === 0) return;
  const payload = JSON.stringify({ metodo: metodo || null, em: Date.now() });
  for (const res of clientes) {
    try {
      res.write(`event: liberado\ndata: ${payload}\n\n`);
    } catch {
      // Conexão morta — será removida quando o 'close' do próprio response
      // disparar (ver rota /eventos/stream); nada a fazer aqui.
    }
  }
}

module.exports = { registrarCliente, removerCliente, emitirLiberado, quantidadeClientesConectados };
