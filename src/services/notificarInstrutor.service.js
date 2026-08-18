/**
 * Aviso ao(s) instrutor(es) via Telegram Bot, disparado quando um aluno
 * encosta o celular numa tag NFC colada num aparelho (ver
 * src/routes/chamar.routes.js). Usa a API HTTP do Telegram direto com
 * `fetch` nativo (Node 18+, ver package.json "engines") — sem dependência
 * nova, mesmo espírito de rateLimit.js (evitar pacotes externos quando dá).
 *
 * Configuração (.env local / Northflank em produção):
 *   TELEGRAM_BOT_TOKEN   token do bot, gerado pelo @BotFather no Telegram
 *   TELEGRAM_CHAT_ID     chat_id de quem recebe o aviso (pessoa ou grupo)
 * Ver NFC-CHAMAR-INSTRUTOR.md para o passo a passo de como conseguir os dois.
 *
 * Se as variáveis não estiverem configuradas, enviarChamado() lança um erro
 * claro (mesmo padrão de email.service.js) em vez de falhar silenciosamente.
 */

function limparVariavelAmbiente(valor) {
  return typeof valor === 'string' ? valor.trim() : valor;
}

function botToken() {
  return limparVariavelAmbiente(process.env.TELEGRAM_BOT_TOKEN);
}

function chatId() {
  return limparVariavelAmbiente(process.env.TELEGRAM_CHAT_ID);
}

function configurado() {
  return Boolean(botToken() && chatId());
}

// Cooldown por aparelho — evita martelar o Telegram/instrutor se alguém
// encostar o celular várias vezes seguidas na mesma tag (de propósito ou por
// acidente, ex: celular deixado encostado). Em memória, reinicia a cada
// deploy/restart — suficiente pro caso de uso (não precisa sobreviver a
// restart, é só um freio de curto prazo).
const ultimoChamadoPorEquipamento = new Map();
const COOLDOWN_MS = Number(process.env.CHAMAR_INSTRUTOR_COOLDOWN_MS) || 60 * 1000;

function emCooldown(equipamentoId) {
  const ultimo = ultimoChamadoPorEquipamento.get(equipamentoId);
  return Boolean(ultimo) && (Date.now() - ultimo) < COOLDOWN_MS;
}

/**
 * Manda o aviso pro Telegram. Devolve { enviado: false, motivo: 'cooldown' }
 * sem chamar a API (nem contar como erro) quando o mesmo aparelho já chamou
 * há pouco tempo — quem chama (chamar.routes.js) trata isso como sucesso do
 * ponto de vista do aluno ("o instrutor já está a caminho").
 */
async function enviarChamado({ equipamentoId, equipamentoNome }) {
  if (!configurado()) {
    throw new Error('Aviso ao instrutor não configurado: defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID nas variáveis de ambiente.');
  }
  if (emCooldown(equipamentoId)) {
    return { enviado: false, motivo: 'cooldown' };
  }
  ultimoChamadoPorEquipamento.set(equipamentoId, Date.now());

  const texto = `🔔 Instrutor chamado no *${equipamentoNome}*`;
  const url = `https://api.telegram.org/bot${botToken()}/sendMessage`;

  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId(), text: texto, parse_mode: 'Markdown' }),
  });

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    // Desfaz o cooldown: se o Telegram recusou, não faz sentido travar
    // tentativas seguintes por 60s à toa.
    ultimoChamadoPorEquipamento.delete(equipamentoId);
    throw new Error(`Telegram recusou o envio (HTTP ${resposta.status}): ${corpo}`);
  }

  return { enviado: true };
}

module.exports = { enviarChamado, configurado };
