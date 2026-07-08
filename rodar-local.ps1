<#
.SYNOPSIS
  Sobe o servidor (npm start) forçando conexão com o local.db de teste,
  SEM tocar no arquivo .env (que continua apontando pro Turso de produção
  pra qualquer outro uso).

.DESCRIPTION
  O .env deste projeto está configurado de propósito pra sempre apontar pro
  Turso de produção (comentário original: "para que rodar localmente e
  acessar pela nuvem sempre reflitam os mesmos dados"). Isso quer dizer que
  um "npm start" comum SEMPRE conecta na produção - foi isso que causou
  cobrança fantasma em produção quando testamos a migração.

  Este .ps1 define DATABASE_URL e DATABASE_AUTH_TOKEN só para esta janela
  do PowerShell (variáveis de ambiente de sessão), antes de rodar
  "npm start". O dotenv do projeto NUNCA sobrescreve uma variável de
  ambiente que já foi definida antes - então, com essas variáveis já
  setadas aqui, o servidor vai ignorar as linhas de Turso do .env e usar o
  local.db, sem precisar editar o .env (e sem risco de esquecer de reverter
  uma edição depois).

  Fechar esta janela do PowerShell derruba o servidor e as variáveis de
  ambiente somem com ela - não deixa nenhum rastro em outras janelas/sessões.

.NOTES
  Depois de rodar isso, confira no terminal a mensagem de confirmação
  "USANDO: local.db (teste)" antes de considerar qualquer coisa que aparecer
  no painel como sendo do banco de teste.
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

if (-not (Test-Path (Join-Path $ProjectRoot 'local.db'))) {
    Write-Host "ERRO: local.db não encontrado em $ProjectRoot." -ForegroundColor Red
    exit 1
}

$env:DATABASE_URL = 'file:./local.db'
$env:DATABASE_AUTH_TOKEN = ''

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host " USANDO: local.db (teste) - NAO e a producao (Turso)" -ForegroundColor Green
Write-Host " Isso vale so para esta janela do PowerShell." -ForegroundColor DarkGray
Write-Host " O .env nao foi alterado." -ForegroundColor DarkGray
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

npm start
