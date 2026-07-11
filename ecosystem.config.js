// Autostart do academia-gestao (copia local) via PM2.
//
// Por que este arquivo existe: o .env deste projeto aponta de proposito pra
// producao (Turso), "para que rodar localmente e acessar pela nuvem sempre
// reflitam os mesmos dados" (ver rodar-local.ps1). Isso significa que um
// simples "pm2 start npm -- start" iria conectar essa copia local na
// producao — o mesmo risco que causou cobranca fantasma durante a migracao.
//
// Este arquivo replica o truque do rodar-local.ps1: define DATABASE_URL e
// DATABASE_AUTH_TOKEN ANTES do processo subir, forcando o uso do local.db.
// O dotenv do projeto nunca sobrescreve uma variavel de ambiente que ja foi
// definida antes de rodar — entao com essas variaveis ja setadas aqui pelo
// PM2, o servidor ignora as linhas de Turso do .env e usa o local.db.

// -----------------------------------------------------------------------------
// "academia-gestao-totem" (2026-07): processo dedicado que roda no PC da
// recepção/totem, com o servidor Node LOCAL fazendo o papel de gateway pro
// Turso — ao contrário do "academia-gestao-local" acima, este app NÃO
// sobrescreve DATABASE_URL/DATABASE_AUTH_TOKEN: usa o Turso do .env como
// única fonte de verdade de cadastro/decisão de acesso, exatamente como o
// servidor da nuvem.
//
// As duas variáveis abaixo é que ligam o "modo totem offline-resiliente":
//   - EXECUTAR_JOBS_AGENDADOS=false: este processo NUNCA roda a recorrência
//     de mensalidades nem o backup automático — quem já faz isso é o
//     servidor da nuvem, contra o MESMO banco Turso. Rodar os dois é o que
//     causou o incidente de "cobrança fantasma" anteriormente; este guard
//     existe especificamente para nunca mais deixar isso acontecer aqui.
//   - MODO_TOTEM_OFFLINE=true: ativa o fallback pro local.db (cache, somente
//     leitura de decisão de acesso) quando o Turso não responder, a fila de
//     acessos pendentes, e a sincronização periódica do cache — ver
//     src/services/dbResiliente.service.js, filaAcessosOffline.service.js e
//     src/jobs/syncOfflineCache.js.
//
// Uso: `pm2 start ecosystem.config.js --only academia-gestao-totem` no PC do
// totem/recepção. NÃO rode este app junto com "academia-gestao-local" no
// mesmo PC (portas em conflito) — são dois modos alternativos, escolha um.
module.exports = {
  apps: [
    {
      name: 'academia-gestao-local',
      script: 'src/server.js',
      cwd: __dirname,
      env: {
        DATABASE_URL: 'file:./local.db',
        DATABASE_AUTH_TOKEN: '',
      },
    },
    {
      name: 'academia-gestao-totem',
      script: 'src/server.js',
      cwd: __dirname,
      env: {
        EXECUTAR_JOBS_AGENDADOS: 'false',
        MODO_TOTEM_OFFLINE: 'true',
      },
    },
  ],
};
