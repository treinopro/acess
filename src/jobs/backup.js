// Job de backup automático: gera um dump JSON de todas as tabelas e salva em
// ./backups no disco local do servidor, mantendo só os últimos 7 arquivos.
//
// ATENÇÃO — limitação importante: em hospedagens com disco efêmero (o disco
// reseta a cada novo deploy, que é o caso comum em serviços tipo Northflank
// via Buildpack, sem volume persistente configurado), esses arquivos locais
// só sobrevivem enquanto o mesmo processo/container continuar no ar. Eles NÃO
// substituem um backup off-server de verdade. Por isso o painel (Configurações)
// também tem um botão "Baixar backup agora", que gera o mesmo dump e baixa
// direto pro computador do admin — esse sim sai do servidor e fica seguro.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { gerarBackupCompleto } = require('../routes/config.routes');

const PASTA_BACKUPS = path.join(__dirname, '..', '..', 'backups');
const MAX_BACKUPS_MANTIDOS = 7;

async function rodar() {
  if (!fs.existsSync(PASTA_BACKUPS)) fs.mkdirSync(PASTA_BACKUPS, { recursive: true });

  const dump = await gerarBackupCompleto();
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

  console.log(`[backup] ${new Date().toISOString()} — backup salvo em ${caminho} (${antigos.length} antigo(s) removido(s)).`);
  return caminho;
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

module.exports = { rodar };
