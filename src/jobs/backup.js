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
const { escreverBackupStream } = require('../routes/config.routes');
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

/** Escreve o backup direto num arquivo, em streaming (ver escreverBackupStream) — nunca monta o JSON inteiro em memória. */
function escreverBackupEmArquivo(caminho) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(caminho);
    stream.on('error', reject);
    escreverBackupStream(stream)
      .then(() => stream.end(resolve))
      .catch((err) => { stream.destroy(); reject(err); });
  });
}

/** Mantém só os N arquivos de backup mais recentes na pasta, pra não acumular disco indefinidamente. */
function limparBackupsAntigos() {
  const arquivos = fs.readdirSync(PASTA_BACKUPS)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
    .sort()
    .reverse();
  const antigos = arquivos.slice(MAX_BACKUPS_MANTIDOS);
  antigos.forEach((f) => fs.unlinkSync(path.join(PASTA_BACKUPS, f)));
  return antigos.length;
}

async function enviarPorEmail(caminhoArquivo, destinoConfigurado) {
  const destino = destinoConfigurado || process.env.GMAIL_USER;
  if (!destino) throw new Error('Nenhum e-mail de destino configurado pro backup (defina em Configurações > Backup, ou GMAIL_USER no servidor).');
  if (!emailConfigurado()) throw new Error('Envio de backup por e-mail não configurado: defina GMAIL_USER e GMAIL_APP_PASSWORD no servidor.');
  const nomeArquivo = `backup-academia-${new Date().toISOString().slice(0, 10)}.json`;
  await enviarEmail({
    para: destino,
    assunto: `Backup automático — ${new Date().toLocaleDateString('pt-BR')}`,
    texto: 'Backup completo do sistema em anexo (JSON). Guarde em local seguro.',
    // `path` (em vez de `content`) faz o nodemailer ler o arquivo do disco em
    // streaming durante o envio, sem carregar o JSON inteiro de novo na
    // memória do processo — mesmo motivo de existir escreverBackupEmArquivo
    // acima (ver comentário no topo do arquivo).
    anexos: [{ filename: nomeArquivo, path: caminhoArquivo, contentType: 'application/json' }],
  });
  return destino;
}

async function rodar() {
  const config = await lerConfigBackup();
  const resultado = {};

  if (!fs.existsSync(PASTA_BACKUPS)) fs.mkdirSync(PASTA_BACKUPS, { recursive: true });

  const querLocal = config.backup_destino === 'local' || config.backup_destino === 'ambos';
  const querEmail = config.backup_destino === 'email' || config.backup_destino === 'ambos';

  // Gera o arquivo UMA vez só (streaming — ver escreverBackupEmArquivo), não
  // duas consultas separadas ao banco. Se for pra ficar local, já escreve
  // direto no destino final; se for só pra e-mail, escreve num arquivo
  // temporário que é apagado depois de enviado.
  const nomeArquivo = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const caminhoFinal = path.join(PASTA_BACKUPS, nomeArquivo);
  const caminhoGerado = querLocal ? caminhoFinal : path.join(PASTA_BACKUPS, `.tmp-${nomeArquivo}`);

  await escreverBackupEmArquivo(caminhoGerado);

  if (querLocal) {
    const removidos = limparBackupsAntigos();
    resultado.local = caminhoGerado;
    console.log(`[backup] ${new Date().toISOString()} — backup salvo em ${caminhoGerado} (${removidos} antigo(s) removido(s)).`);
  }

  if (querEmail) {
    try {
      resultado.email = await enviarPorEmail(caminhoGerado, config.backup_email_destino);
      console.log(`[backup] ${new Date().toISOString()} — backup enviado por e-mail para ${resultado.email}.`);
    } catch (err) {
      console.error('[backup] erro ao enviar backup por e-mail:', err.message);
      // E-mail era o ÚNICO destino configurado e falhou — mantém o arquivo já
      // gerado como backup local mesmo assim (melhor ter um backup em algum
      // lugar do que nenhum), só renomeando do temporário pro nome final.
      if (config.backup_destino === 'email') {
        fs.renameSync(caminhoGerado, caminhoFinal);
        const removidos = limparBackupsAntigos();
        resultado.local = caminhoFinal;
        console.log(`[backup] fallback: backup salvo localmente em ${caminhoFinal} (${removidos} antigo(s) removido(s)).`);
      }
    } finally {
      // Limpa o temporário só se ele ainda existir nesse caminho (não existe
      // mais se acabou de ser renomeado no fallback acima, nem se querLocal
      // já era true — nesse caso caminhoGerado é o próprio caminhoFinal).
      if (!querLocal && fs.existsSync(caminhoGerado)) fs.unlinkSync(caminhoGerado);
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

// 2026-09-02: o backup "de segurança" que roda uma vez a cada subida do
// processo (ver comentário em server.js — sempre gera um dump fresco a cada
// deploy) NUNCA teve nenhuma proteção contra duplicidade, ao contrário do
// agendamento normal (verificarAgendamento acima, que só roda 1x por dia,
// controlado por data gravada no banco). Isso é inofensivo quando o
// processo só reinicia mesmo em deploy de verdade — mas vira um problema
// real (relatado pelo dono: "vários backups de novo, isso já nos trouxe
// problemas antes") quando o processo reinicia várias vezes seguidas por
// qualquer outro motivo (reinícios manuais, falha de health-check,
// crash-loop, múltiplos deploys em sequência no mesmo dia) — cada subida
// manda um e-mail de backup novo, sem limite.
//
// rodarNaSubidaSeNaoRecente() dá essa proteção sem tirar a utilidade do
// "sempre fresco a cada deploy": só pula se já rodou há menos de
// INTERVALO_MINIMO_BOOT_MIN minutos, gravado no banco (não em memória, pelo
// mesmo motivo do agendamento normal — sobrevive a reinícios). Deploys
// normais, espaçados ao longo do dia, continuam gerando backup fresco
// normalmente; só uma rajada de reinícios próximos no tempo é que passa a
// gerar UM só, não um por reinício.
const INTERVALO_MINIMO_BOOT_MIN = 180; // 3h
async function rodarNaSubidaSeNaoRecente() {
  const check = await db.execute(
    `SELECT (julianday('now') - julianday(valor)) * 24 * 60 AS minutos
     FROM configuracoes WHERE chave = 'backup_ultima_execucao_boot'`,
  );
  const minutosDesdeUltima = check.rows[0]?.minutos;
  if (minutosDesdeUltima != null && minutosDesdeUltima < INTERVALO_MINIMO_BOOT_MIN) {
    console.log(`[backup] pulando backup de subida — o último rodou há ${Math.round(minutosDesdeUltima)} min (mínimo ${INTERVALO_MINIMO_BOOT_MIN} min entre reinícios do processo).`);
    return null;
  }
  const resultado = await rodar();
  await db.execute(
    `INSERT INTO configuracoes (chave, valor) VALUES ('backup_ultima_execucao_boot', datetime('now'))
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
  );
  return resultado;
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

module.exports = { rodar, verificarAgendamento, rodarNaSubidaSeNaoRecente };
