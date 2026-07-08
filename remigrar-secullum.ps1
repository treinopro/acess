<#
.SYNOPSIS
  Zera todos os dados de aluno (matrículas, cobranças, anamneses, avaliações,
  treinos, agendamentos, checkins, acessos da catraca) e refaz a migração do
  Secullum do zero, com a versão 2 do script (idempotente, sem gerar
  cobrança fantasma).

.DESCRIPTION
  Este .ps1 encadeia 3 scripts Node, cada um com seu próprio modo dry-run:

    1) scripts/zerar-dados-alunos.js     — apaga tudo ligado a aluno
       (NÃO mexe em usuários/login, planos, turmas, configurações)
    2) scripts/aplicar-colunas-secullum.js — garante as colunas novas
       (secullum_id / secullum_numero) no banco, idempotente
    3) scripts/migrar-secullum-v2.js     — remigra do zero, lendo os CSVs
       em ../export (fora da pasta do projeto)

  Por que uma migração nova, e não só rodar a v1 de novo:
    - A v1 gerava um id novo aleatório a cada execução, então uma migração
      interrompida e re-executada duplicava tudo. A v2 usa o id original do
      Secullum pra nunca duplicar, mesmo se for interrompida e re-rodada.
    - A v1 deixava as cobranças importadas sem ligação com a matrícula, o que
      fazia a rotina de recorrência (que roda sozinha ao subir o servidor)
      "achar" que toda matrícula importada era nova e lançar uma primeira
      cobrança fantasma na data_inicio — que, pior, às vezes é uma DATA DE
      PAGAMENTO do Secullum, não um vencimento de verdade (caso real
      encontrado: Edna Andrade). A v2 liga a cobrança 'legado' mais recente
      de cada matrícula (mesmo aluno + mesmo serviço) via matricula_id, sem
      criar nenhuma cobrança nova — então a recorrência sempre encontra de
      onde continuar.

  Fluxo deste .ps1:
    1) Backup do banco (cópia bruta + npm run backup, se existir)
    2) zerar-dados-alunos.js em dry-run → mostra contagens → pede SIM → aplica
    3) aplicar-colunas-secullum.js (idempotente, roda direto sem perguntar)
    4) migrar-secullum-v2.js em dry-run → mostra relatório → pede SIM → aplica

.PARAMETER Auto
  Pula as duas confirmações manuais ("Digite SIM...") e segue direto depois
  de mostrar cada simulação. Use só depois de já ter revisado a simulação
  em uma rodada anterior (ex: se em rodadas passadas o script sempre parou
  bem na hora de digitar SIM). O backup continua sendo feito normalmente
  antes de qualquer alteração, com ou sem -Auto.

.NOTES
  NÃO suba o servidor (npm start / npm run dev) nem rode
  `npm run gerar-cobrancas` entre este script terminar e você revisar o
  relatório final (export/relatorio-migracao-v2.json) — a rotina de
  recorrência roda sozinha no boot do servidor.
#>

param(
    [switch]$Auto
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

Write-Host ""
Write-Host "=== Zerar dados de aluno + remigrar do Secullum (v2) ===" -ForegroundColor Cyan
if ($Auto) {
    Write-Host "(modo -Auto: vai pular as confirmacoes 'Digite SIM' depois de mostrar cada simulacao)" -ForegroundColor DarkYellow
}
Write-Host ""

if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) {
    Write-Host "ERRO: rode este .ps1 de dentro da pasta 'academia-gestao'." -ForegroundColor Red
    exit 1
}
$LocalDb = Join-Path $ProjectRoot 'local.db'
if (-not (Test-Path $LocalDb)) {
    Write-Host "ERRO: local.db não encontrado. Este script só mexe no banco LOCAL." -ForegroundColor Red
    exit 1
}
$ExportDir = Join-Path $ProjectRoot '..\export'
if (-not (Test-Path (Join-Path $ExportDir 'contas_receber.csv'))) {
    Write-Host "ERRO: não encontrei ..\export\contas_receber.csv (pasta com os CSVs do Secullum)." -ForegroundColor Red
    Write-Host "Confirme que a pasta 'export' está no mesmo nível de 'academia-gestao'." -ForegroundColor Red
    exit 1
}
try { node --version | Out-Null } catch {
    Write-Host "ERRO: Node.js não encontrado no PATH." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
    Write-Host "Instalando dependências (npm install)..." -ForegroundColor Yellow
    npm install
}

# --- Backup ---
$BackupsDir = Join-Path $ProjectRoot 'backups'
if (-not (Test-Path $BackupsDir)) { New-Item -ItemType Directory -Path $BackupsDir | Out-Null }
$Timestamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
$DbBackupPath = Join-Path $BackupsDir "local.db.antes-de-remigrar.$Timestamp.bak"
Write-Host "Fazendo backup do banco antes de qualquer coisa..." -ForegroundColor Yellow
Copy-Item -Path $LocalDb -Destination $DbBackupPath -Force
Write-Host "  Backup salvo em: $DbBackupPath" -ForegroundColor Green
$PackageJsonRaw = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw
if ($PackageJsonRaw -match '"backup"\s*:') {
    try { npm run backup } catch { Write-Host "  AVISO: 'npm run backup' falhou, seguindo com a cópia bruta já feita." -ForegroundColor Yellow }
}
Write-Host ""
Write-Host "Pra restaurar se algo der errado: apague o local.db atual e renomeie" -ForegroundColor DarkGray
Write-Host "'$DbBackupPath' de volta para 'local.db'." -ForegroundColor DarkGray
Write-Host ""

# --- Passo 1: zerar dados de aluno ---
Write-Host "=== Passo 1/3: zerar dados de aluno (simulação) ===" -ForegroundColor Cyan
node scripts\zerar-dados-alunos.js
if ($LASTEXITCODE -ne 0) { Write-Host "ERRO na simulação de zerar. Nada foi apagado." -ForegroundColor Red; exit 1 }
Write-Host ""
if ($Auto) {
    Write-Host "(-Auto) seguindo direto para apagar de verdade..." -ForegroundColor DarkYellow
} else {
    $R1 = Read-Host "Digite SIM para apagar os dados de aluno de verdade, ou qualquer coisa pra cancelar tudo"
    if ($R1 -ne 'SIM') { Write-Host "Cancelado. Nada foi alterado." -ForegroundColor Yellow; exit 0 }
}
node scripts\zerar-dados-alunos.js --aplicar
if ($LASTEXITCODE -ne 0) { Write-Host "ERRO ao zerar. Backup em: $DbBackupPath" -ForegroundColor Red; exit 1 }

# --- Passo 2: colunas novas (idempotente, roda direto) ---
Write-Host ""
Write-Host "=== Passo 2/3: aplicar colunas de idempotência (secullum_id) ===" -ForegroundColor Cyan
node scripts\aplicar-colunas-secullum.js
if ($LASTEXITCODE -ne 0) { Write-Host "ERRO ao aplicar colunas. Backup em: $DbBackupPath" -ForegroundColor Red; exit 1 }

# --- Passo 3: migração v2 ---
Write-Host ""
Write-Host "=== Passo 3/3: remigração do Secullum (simulação) ===" -ForegroundColor Cyan
node scripts\migrar-secullum-v2.js --dry-run
if ($LASTEXITCODE -ne 0) { Write-Host "ERRO na simulação da migração. Nada foi gravado ainda." -ForegroundColor Red; exit 1 }
Write-Host ""
Write-Host "Confira o relatório acima (e o total de 'matriculasSemCobrancaLegadoParaAdotar')." -ForegroundColor Yellow
if ($Auto) {
    Write-Host "(-Auto) seguindo direto para gravar a migração de verdade..." -ForegroundColor DarkYellow
} else {
    $R2 = Read-Host "Digite SIM para gravar a migração de verdade, ou qualquer coisa pra parar aqui"
    if ($R2 -ne 'SIM') { Write-Host "Parado antes de gravar a migração. O banco já está zerado (passo 1 aplicado)." -ForegroundColor Yellow; exit 0 }
}
node scripts\migrar-secullum-v2.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO na migração. Como o script é idempotente, pode rodar 'node scripts\migrar-secullum-v2.js' de novo sem duplicar o que já gravou." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Concluído ===" -ForegroundColor Green
Write-Host "Confira o relatório completo em: export\relatorio-migracao-v2.json" -ForegroundColor Green
Write-Host "Rode 'node scripts\verificar-migracao.js' pra conferir antes de subir o servidor." -ForegroundColor Yellow
Write-Host "NAO rode 'npm start' / 'npm run dev' ate revisar - o servidor dispara a rotina de recorrencia sozinho ao subir." -ForegroundColor Yellow
Write-Host "Backup do banco de antes de tudo isso: $DbBackupPath" -ForegroundColor Green
