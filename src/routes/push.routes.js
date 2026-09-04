// Notificações push pro STAFF (admin/professor/recepção) do painel —
// 2026-09-02, ver "Chamar professor" no portal do aluno
// (POST /api/portal/chamar-professor). Mesma infraestrutura de Web Push já
// validada e em produção pros avisos de vencimento do aluno (mesmas chaves
// VAPID, mesmo service worker /sw.js) — só troca a tabela de destino
// (push_subscriptions_staff em vez de push_subscriptions) e quem autentica
// (JWT do painel via `autenticar`, não CPF/senha do portal).
//
// A chave pública VAPID já é exposta sem autenticação em
// GET /api/portal/push/vapid-public-key (é uma chave pública por design,
// igual pro app inteiro) — o front do painel reaproveita essa mesma rota,
// não precisa de uma cópia aqui.
const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

// POST /api/push/staff/subscribe — mesmo padrão do portal: UPSERT por
// endpoint (chamado toda vez que o front garante a inscrição, não só na
// primeira vez).
router.post('/staff/subscribe', async (req, res, next) => {
  try {
    const subscription = subscriptionSchema.parse(req.body);
    await db.execute({
      sql: `INSERT INTO push_subscriptions_staff (id, usuario_id, endpoint, p256dh, auth, user_agent)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      args: [
        uuid(), req.usuario.id, subscription.endpoint, subscription.keys.p256dh,
        subscription.keys.auth, req.headers['user-agent'] || null,
      ],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/push/staff/unsubscribe { endpoint }
router.post('/staff/unsubscribe', async (req, res, next) => {
  try {
    const { endpoint } = z.object({ endpoint: z.string().min(1) }).parse(req.body);
    await db.execute({ sql: 'DELETE FROM push_subscriptions_staff WHERE usuario_id = ? AND endpoint = ?', args: [req.usuario.id, endpoint] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
