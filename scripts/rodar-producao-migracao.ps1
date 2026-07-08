<#
.SYNOPSIS
  Roda UM COMANDO administrativo (ex.: a migracao do Secullum, um
  diagnostico, uma verificacao) conectado DE PROPOSITO na producao (Turso),
  sem deixar o servidor no ar.

.DESCRIPTION
  Mesma logica de seguranca do rodar-producao.ps1 (que sobe o servidor
  inteiro com "npm start"), mas pensado pra rodar scripts administrativos
  pontuais contra producao - por exemplo migrar-secullum-v2.js,
  verificar-migracao.js, importar-biometria-catraca.js, etc.

  O que este script faz:
    1) Mostra um aviso bem visivel em vermelho com o comando exato que vai
       rodar, pra voce conferir antes de confirmar.
    2) Pede uma confirmacao digitada ("SIM", maiusculo).
    3) Le DATABASE_URL/DATABASE_AUTH_TOKEN de producao direto das linhas
       comentadas do .env (nao precisa editar nada na mao) e define como
       variavel de ambiente SO desta janela do PowerShell.
    4) Roda o comando que voce passar como parametro.

  Fechar esta janela do PowerShell derruba as variaveis de ambiente - nao
  deixa rastro em outras janelas/sessoes, e o .env nunca e alterado.

.NOTES
  Scripts individuais (como migrar-secullum-v2.js) ainda podem ter uma trava
  propria que exige uma flag extra (ex.: --confirmar-producao) alem de
  DATABASE_URL apontar pra producao - e proposital, uma segunda camada de
  seguranca. Inclua essa flag no comando que voce passar aqui quando o
  script pedir.

.EXAMPLE
  .\scripts\rodar-producao-migracao.ps1 "node scripts/migrar-secullum-v2.js --dry-run --confirmar-producao"

.EXAMPLE
  .\scripts\rodar-producao-migracao.ps1 "node scripts/verificar-migracao.js"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Comando
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Red
Write-Host " ATENCAO: isso vai conectar este PC na PRODUCAO (Turso)." -ForegroundColor Red
Write-Host " Comando que sera executado:" -ForegroundColor Red
Write-Host "   $Comando" -ForegroundColor Yellow
Write-Host " Qualquer coisa que esse comando fizer mexe em dados REAIS" -ForegroundColor Red
Write-Host " da academia. Confira 2x que e o comando certo antes de" -ForegroundColor Red
Write-Host " confirmar." -ForegroundColor Red
Write-Host "=========================================================" -ForegroundColor Red
Write-Host ""

$resposta = Read-Host "Digite SIM (maiusculo) para confirmar que quer mesmo rodar isso contra producao"
if ($resposta -ne 'SIM') {
    Write-Host "Cancelado. Nada foi rodado." -ForegroundColor Yellow
    exit 0
}

$envPath = Join-Path $ProjectRoot '.env'
if (-not (Test-Path $envPath)) {
    Write-Host "ERRO: .env nao encontrado em $ProjectRoot." -ForegroundColor Red
    exit 1
}

$linhas = Get-Content $envPath
$urlLinha = $linhas | Where-Object { $_ -match '^#\s*DATABASE_URL=libsql://' } | Select-Object -First 1
$tokenLinha = $linhas | Where-Object { $_ -match '^#\s*DATABASE_AUTH_TOKEN=' } | Select-Object -First 1

if (-not $urlLinha) {
    Write-Host "ERRO: nao encontrei a linha comentada '# DATABASE_URL=libsql://...' no .env." -ForegroundColor Red
    Write-Host "Confira se o .env ainda tem essa linha (mesmo comentada com #) na secao Banco de dados." -ForegroundColor Red
    exit 1
}

$env:DATABASE_URL = ($urlLinha -replace '^#\s*DATABASE_URL=', '')
$env:DATABASE_AUTH_TOKEN = ($tokenLinha -replace '^#\s*DATABASE_AUTH_TOKEN=', '')

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Red
Write-Host " USANDO: PRODUCAO (Turso) - dados REAIS da academia" -ForegroundColor Red
Write-Host " Rodando: $Comando" -ForegroundColor Yellow
Write-Host "=========================================================" -ForegroundColor Red
Write-Host ""

Invoke-Expression $Comando

Write-Host ""
Write-Host "=========================================================" -ForegroundColor DarkGray
Write-Host " Fim do comando. Feche esta janela para garantir que as" -ForegroundColor DarkGray
Write-Host " variaveis de producao nao ficam soltas em outra tarefa." -ForegroundColor DarkGray
Write-Host "=========================================================" -ForegroundColor DarkGray
Write-Host ""
