<#
.SYNOPSIS
  Apaga cobrancas (contas) marcadas como "pendente", com vencimento entre
  01/01/2026 e 09/06/2026, no valor de R$65,00 ou R$60,00.

.DESCRIPTION
  Este script e um "wrapper" em PowerShell para o script Node.js
  scripts\apagar-contas-pendentes-periodo.js, que e quem realmente conversa
  com o banco (local.db, SQLite/libSQL). PowerShell puro nao tem driver
  nativo pra esse banco, entao o trabalho de fato e feito pelo Node usando a
  mesma biblioteca (@libsql/client) que o resto do projeto ja usa - assim o
  script segue exatamente as mesmas regras/tabelas do sistema.

  Fluxo:
    1) Confere se esta sendo executado dentro da pasta do projeto
       (precisa existir package.json e local.db).
    2) Faz backup do banco antes de mexer em qualquer coisa:
         - copia bruta de local.db para backups\
         - roda "npm run backup" (gera o dump JSON, se o script existir)
    3) Roda o script Node em modo DRY-RUN (so mostra o que seria apagado,
       nao grava nada) e mostra o resultado na tela.
    4) Pede confirmacao explicita (digitar SIM) antes de apagar de verdade.
    5) Se confirmado, roda o script Node com --aplicar.

.NOTES
  Se quiser mudar o periodo/valores, edite as variaveis no topo do arquivo
  scripts\apagar-contas-pendentes-periodo.js (ou passe --de/--ate/--valores
  na mao chamando o node diretamente).
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

Write-Host ""
Write-Host "=== Apagar contas pendentes (01/01/2026 a 09/06/2026, R\$65,00 ou R\$60,00) ===" -ForegroundColor Cyan
Write-Host ""

# 1) Confere se estamos na pasta certa do projeto
if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) {
    Write-Host "ERRO: package.json nao encontrado em '$ProjectRoot'." -ForegroundColor Red
    Write-Host "Coloque este .ps1 na raiz da pasta 'academia-gestao' e rode de novo." -ForegroundColor Red
    exit 1
}

$LocalDb = Join-Path $ProjectRoot 'local.db'
if (-not (Test-Path $LocalDb)) {
    Write-Host "ERRO: local.db nao encontrado em '$ProjectRoot'." -ForegroundColor Red
    Write-Host "Este script so mexe no banco LOCAL (local.db) - se voce usa banco remoto (Turso/producao), ele nao serve pra isso." -ForegroundColor Red
    exit 1
}

$ScriptNode = Join-Path $ProjectRoot 'scripts\apagar-contas-pendentes-periodo.js'
if (-not (Test-Path $ScriptNode)) {
    Write-Host "ERRO: nao encontrei scripts\apagar-contas-pendentes-periodo.js" -ForegroundColor Red
    Write-Host "Copie esse arquivo para a pasta 'scripts' do projeto antes de rodar este .ps1." -ForegroundColor Red
    exit 1
}

# node instalado?
try {
    node --version | Out-Null
} catch {
    Write-Host "ERRO: Node.js nao encontrado no PATH. Instale o Node (https://nodejs.org) antes de continuar." -ForegroundColor Red
    exit 1
}

# node_modules instalado?
if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
    Write-Host "Dependencias nao instaladas (pasta node_modules ausente). Rodando 'npm install'..." -ForegroundColor Yellow
    npm install
}

# 2) Backup antes de qualquer coisa
$BackupsDir = Join-Path $ProjectRoot 'backups'
if (-not (Test-Path $BackupsDir)) {
    New-Item -ItemType Directory -Path $BackupsDir | Out-Null
}

$Timestamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
$DbBackupPath = Join-Path $BackupsDir "local.db.antes-de-apagar-contas.$Timestamp.bak"

Write-Host "Fazendo copia de seguranca do banco antes de mexer em qualquer coisa..." -ForegroundColor Yellow
Copy-Item -Path $LocalDb -Destination $DbBackupPath -Force
Write-Host "  Copia bruta do local.db salva em: $DbBackupPath" -ForegroundColor Green

$PackageJsonRaw = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw
if ($PackageJsonRaw -match '"backup"\s*:') {
    Write-Host "  Rodando 'npm run backup' (dump JSON adicional)..." -ForegroundColor Yellow
    try {
        npm run backup
        Write-Host "  Dump JSON gerado em backups\" -ForegroundColor Green
    } catch {
        Write-Host "  AVISO: 'npm run backup' falhou, mas a copia bruta do local.db ja foi feita acima. Prosseguindo mesmo assim." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Se algo der errado, para restaurar: feche o servidor, apague o local.db atual e renomeie" -ForegroundColor DarkGray
Write-Host "'$DbBackupPath' de volta para 'local.db'." -ForegroundColor DarkGray
Write-Host ""

# 3) Dry-run primeiro, sempre
Write-Host "=== Simulacao (dry-run) - nada sera apagado ainda ===" -ForegroundColor Cyan
node $ScriptNode
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO: a simulacao falhou (veja a mensagem acima). Nada foi apagado." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Confira a lista acima com atencao." -ForegroundColor Yellow
$Resposta = Read-Host "Digite SIM (maiusculo) para apagar essas contas de verdade, ou qualquer outra coisa para cancelar"

if ($Resposta -ne 'SIM') {
    Write-Host "Cancelado. Nenhuma conta foi apagada." -ForegroundColor Yellow
    exit 0
}

# 5) Aplica de verdade
Write-Host ""
Write-Host "=== Aplicando a exclusao de verdade ===" -ForegroundColor Cyan
node $ScriptNode --aplicar
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO durante a exclusao. Confira a mensagem acima. O backup esta em: $DbBackupPath" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Concluido. Backup do banco antes da operacao: $DbBackupPath" -ForegroundColor Green
