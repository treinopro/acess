const path = require('path');
const http = require('http');
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
const { router: configRoutes } = require('./routes/config.routes');
const { rodar: rodarRecorrencia } = require('./jobs/recorrencia');
const { rodar: rodarBackup } = require('./jobs/backup');
const agenteGateway = require('./services/agenteGateway.service');

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Painel administrativo (frontend estático simples) - acessível em "/"
app.use(express.static(path.join(__dirname, '..', 'public')));

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

  // Gera as próximas mensalidades de planos recorrentes: roda uma vez ao subir
  // o servidor e depois a cada 24h enquanto o processo ficar no ar. Em produção,
  // como alternativa mais confiável, um Render Cron Job pode chamar
  // `npm run gerar-cobrancas` periodicamente (ver README).
  rodarRecorrencia().catch((err) => console.error('[recorrencia] erro na execução inicial:', err));
  setInterval(() => {
    rodarRecorrencia().catch((err) => console.error('[recorrencia] erro na execução agendada:', err));
  }, 24 * 60 * 60 * 1000);

  // Backup automático: roda uma vez ao subir e depois a cada 24h, salvando um
  // dump JSON em disco local (./backups). ATENÇÃO: em hospedagens com disco
  // efêmero (reinicia zerado a cada deploy, como costuma ser o caso em
  // Northflank/Buildpack) esses arquivos locais NÃO sobrevivem a um redeploy —
  // use também o botão "Baixar backup agora" no painel (Configurações), que
  // baixa o arquivo direto pro computador do admin.
  rodarBackup().catch((err) => console.error('[backup] erro na execução inicial:', err));
  setInterval(() => {
    rodarBackup().catch((err) => console.error('[backup] erro na execução agendada:', err));
  }, 24 * 60 * 60 * 1000);
});
