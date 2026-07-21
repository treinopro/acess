const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const { errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth.routes');
const alunosRoutes = require('./routes/alunos.routes');
const planosRoutes = require('./routes/planos.routes');
const agendamentoRoutes = require('./routes/agendamento.routes');
const pagamentosRoutes = require('./routes/pagamentos.routes');
const usuariosRoutes = require('./routes/usuarios.routes');
const terminalRoutes = require('./routes/terminal.routes');
const portalRoutes = require('./routes/portal.routes');
const treinosRoutes = require('./routes/treinos.routes');
const recuperacaoRoutes = require('./routes/recuperacao.routes');
const { router: configRoutes } = require('./routes/config.routes');
const { rodar: rodarBackup } = require('./jobs/backup');
const { atualizarCobrancasVencidas } = require('./services/cobrancas.service');
const agenteGateway = require('./services/agenteGateway.service');
const dbResiliente = require('./services/dbResiliente.service');
const filaAcessosOffline = require('./services/filaAcessosOffline.service');
const filaCadastroOffline = require('./services/filaCadastroOffline.service');
const syncOfflineCache = require('./jobs/syncOfflineCache');

// Guarda do job de backup agendado: default 'true' preserva o comportamento
// atual (nenhuma mudança pra quem não define esta variável). Existe só para
// o processo "modo totem" (ver ecosystem.config.js, app
// "academia-gestao-totem") poder rodar com EXECUTAR_JOBS_AGENDADOS=false —
// evitando duplicar o backup automático junto com o processo principal que
// já roda na nuvem contra o mesmo Turso.
//
// A geração de mensalidades recorrentes NÃO usa mais este guard: desde
// 2026-07 ela deixou de rodar automaticamente em qualquer processo (nuvem ou
// totem) — decisão do dono do sistema, que prefere gerar manualmente pelo
// botão "Gerar Contas a Receber" no painel, escolhendo o período na hora, em
// vez de deixar rodando sozinha (ver src/routes/pagamentos.routes.js e
// src/services/cobrancas.service.js).
const EXECUTAR_JOBS_AGENDADOS = String(process.env.EXECUTAR_JOBS_AGENDADOS || 'true').toLowerCase() === 'true';

const app = express();
app.disable('x-powered-by'); // não anuncia "Express" na resposta (mesmo efeito de helmet.hidePoweredBy)

// CORS restrito: só entra em jogo se CORS_ORIGIN estiver configurado (lista
// separada por vírgula). O painel/portal/totem são servidos por este mesmo
// servidor (express.static abaixo) — ou seja, são requisições same-origin, que
// não passam por CORS de jeito nenhum. Isso só é necessário se, no futuro,
// algum front-end rodar num domínio diferente deste backend.
const origensPermitidas = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors(origensPermitidas.length ? { origin: origensPermitidas } : {}));

// Headers de segurança básicos (equivalentes ao pacote `helmet`, escrito à mão
// aqui por não haver acesso a instalação de pacotes npm neste ambiente).
// Deliberadamente SEM Content-Security-Policy: o painel/totem/portal usam
// bastante estilo inline (style="...") nas páginas .html, e uma CSP mal
// calibrada quebraria a renderização deles — vale revisitar isso numa
// passada dedicada, com testes visuais de cada tela, em vez de arriscar
// agora.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
});

app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' })); // limite de tamanho do corpo (mitiga payloads gigantes)

// Painel administrativo (frontend estático simples) - acessível em "/"
//
// 2026-07-21: setHeaders abaixo força o navegador a SEMPRE revalidar (nunca
// usar uma cópia em cache sem perguntar ao servidor) o HTML/JS/CSS que
// pertence ao próprio app (terminal, portal, painel, cadastro pelo celular)
// — sem isso, um tablet com o totem "Adicionado à tela inicial" pode
// continuar rodando uma versão antiga por dias mesmo depois de um deploy
// novo (foi exatamente o caso relatado: mudanças no `git push` não
// apareciam no totem). Revalidar não é a mesma coisa que "nunca cachear" —
// o navegador ainda manda a requisição condicional (If-None-Match/
// If-Modified-Since) e o servidor responde 304 sem reenviar nada quando o
// arquivo não mudou, então o custo extra é mínimo. Fica de fora da regra
// tudo dentro de vendor/ (face-api, jsQR, qrcode — bibliotecas de terceiros
// que só mudam quando alguém baixa uma versão nova de propósito), que
// continua com o cache padrão do navegador.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    const ehVendor = filePath.split(path.sep).includes('vendor');
    const extensaoDoApp = /\.(html|js|css)$/i.test(filePath);
    if (!ehVendor && extensaoDoApp) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.get('/health', (req, res) => res.json({ status: 'ok', servico: 'academia-gestao' }));

app.use('/api/auth', authRoutes);
app.use('/api/alunos', alunosRoutes);
app.use('/api/planos', planosRoutes);
app.use('/api/agendamentos', agendamentoRoutes);
app.use('/api/pagamentos', pagamentosRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/terminal', terminalRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/treinos', treinosRoutes);
app.use('/api/config', configRoutes);
app.use('/api/recuperacao', recuperacaoRoutes);

app.use(errorHandler);

// Servidor HTTP criado explicitamente (em vez de app.listen) para poder
// aceitar, na mesma porta, conexões WebSocket do "agente local" da catraca
// (ver src/services/agenteGateway.service.js e src/services/
// catracaGateway.service.js). Sem isso não haveria como o agente se conectar
// quando o painel está hospedado na nuvem.
const server = http.createServer(app);
agenteGateway.attach(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Agente local da catraca deve conectar em ws://localhost:${PORT}/agente/socket?token=<AGENTE_TOKEN> (ou wss:// em produção).`);

  // Geração de mensalidades recorrentes: NÃO roda mais automaticamente aqui
  // (2026-07 — decisão do dono do sistema). O único jeito de gerar essas
  // cobranças agora é o botão "Gerar Contas a Receber" no painel (escolhendo
  // o período — mês corrente ou meses futuros — ver
  // src/routes/pagamentos.routes.js), ou rodando `npm run gerar-cobrancas`
  // manualmente no terminal.

  // Backup automático — SÓ neste processo quando EXECUTAR_JOBS_AGENDADOS não
  // estiver explicitamente desligado (default: ligado, comportamento
  // idêntico ao de sempre). O processo "modo totem" (ecosystem.config.js)
  // define essa variável como 'false' porque ele aponta pro MESMO Turso do
  // processo principal da nuvem — rodar o backup duas vezes seria só
  // redundante (o backup em si não tem o risco financeiro da recorrência,
  // mas não há motivo pra duplicar o trabalho).
  if (EXECUTAR_JOBS_AGENDADOS) {
    // Roda uma vez ao subir e depois a cada 24h, salvando um dump JSON em
    // disco local (./backups). ATENÇÃO: em hospedagens com disco efêmero
    // (reinicia zerado a cada deploy, como costuma ser o caso em
    // Northflank/Buildpack) esses arquivos locais NÃO sobrevivem a um
    // redeploy — use também o botão "Baixar backup agora" no painel
    // (Configurações), que baixa o arquivo direto pro computador do admin.
    rodarBackup().catch((err) => console.error('[backup] erro na execução inicial:', err));
    setInterval(() => {
      rodarBackup().catch((err) => console.error('[backup] erro na execução agendada:', err));
    }, 24 * 60 * 60 * 1000);
  } else {
    console.log('[server] EXECUTAR_JOBS_AGENDADOS=false — pulando backup agendado neste processo (esperado no processo "modo totem").');
  }

  // Atualização de cobranças vencidas (2026-07): cobranças ficavam 'pendente'
  // pra sempre no banco mesmo depois de vencidas — o status só era
  // recalculado quando alguém lançava/removia um pagamento ou editava a
  // conta manualmente (ver recalcularStatusCobranca em
  // src/routes/pagamentos.routes.js). Este job roda uma vez ao subir e
  // depois a cada 1h, marcando como 'atrasado' toda cobrança 'pendente' cujo
  // vencimento já passou — mesmo UPDATE que a rota GET /api/pagamentos/
  // inadimplentes já calculava dinamicamente, só que agora gravado de
  // verdade na coluna status (ver src/services/cobrancas.service.js).
  // Reaproveita o guard EXECUTAR_JOBS_AGENDADOS do backup pra não rodar em
  // dobro no processo "modo totem", que aponta pro mesmo Turso do processo
  // principal.
  if (EXECUTAR_JOBS_AGENDADOS) {
    atualizarCobrancasVencidas().catch((err) => console.error('[cobrancas] erro ao atualizar vencidas na execução inicial:', err));
    setInterval(() => {
      atualizarCobrancasVencidas().catch((err) => console.error('[cobrancas] erro ao atualizar vencidas na execução agendada:', err));
    }, 60 * 60 * 1000); // de hora em hora
  }

  // "Modo totem offline-resiliente" (2026-07): só ativa quando
  // MODO_TOTEM_OFFLINE=true (processo dedicado do totem, ver
  // ecosystem.config.js). Fora disso, dbResiliente.comFallback() já não faz
  // nada de diferente sozinho, mas sem estes timers o cache local (local.db)
  // nunca seria alimentado, nem a fila de acessos ou a fila de cadastro
  // pendentes seriam reenviadas — então este bloco todo é o que efetivamente
  // liga o modo offline-resiliente de ponta a ponta.
  if (dbResiliente.MODO_TOTEM_OFFLINE) {
    const SYNC_OFFLINE_INTERVALO_MS = Number(process.env.SYNC_OFFLINE_INTERVALO_MS) || 12 * 60 * 1000;
    const FILA_ACESSOS_TOTEM_FLUSH_INTERVALO_MS = Number(process.env.FILA_ACESSOS_TOTEM_FLUSH_INTERVALO_MS) || 30 * 1000;
    const FILA_CADASTRO_TOTEM_FLUSH_INTERVALO_MS = Number(process.env.FILA_CADASTRO_TOTEM_FLUSH_INTERVALO_MS) || 30 * 1000;

    console.log(`[server] MODO_TOTEM_OFFLINE=true — sincronizando cache local a cada ${Math.round(SYNC_OFFLINE_INTERVALO_MS / 1000)}s, esvaziando a fila de acessos a cada ${Math.round(FILA_ACESSOS_TOTEM_FLUSH_INTERVALO_MS / 1000)}s e a fila de cadastro/pagamentos a cada ${Math.round(FILA_CADASTRO_TOTEM_FLUSH_INTERVALO_MS / 1000)}s.`);

    syncOfflineCache.sincronizar().catch((err) => console.error('[syncOfflineCache] erro na sincronização inicial:', err));
    setInterval(() => {
      syncOfflineCache.sincronizar().catch((err) => console.error('[syncOfflineCache] erro na sincronização agendada:', err));
    }, SYNC_OFFLINE_INTERVALO_MS);

    filaAcessosOffline.flush().catch((err) => console.error('[filaAcessosOffline] erro no flush inicial:', err));
    setInterval(() => {
      filaAcessosOffline.flush().catch((err) => console.error('[filaAcessosOffline] erro no flush agendado:', err));
    }, FILA_ACESSOS_TOTEM_FLUSH_INTERVALO_MS);

    filaCadastroOffline.flush().catch((err) => console.error('[filaCadastroOffline] erro no flush inicial:', err));
    setInterval(() => {
      filaCadastroOffline.flush().catch((err) => console.error('[filaCadastroOffline] erro no flush agendado:', err));
    }, FILA_CADASTRO_TOTEM_FLUSH_INTERVALO_MS);
  }
});

// HTTPS opcional, só pro totem (2026-07): câmera (getUserMedia) só funciona em
// contexto seguro — "https://" ou "localhost". O totem acessa por IP da rede
// local (ex.: http://192.168.0.2:3000/terminal.html), que os navegadores NÃO
// consideram seguro, então a captura facial falha com "navigator.mediaDevices
// is undefined". Isso é restrição do navegador (mais rígida ainda no iOS
// Safari, que não tem nenhuma flag de exceção como o Chrome/Android tem) — não
// dá pra contornar sem servir HTTPS de verdade.
//
// Fica desligado por padrão (zero impacto no servidor da nuvem e em quem não
// configurou nada): só liga se os dois arquivos abaixo existirem. Gere-os uma
// vez com mkcert (ver instruções passadas no chat) e coloque em
// academia-gestao/certs/totem-cert.pem e academia-gestao/certs/totem-key.pem.
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH || path.join(__dirname, '..', 'certs', 'totem-cert.pem');
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH || path.join(__dirname, '..', 'certs', 'totem-key.pem');
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

if (fs.existsSync(HTTPS_CERT_PATH) && fs.existsSync(HTTPS_KEY_PATH)) {
  try {
    const httpsOptions = {
      cert: fs.readFileSync(HTTPS_CERT_PATH),
      key: fs.readFileSync(HTTPS_KEY_PATH),
    };
    https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
      console.log(`[server] HTTPS ativo em https://localhost:${HTTPS_PORT} — use este endereço (com o IP da rede no lugar de "localhost") no totem para a câmera funcionar.`);
    });
  } catch (err) {
    console.error('[server] Encontrei certs/totem-cert.pem e certs/totem-key.pem mas não consegui iniciar o HTTPS:', err.message);
  }
} else {
  console.log('[server] HTTPS do totem não configurado (certs/totem-cert.pem / totem-key.pem não encontrados) — pulando. Sem impacto se você não usa câmera pelo IP da rede.');
}
