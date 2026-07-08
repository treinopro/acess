<#
.SYNOPSIS
  Apaga as cobrancas "fantasma" geradas pela migracao em lote do Secullum
  (matriculas retroativas criadas em 06/07/2026, cuja "primeira cobranca"
  nasceu com vencimento ja no passado).

.DESCRIPTION
  Este script e um "wrapper" em PowerShell para o script Node.js
  scripts\apagar-cobrancas-fantasma-migracao.js, que e quem realmente
  conversa com o banco (local.db, SQLite/libSQL) usando a mesma biblioteca
  (@libsql/client) que o resto do projeto ja usa.

  POR QUE ESSE CRITERIO (e nao so "valor = R$65 ou R$60"):
  Uma investigacao no banco mostrou que o pedido original (contas pendentes
  de R$65/R$60 entre 01/01 e 09/06/2026) so pegava 73 de um total de 227
  cobrancas com o MESMO problema (a maioria em outros valores: R$165, R$240,
  R$300, R$539,84). Todas as 227 sao "primeira cobranca" de matriculas que
  foram criadas em lote no dia 06/07/2026 (import do historico do Secullum),
  com vencimento retroativo - ou seja, nasceram ja vencidas, sem
  corresponder a uma divida real de hoje. Por isso nao apareciam quando voce
  procurava no sistema (confirmado: parte delas ja estava paga no sistema
  antigo, so nao migrou o pagamento).

  Filtro adicional (a pedido): so mexe em cobranca de aluno com
  alunos.status = 'ativo'. Aluno inativo/trancado e considerado "conta
  antiga" e NUNCA e tocado por este script, mesmo que a cobranca dele bata
  nos outros criterios - fica de fora da limpeza pra revisao manual.

  EVIDENCIA DE PAGAMENTO (a pedido, depois de voce confirmar no sistema
  antigo que varias dessas contas ja estavam pagas): o script so apaga uma
  cobranca fantasma se existir uma cobranca 'legado' PAGA do MESMO aluno com
  vencimento por perto (+/- 20 dias, ajustavel) - ou seja, prova de que
  aquele periodo ja foi pago em outro registro. Testado nas 227: 220 tem essa
  evidencia direta; as outras 7 NAO tem e por isso NAO sao apagadas
  automaticamente - ficam listadas a parte pra voce revisar uma por uma.

  Fluxo:
    1) Confere se esta sendo executado dentro da pasta do projeto
       (precisa existir package.json e local.db).
    2) Faz backup do banco antes de mexer em qualquer coisa:
         - copia bruta de local.db para backups\
         - roda "npm run backup" (gera o dump JSON, se o script existir)
    3) Roda o script Node em modo DRY-RUN (so mostra o que seria apagado,
       nao grava nada) e mostra a lista completa na tela.
    4) Pede confirmacao explicita (digitar SIM) antes de apagar de verdade.
    5) Se confirmado, roda o script Node com --aplicar.

.NOTES
  Cobranca que ja tiver algum pagamento parcial lancado NUNCA e apagada,
  mesmo que bata os outros criterios - fica listada a parte no relatorio.

  Cobranca sem uma cobranca 'legado' paga por perto (sem evidencia direta de
  pagamento do periodo) tambem NUNCA e apagada automaticamente - fica listada
  a parte pra revisao manual.

  Se quiser mudar o dia do lote, a data de corte ou o tamanho da janela de
  busca por evidencia de pagamento, chame o node direto:
    node scripts\apagar-cobrancas-fantasma-migracao.js --lote=2026-07-06 --hoje=2026-07-08 --janela-dias=20
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

Write-Host ""
Write-Host "=== Apagar cobrancas fantasma da migracao (matriculas em lote de 06/07/2026) ===" -ForegroundColor Cyan
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

$ScriptNode = Join-Path $ProjectRoot 'scripts\apagar-cobrancas-fantasma-migracao.js'
if (-not (Test-Path $ScriptNode)) {
    Write-Host "ERRO: nao encontrei scripts\apagar-cobrancas-fantasma-migracao.js" -ForegroundColor Red
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
$DbBackupPath = Join-Path $BackupsDir "local.db.antes-de-apagar-fantasmas.$Timestamp.bak"

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
Write-Host "Confira a lista acima com atencao (sao ~227 linhas - vale rolar a tela toda ou redirecionar a saida pra um arquivo)." -ForegroundColor Yellow
$Resposta = Read-Host "Digite SIM (maiusculo) para apagar essas cobrancas de verdade, ou qualquer outra coisa para cancelar"

if ($Resposta -ne 'SIM') {
    Write-Host "Cancelado. Nenhuma cobranca foi apagada." -ForegroundColor Yellow
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
