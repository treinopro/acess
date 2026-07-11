const { createClient } = require('@libsql/client');
const path = require('path');

// Cliente do banco OFFLINE (cache/fallback local do totem) — SEMPRE aponta
// pro local.db deste projeto, independente do que DATABASE_URL diga no
// .env (esse é o cliente "online", ver src/db/client.js).
//
// Contexto (2026-07): antes, o totem rodava contra uma cópia local inteira
// (via rodar-local.ps1 / PM2 "academia-gestao-local"), pensada só como trava
// de segurança pra TESTES — nunca deveria ter virado o banco de produção do
// totem. Isso fazia os acessos por facial/QR/CPF divergirem do Turso (que já
// recebia certinho os acessos por biometria da catraca, via agente-local).
//
// A partir de agora, o Turso é a ÚNICA fonte de verdade pra decisões de
// acesso e pra cadastro — este banco local só serve de:
//   1) CACHE de leitura, alimentado por um pull periódico do Turso (ver
//      src/jobs/syncOfflineCache.js) — usado como fallback só quando o
//      Turso não responde a tempo (ver dbResiliente.service.js).
//   2) Destino temporário da fila de acessos pendentes quando uma gravação
//      no Turso falha (ver filaAcessosOffline.service.js — que hoje usa um
//      arquivo .jsonl à parte, não uma tabela deste banco).
// Nunca é o destino de escritas de CADASTRO (aluno/plano/pagamento/rosto) —
// essas sempre exigem o Turso disponível, sem fallback (decisão do dono do
// sistema, 2026-07: cadastrar contra um cache desatualizado não faz
// sentido).
const LOCAL_DB_PATH = process.env.LOCAL_DB_PATH || path.join(__dirname, '..', '..', 'local.db');

const dbOffline = createClient({
  url: `file:${LOCAL_DB_PATH}`,
});

module.exports = dbOffline;
