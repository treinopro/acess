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

// 2026-09-08: canal SEPARADO para o painel "Acessos ao vivo" do admin (ver
// /api/terminal/admin/eventos/stream em terminal.routes.js) — não reaproveita
// o Set `clientes` acima de propósito: aquele é autenticado pelo TERMINAL_TOKEN
// do totem físico e só carrega o suficiente pra tela/som de liberação; este
// aqui é autenticado por sessão de admin e dispara pra LIBERADO e NEGADO (o
// admin quer ver tentativas, não só sucessos), com o nome+motivo completo.
// Puramente em memória — nunca é lido do banco, só espelha o que acabou de
// ser gravado no mesmo instante (ver os dois pontos de chamada em
// acessoTerminal.service.js, logo ao lado de emitirLiberado).
const clientesAdmin = new Set(); // Set<express.Response>

function registrarClienteAdmin(res) {
  clientesAdmin.add(res);
}

function removerClienteAdmin(res) {
  clientesAdmin.delete(res);
}

function emitirAcessoAdmin({
  resultado, metodo, alunoNome, alunoId, mensagem,
} = {}) {
  if (clientesAdmin.size === 0) return;
  const payload = JSON.stringify({
    resultado: resultado || null,
    metodo: metodo || null,
    alunoNome: alunoNome || null,
    alunoId: alunoId || null,
    mensagem: mensagem || null,
    em: Date.now(),
  });
  for (const res of clientesAdmin) {
    try {
      res.write(`event: acesso\ndata: ${payload}\n\n`);
    } catch {
      // Conexão morta — removida quando o 'close' do response disparar.
    }
  }
}

/**
 * Notifica todo totem conectado agora que uma liberação acabou de acontecer.
 * `alunoNome`/`motivo` (2026-08-24): usados só pela liberação manual pela
 * recepção sobre um acesso antes negado (ver /catraca/liberar-aluno em
 * terminal.routes.js e o botão "Negado ↻" em Acompanhamento de acessos,
 * public/app.js) — deixam o totem mostrar por escrito quem foi liberado e o
 * motivo original da negação (ex.: mensalidade em atraso). NUNCA são lidos em
 * voz alta (ver terminal.js) — só aparecem escritos na tela.
 */
function emitirLiberado({ metodo, alunoNome, motivo } = {}) {
  if (clientes.size === 0) return;
  const payload = JSON.stringify({
    metodo: metodo || null, alunoNome: alunoNome || null, motivo: motivo || null, em: Date.now(),
  });
  for (const res of clientes) {
    try {
      res.write(`event: liberado\ndata: ${payload}\n\n`);
    } catch {
      // Conexão morta — será removida quando o 'close' do próprio response
      // disparar (ver rota /eventos/stream); nada a fazer aqui.
    }
  }
}

module.exports = {
  registrarCliente,
  removerCliente,
  emitirLiberado,
  quantidadeClientesConectados,
  registrarClienteAdmin,
  removerClienteAdmin,
  emitirAcessoAdmin,
};
