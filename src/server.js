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
const { router: produtosServicosRoutes } = require('./routes/produtosServicos.routes');
const pendenciasRoutes = require('./routes/pendencias.routes');
const agendamentoRoutes = require('./routes/agendamento.routes');
const pagamentosRoutes = require('./routes/pagamentos.routes');
const usuariosRoutes = require('./routes/usuarios.routes');
const terminalRoutes = require('./routes/terminal.routes');
const portalRoutes = require('./routes/portal.routes');
const treinosRoutes = require('./routes/treinos.routes');
const bibliotecaExerciciosRoutes = require('./routes/bibliotecaExercicios.routes');
const treinoTemplatesRoutes = require('./routes/treinoTemplates.routes');
const recuperacaoRoutes = require('./routes/recuperacao.routes');
const contasPagarRoutes = require('./routes/contasPagar.routes');
const chamarInstrutorRoutes = require('./routes/chamar.routes');
const { router: configRoutes } = require('./routes/config.routes');
const { rodarNaSubidaSeNaoRecente: rodarBackupNaSubida, verificarAgendamento: verificarAgendamentoBackup } = require('./jobs/backup');
const { rodar: rodarMensagensAgendadas } = require('./jobs/mensagensAgendadas');
const { rodar: rodarAvisoVencimento } = require('./jobs/avisoVencimento');
const { rodar: rodarAvisoRenovacaoAvaliacao } = require('./jobs/avisoRenovacaoAvaliacao');
const { rodar: rodarReconciliarPagamentosPix } = require('./jobs/reconciliarPagamentosPix');
const { atualizarCobrancasVencidas } = require('./services/cobrancas.service');
const agenteGateway = require('./services/agenteGateway.service');
const dbResiliente = require('./services/dbResiliente.service');
const filaAcessosOffline = require('./services/filaAcessosOffline.service');
const filaCadastroOffline = require('./services/filaCadastroOffline.service');
const syncOfflineCache = require('./jobs/syncOfflineCache');
const { autenticar } = require('./middleware/auth');
const { verificarToken } = require('./utils/jwt');
const dbCru = require('./db/client');

// AvaliaPro completo (interface com fotos, postural, funcional, MediaPipe)
// só existe HOJE como pasta neste notebook, fora deste repositório — não
// dá pra levar pro deploy na nuvem sem antes decidir onde os ~40 MB de
// modelos de IA vão morar (ver INTEGRACAO-ACADEMIA-GESTAO.md do
// AvaliaPro). Por isso o require é OPCIONAL: local (onde a pasta
// `avaliapro` existe ao lado de `projeto acess aca/`) monta a rota
// `/avaliacoes/` normalmente; na nuvem (onde ela não existe) o require
// falha, é pego aqui, e o servidor sobe do mesmo jeito sem essa rota —
// nunca um require ausente derruba o boot inteiro. O que NÃO depende
// disso (portal do aluno, tela de avaliação do staff) usa
// `vendor/avaliapro-core/` e funciona nos dois lugares.
let criarModuloAvaliaPro = null;
let envolverClienteLibsql = null;
try {
  ({ criarModulo: criarModuloAvaliaPro } = require('../../../avaliapro/src/module'));
  ({ envolverClienteLibsql } = require('../../../avaliapro/src/adapters/db-bridge'));
} catch (e) {
  console.log('[server] AvaliaPro completo não encontrado ao lado do projeto — rota /avaliacoes/ (interface com ' +
    'fotos/postural/funcional) não será montada neste processo. Portal do aluno e tela de avaliação do staff ' +
    'continuam funcionando normalmente (usam vendor/avaliapro-core/, não a pasta completa).');
}

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

// AvaliaPro — avaliação física, montado como módulo (ver
// ../../../avaliapro/INTEGRACAO-ACADEMIA-GESTAO.md). Fica ANTES do
// express.json({limit:'1mb'}) logo abaixo de propósito: o AvaliaPro tem
// parser de corpo próprio com limite bem maior (até 600 MB, pra caber um
// vídeo de teste funcional em base64). Montado aqui, as requisições para
// /avaliacoes/* são lidas pelo parser dele e nunca chegam no limite de
// 1 MB do resto do sistema — inverter a ordem cortaria/rejeitaria os
// uploads de vídeo antes de chegarem lá.
//
// Só a API exige login (/avaliacoes/api/*) — os arquivos estáticos do
// AvaliaPro (HTML/JS/CSS) carregam sem token, do mesmo jeito que o
// painel deste sistema também carrega sem token e só autentica nas
// chamadas de API.
//
// Só monta se a pasta completa do AvaliaPro foi encontrada (ver o
// try/catch dos requires lá em cima) — sem ela não tem HTML/JS pra
// servir nem captura de foto/vídeo pra rodar.
if (criarModuloAvaliaPro) {
  const avaliapro = criarModuloAvaliaPro({
    db: envolverClienteLibsql(dbCru),
    academia: envolverClienteLibsql(dbCru),
    modo: 'academia',
    autor: (req) => req.usuario?.id || 'academia',
  });
  // GET /avaliacoes/api/midias/:id é carregado por <img src> e <video src>
  // (fotos posturais, vídeos dos testes funcionais) — o navegador NUNCA manda
  // o header Authorization nesses casos, só em chamadas via fetch. Por isso
  // só essa rota aceita o token também por query string (?t=), gerado pelo
  // próprio front-end do AvaliaPro a partir do mesmo token que já está no
  // localStorage (ver public/app/api.js). Todo o resto da API continua
  // exigindo o header normal, sem exceção.
  app.use('/avaliacoes/api', (req, res, next) => {
    if (req.method === 'GET' && req.path.startsWith('/midias/') && req.query.t) {
      try {
        req.usuario = verificarToken(req.query.t);
        return next();
      } catch (e) {
        return res.status(401).json({ erro: 'Token inválido ou expirado.' });
      }
    }
    return autenticar(req, res, next);
  });
  app.use('/avaliacoes', avaliapro.router);
} else {
  // Sem a pasta completa do AvaliaPro (caso da nuvem hoje), /avaliacoes
  // cairia no 404 padrão do Express ("Cannot GET /avaliacoes/") — uma
  // tela sem contexto nenhum pra quem clicou no link "Avaliação física"
  // do menu sem saber que essa parte só existe no computador da
  // recepção. Esta rota troca isso por uma explicação e por onde ir.
  app.get(['/avaliacoes', '/avaliacoes/*'], (req, res) => {
    res.status(404).send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avaliação física completa</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f172a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;padding:20px}
  .caixa{background:#1e293b;border-radius:16px;padding:28px;max-width:420px;text-align:center}
  h1{font-size:18px;margin:0 0 12px}
  p{color:#cbd5e1;font-size:14px;line-height:1.6;margin:0 0 16px}
  a{color:#10b981;font-weight:600;text-decoration:none}
  a:hover{text-decoration:underline}
</style></head><body>
  <div class="caixa">
    <h1>📏 Avaliação física completa</h1>
    <p>Fotos posturais, análise funcional por vídeo e leitura de anotações
    por foto ficam disponíveis apenas no computador da recepção
    (é lá que essa parte roda hoje).</p>
    <p>Peso, % de gordura, IMC e as demais medidas já funcionam
    normalmente aqui — no <a href="/">perfil de cada aluno</a> e no
    <a href="/portal.html">portal do aluno</a>.</p>
  </div>
</body></html>`);
  });
}

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
    if (path.basename(filePath).toLowerCase() === 'sw.js') {
      // The file that discovers updates must never be reused without a
      // server check, especially in an iOS standalone app.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else if (!ehVendor && extensaoDoApp) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.get('/health', (req, res) => res.json({ status: 'ok', servico: 'academia-gestao' }));

// "Chamar instrutor" via tag NFC (2026-08) — fica fora do prefixo /api de
// propósito, ver comentário completo em src/routes/chamar.routes.js.
app.use(chamarInstrutorRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/alunos', alunosRoutes);
app.use('/api/planos', planosRoutes);
app.use('/api/produtos-servicos', produtosServicosRoutes);
app.use('/api/pendencias', pendenciasRoutes);
app.use('/api/agendamentos', agendamentoRoutes);
app.use('/api/pagamentos', pagamentosRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/terminal', terminalRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/treinos', treinosRoutes);
app.use('/api/biblioteca-exercicios', bibliotecaExerciciosRoutes);
app.use('/api/treino-templates', treinoTemplatesRoutes);
app.use('/api/config', configRoutes);
app.use('/api/recuperacao', recuperacaoRoutes);
app.use('/api/contas-pagar', contasPagarRoutes);

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
    // Roda uma vez ao subir (rede de segurança — sempre gera um dump fresco a
    // cada deploy, respeitando o destino configurado: local/e-mail/ambos, ver
    // Configurações > Backup) e depois fica checando a cada 5 min se está na
    // janela do agendamento configurado pelo admin (frequência diária/semanal
    // + horário) — ver verificarAgendamento em src/jobs/backup.js, que evita
    // rodar duas vezes no mesmo dia mesmo com o processo reiniciando no meio
    // do caminho (marca a última execução no banco, não em memória).
    // 2026-09-02: rodarNaSubidaSeNaoRecente (em vez de chamar rodar() direto)
    // — reinícios em rajada (múltiplos deploys seguidos, health-check
    // instável, etc.) mandavam um e-mail de backup por reinício, sem limite
    // nenhum. Ver comentário grande em backup.js.
    rodarBackupNaSubida().catch((err) => console.error('[backup] erro na execução inicial:', err));
    setInterval(() => {
      verificarAgendamentoBackup().catch((err) => console.error('[backup] erro na checagem de agendamento:', err));
    }, 5 * 60 * 1000);
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

  // Disparo automático de mensagens agendadas (só e-mail — ver
  // src/jobs/mensagensAgendadas.js). Checa a cada 1 minuto: intervalo curto
  // o bastante pra "enviar às 14:00" sair perto de 14:00 de verdade, sem
  // martelar o banco. Mesmo guard dos outros jobs (evita disparar em dobro
  // no processo "modo totem", que aponta pro mesmo Turso).
  if (EXECUTAR_JOBS_AGENDADOS) {
    rodarMensagensAgendadas().catch((err) => console.error('[mensagensAgendadas] erro na execução inicial:', err));
    setInterval(() => {
      rodarMensagensAgendadas().catch((err) => console.error('[mensagensAgendadas] erro na execução agendada:', err));
    }, 60 * 1000);
  }

  // Aviso de vencimento por push (2026-08-13, ver src/jobs/avisoVencimento.js)
  // — checagem de hora em hora é suficiente (o aviso não precisa ser
  // instantâneo no minuto exato em que a cobrança entra na janela). Mesmo
  // guard dos outros jobs.
  if (EXECUTAR_JOBS_AGENDADOS) {
    rodarAvisoVencimento().catch((err) => console.error('[avisoVencimento] erro na execução inicial:', err));
    setInterval(() => {
      rodarAvisoVencimento().catch((err) => console.error('[avisoVencimento] erro na execução agendada:', err));
    }, 60 * 60 * 1000);
  }

  // Aviso de renovação de avaliação física por push (2026-08-19, ver
  // src/jobs/avisoRenovacaoAvaliacao.js) — mesmo guard e cadência do aviso
  // de vencimento de mensalidade.
  if (EXECUTAR_JOBS_AGENDADOS) {
    rodarAvisoRenovacaoAvaliacao().catch((err) => console.error('[avisoRenovacaoAvaliacao] erro na execução inicial:', err));
    setInterval(() => {
      rodarAvisoRenovacaoAvaliacao().catch((err) => console.error('[avisoRenovacaoAvaliacao] erro na execução agendada:', err));
    }, 60 * 60 * 1000);
  }

  // Reconciliação de pagamentos Pix "esquecidos" (2026-08-20, ver
  // src/jobs/reconciliarPagamentosPix.js) — o polling ao vivo do totem/portal
  // só confirma um Pix enquanto a pessoa está com a tela do QR code aberta;
  // se ela sair antes da confirmação chegar, a cobrança fica "pendente" pra
  // sempre sem este job. Checagem a cada 10 min é suficiente (não é um aviso
  // que precisa ser instantâneo, e evita martelar a API do Mercado Pago).
  // Mesmo guard dos outros jobs.
  if (EXECUTAR_JOBS_AGENDADOS) {
    rodarReconciliarPagamentosPix().catch((err) => console.error('[reconciliarPagamentosPix] erro na execução inicial:', err));
    setInterval(() => {
      rodarReconciliarPagamentosPix().catch((err) => console.error('[reconciliarPagamentosPix] erro na execução agendada:', err));
    }, 10 * 60 * 1000);
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
