const path = require('path');
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
const { rodar: rodarRecorrencia } = require('./jobs/recorrencia');

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

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);

  // Gera as próximas mensalidades de planos recorrentes: roda uma vez ao subir
  // o servidor e depois a cada 24h enquanto o processo ficar no ar. Em produção,
  // como alternativa mais confiável, um Render Cron Job pode chamar
  // `npm run gerar-cobrancas` periodicamente (ver README).
  rodarRecorrencia().catch((err) => console.error('[recorrencia] erro na execução inicial:', err));
  setInterval(() => {
    rodarRecorrencia().catch((err) => console.error('[recorrencia] erro na execução agendada:', err));
  }, 24 * 60 * 60 * 1000);
});
