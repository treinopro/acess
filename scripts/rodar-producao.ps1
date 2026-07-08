<#
.SYNOPSIS
  Sobe o servidor (npm start) conectado DE PROPOSITO na producao (Turso) a
  partir deste PC - so para os poucos casos em que isso e realmente
  necessario (ex.: aplicar a migracao de verdade depois de validada no
  local.db, um diagnostico pontual contra dados reais).

.DESCRIPTION
  Desde 08/07/2026 o .env deste projeto tem como padrao o local.db (arquivo
  de teste) - rodar "npm start" ou "npm run dev" direto, sem nenhum script
  especial, NAO toca mais na producao. Isso foi trocado depois de um
  incidente em que subir o servidor localmente (achando que era so teste)
  gerou cobranca fantasma real em alunos, porque o .env antigo apontava pra
  producao por padrao.

  Este script existe pros raros casos em que voce PRECISA mesmo conectar
  este PC na producao (Turso) de proposito. Ele:
    1) avisa bem claro o que vai acontecer,
    2) pede uma confirmacao digitada antes de continuar,
    3) le a URL/token de producao direto das linhas comentadas do .env
       (nao precisa editar nada na mao, nem descomentar/recomentar depois).

.NOTES
  NAO precisa disso pro dia a dia da academia - o site publicado
  (Northflank/Render) ja fala com a producao sozinho, com suas proprias
  variaveis configuradas no painel de hospedagem, sem depender deste PC nem
  deste script. Isso aqui e so para uso administrativo pontual.
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Red
Write-Host " ATENCAO: isso vai conectar este PC na PRODUCAO (Turso)." -ForegroundColor Red
Write-Host " Qualquer coisa que o servidor fizer (inclusive a rotina" -ForegroundColor Red
Write-Host " automatica de cobranca recorrente, que roda no boot e a" -ForegroundColor Red
Write-Host " cada 24h) vai mexer nos dados REAIS da academia." -ForegroundColor Red
Write-Host "=========================================================" -ForegroundColor Red
Write-Host ""

$resposta = Read-Host "Digite SIM (maiusculo) para confirmar que quer mesmo conectar na producao"
if ($resposta -ne 'SIM') {
    Write-Host "Cancelado. Nada foi conectado." -ForegroundColor Yellow
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
Write-Host " Isso vale so para esta janela do PowerShell." -ForegroundColor DarkGray
Write-Host " O .env nao foi alterado." -ForegroundColor DarkGray
Write-Host "=========================================================" -ForegroundColor Red
Write-Host ""

npm start
