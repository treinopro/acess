// Job de backup automático: gera um dump JSON de todas as tabelas e entrega
// no destino configurado pelo admin (Configurações > Backup — ver
// PADROES_BACKUP em src/routes/config.routes.js): 'local' (disco do próprio
// servidor, mantendo só os últimos 7 arquivos — comportamento histórico),
// 'email' (anexo enviado por Gmail SMTP, mesmo mecanismo usado em Recuperação
// de Clientes) ou 'ambos'.
//
// ATENÇÃO — limitação importante do destino 'local': em hospedagens com disco
// efêmero (o disco reseta a cada novo deploy, caso comum em serviços tipo
// Northflank via Buildpack, sem volume persistente configurado), esses
// arquivos locais só sobrevivem enquanto o mesmo processo/container continuar
// no ar. Não substituem um backup off-server de verdade — por isso o painel
// também tem um botão "Baixar backup agora" (sempre baixa direto pro
// computador do admin, independente do destino configurado aqui) e o destino
// 'email'/'ambos' tira uma cópia do servidor de propósito.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { gerarBackupCompleto } = require('../routes/config.routes');
const db = require('../db/client');
const { enviarEmail, emailConfigurado } = require('../services/email.service');

const PASTA_BACKUPS = path.join(__dirname, '..', '..', 'backups');
const MAX_BACKUPS_MANTIDOS = 7;

const PADROES_BACKUP_CONFIG = {
  backup_destino: 'local',
  backup_email_destino: '',
  backup_agendamento_frequencia: 'diario',
  backup_agendamento_hora: '03:00',
  backup_agendamento_dia_semana: '0',
};

async function lerConfigBackup() {
  const result = await db.execute(
    `SELECT chave, valor FROM configuracoes WHERE chave IN (
      'backup_destino', 'backup_email_destino', 'backup_agendamento_frequencia',
      'backup_agendamento_hora', 'backup_agendamento_dia_semana', 'backup_ultima_execucao_agendada'
    )`,
  );
  const config = { ...PADROES_BACKUP_CONFIG };
  result.rows.forEach((r) => { config[r.chave] = r.valor; });
  return config;
}

function salvarLocal(dump) {
  if (!fs.existsSync(PASTA_BACKUPS)) fs.mkdirSync(PASTA_BACKUPS, { recursive: true });
  const nomeArquivo = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const caminho = path.join(PASTA_BACKUPS, nomeArquivo);
  fs.writeFileSync(caminho, JSON.stringify(dump, null, 2));

  // Mantém só os N mais recentes pra não acumular disco indefinidamente.
  const arquivos = fs.readdirSync(PASTA_BACKUPS)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
    .sort()
    .reverse();
  const antigos = arquivos.slice(MAX_BACKUPS_MANTIDOS);
  antigos.forEach((f) => fs.unlinkSync(path.join(PASTA_BACKUPS, f)));
  return { caminho, removidos: antigos.length };
}

async function enviarPorEmail(dump, destinoConfigurado) {
  const destino = destinoConfigurado || process.env.GMAIL_USER;
  if (!destino) throw new Error('Nenhum e-mail de destino configurado pro backup (defina em Configurações > Backup, ou GMAIL_USER no servidor).');
  if (!emailConfigurado()) throw new Error('Envio de backup por e-mail não configurado: defina GMAIL_USER e GMAIL_APP_PASSWORD no servidor.');
  const nomeArquivo = `backup-academia-${new Date().toISOString().slice(0, 10)}.json`;
  await enviarEmail({
    para: destino,
    assunto: `Backup automático — ${new Date().toLocaleDateString('pt-BR')}`,
    texto: 'Backup completo do sistema em anexo (JSON). Guarde em local seguro.',
    anexos: [{ filename: nomeArquivo, content: JSON.stringify(dump, null, 2), contentType: 'application/json' }],
  });
  return destino;
}

async function rodar() {
  const config = await lerConfigBackup();
  const dump = await gerarBackupCompleto();
  const resultado = {};

  if (config.backup_destino === 'local' || config.backup_destino === 'ambos') {
    const { caminho, removidos } = salvarLocal(dump);
    resultado.local = caminho;
    console.log(`[backup] ${new Date().toISOString()} — backup salvo em ${caminho} (${removidos} antigo(s) removido(s)).`);
  }

  if (config.backup_destino === 'email' || config.backup_destino === 'ambos') {
    try {
      resultado.email = await enviarPorEmail(dump, config.backup_email_destino);
      console.log(`[backup] ${new Date().toISOString()} — backup enviado por e-mail para ${resultado.email}.`);
    } catch (err) {
      console.error('[backup] erro ao enviar backup por e-mail:', err.message);
      // E-mail era o ÚNICO destino configurado e falhou — salva local mesmo
      // assim como rede de segurança (melhor ter um backup em algum lugar do
      // que nenhum), mas deixa o erro explícito no log pro admin corrigir.
      if (config.backup_destino === 'email') {
        const { caminho, removidos } = salvarLocal(dump);
        resultado.local = caminho;
        console.log(`[backup] fallback: backup salvo localmente em ${caminho} (${removidos} antigo(s) removido(s)).`);
      }
    }
  }

  return resultado;
}

// ---------------- Agendamento configurável ----------------
// Chamado periodicamente pelo server.js (a cada 5 min — ver lá). Roda de
// verdade só quando o horário atual cai dentro da janela configurada E ainda
// não rodou hoje. A última execução agendada fica gravada no próprio banco
// (não em memória) pra sobreviver a reinícios/redeploys sem disparar de novo
// à toa nem perder o dia se o processo cair perto do horário marcado.
async function verificarAgendamento() {
  const config = await lerConfigBackup();
  if (config.backup_agendamento_frequencia === 'desativado') return;

  const agora = new Date();
  const [horaCfg, minCfg] = String(config.backup_agendamento_hora || '03:00').split(':').map(Number);
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
  const minutosAlvo = horaCfg * 60 + (minCfg || 0);
  // Janela de 10 min pra não perder o horário caso a checagem (a cada 5 min)
  // não bata exatamente no minuto configurado.
  if (minutosAgora < minutosAlvo || minutosAgora >= minutosAlvo + 10) return;

  if (config.backup_agendamento_frequencia === 'semanal') {
    const diaCfg = Number(config.backup_agendamento_dia_semana ?? 0);
    if (agora.getDay() !== diaCfg) return;
  }

  const chaveHoje = agora.toISOString().slice(0, 10);
  if (config.backup_ultima_execucao_agendada === chaveHoje) return;

  await rodar();
  await db.execute({
    sql: `INSERT INTO configuracoes (chave, valor) VALUES ('backup_ultima_execucao_agendada', ?)
          ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
    args: [chaveHoje],
  });
}

// Permite rodar manualmente: `node src/jobs/backup.js`
if (require.main === module) {
  rodar()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[backup] erro ao gerar backup:', err);
      process.exit(1);
    });
}

module.exports = { rodar, verificarAgendamento };
