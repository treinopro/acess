/**
 * Envio de Web Push (notificações que chegam mesmo com o portal fechado) —
 * mesmo padrão já validado em produção no TreinoPro e no Entregaí (ver skill
 * web-push-setup): VAPID + service worker com handler de `push` +
 * PushSubscription por dispositivo, guardada em push_subscriptions.
 *
 * Configuração (variáveis de ambiente):
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  gerados uma vez por ambiente com
 *                                          `web-push generate-vapid-keys`
 *                                          (NUNCA reusar entre dev/produção).
 *   VAPID_SUBJECT                         mailto:... ou uma URL https://... —
 *                                          NUNCA a chave em si. A Apple
 *                                          valida isso mais rigorosamente que
 *                                          Chrome/Firefox (rejeita domínio
 *                                          reservado tipo .local/.test com
 *                                          403 BadJwtToken só na hora de
 *                                          enviar pro Safari/iOS).
 *
 * Se as variáveis não estiverem configuradas, todo envio vira um no-op
 * silencioso (com aviso único no log) em vez de erro fatal — mesmo espírito
 * de email.service.js: a inscrição continua sendo salva no banco
 * normalmente, só não sai nada de verdade até alguém configurar as chaves.
 */

let webpush;
try {
  // eslint-disable-next-line global-require
  webpush = require('web-push');
} catch {
  webpush = null;
}

const db = require('../db/client');

let vapidConfigurado = null; // null = ainda não checou, true/false = resultado cacheado
let avisoFaltandoJaMostrado = false;

function garantirVapidConfigurado() {
  if (vapidConfigurado !== null) return vapidConfigurado;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!webpush || !publicKey || !privateKey || !subject) {
    vapidConfigurado = false;
    if (!avisoFaltandoJaMostrado) {
      avisoFaltandoJaMostrado = true;
      console.warn('[webPush] VAPID não configurado (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT) — notificações push ficam desativadas, mas o resto do portal funciona normal.');
    }
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigurado = true;
  return true;
}

function pushHabilitado() {
  return garantirVapidConfigurado();
}

function chavePublicaVapid() {
  return garantirVapidConfigurado() ? process.env.VAPID_PUBLIC_KEY : null;
}

/**
 * Envia uma notificação pra TODAS as subscriptions salvas de um aluno
 * (pode ter mais de um dispositivo). Nunca lança — quem chama não precisa
 * tratar erro de envio, só decide o que fazer com o resultado (ex.: logar
 * quantos dispositivos receberam).
 *
 * @returns {Promise<{enviados: number, removidos: number}>}
 */
async function enviarParaAluno(alunoId, { titulo, corpo, url, tag }) {
  if (!garantirVapidConfigurado()) return { enviados: 0, removidos: 0 };

  const result = await db.execute({
    sql: 'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE aluno_id = ?',
    args: [alunoId],
  });

  let enviados = 0;
  let removidos = 0;
  const payload = JSON.stringify({ title: titulo, body: corpo, url: url || '/portal.html', tag: tag || undefined });

  for (const sub of result.rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      enviados += 1;
    } catch (err) {
      // 400/401/403/404/410 = subscription morta/inválida (endpoint expirou,
      // chave VAPID rotacionou, usuário revogou a permissão etc.) — limpa do
      // banco em vez de tentar de novo pra sempre. Qualquer outro código
      // (ex.: falha de rede momentânea) só loga, mantém a subscription.
      const codigo = err.statusCode;
      console.error(`[webPush] falha ao enviar pro aluno ${alunoId} (endpoint ${sub.endpoint.slice(0, 60)}...):`, codigo, err.body || err.message);
      if ([400, 401, 403, 404, 410].includes(codigo)) {
        // eslint-disable-next-line no-await-in-loop
        await db.execute({ sql: 'DELETE FROM push_subscriptions WHERE id = ?', args: [sub.id] });
        removidos += 1;
      }
    }
  }

  return { enviados, removidos };
}

/**
 * Envia uma notificação pra TODAS as subscriptions salvas de STAFF (qualquer
 * usuário do painel que tiver ativado neste aparelho — ver
 * push_subscriptions_staff em schema.sql). Usado pelo botão "Chamar
 * professor" do portal (2026-09-02) — fan-out simples, sem roteamento por
 * professor específico (academia pequena, todo mundo que ativar recebe).
 * Mesmo padrão de enviarParaAluno acima: nunca lança, limpa subscription
 * morta automaticamente.
 *
 * @returns {Promise<{enviados: number, removidos: number}>}
 */
async function enviarParaTodoStaff({ titulo, corpo, url, tag }) {
  if (!garantirVapidConfigurado()) return { enviados: 0, removidos: 0 };

  const result = await db.execute('SELECT id, endpoint, p256dh, auth FROM push_subscriptions_staff');

  let enviados = 0;
  let removidos = 0;
  const payload = JSON.stringify({ title: titulo, body: corpo, url: url || '/index.html', tag: tag || undefined });

  for (const sub of result.rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      enviados += 1;
    } catch (err) {
      const codigo = err.statusCode;
      console.error(`[webPush] falha ao enviar pro staff (endpoint ${sub.endpoint.slice(0, 60)}...):`, codigo, err.body || err.message);
      if ([400, 401, 403, 404, 410].includes(codigo)) {
        // eslint-disable-next-line no-await-in-loop
        await db.execute({ sql: 'DELETE FROM push_subscriptions_staff WHERE id = ?', args: [sub.id] });
        removidos += 1;
      }
    }
  }

  return { enviados, removidos };
}

module.exports = {
  pushHabilitado, chavePublicaVapid, enviarParaAluno, enviarParaTodoStaff,
};
