# Status do projeto — Academia Gestão

Última atualização: 06/07/2026 (sessão: agente local da catraca — concluída e validada em produção)

## Resumo

Sistema de gestão de academia (Node.js/Express + libSQL/Turso), publicado na nuvem via Northflank, com deploy manual via upload de arquivos no GitHub (sem `git push` configurado). O usuário testa localmente antes de subir.

## Onde está publicado

- App: `https://academia--acess--tpff5w2s24vs.code.run`
- Totem: `https://academia--acess--tpff5w2s24vs.code.run/terminal.html`
- Painel admin: `https://academia--acess--tpff5w2s24vs.code.run` (login: `admin@academia.com` / `admin123` — senha padrão, ainda não trocada)
- Repositório: GitHub `treinopro/acess`, branch `principal`/`main` (upload manual de arquivos, sem git push configurado)
- Hospedagem: Northflank (Buildpack, porta pública 8080), serviço no projeto `acess-academia` / time `acessfits-team`
- Banco de dados: Turso (libSQL), variáveis `DATABASE_URL`/`DATABASE_AUTH_TOKEN`

---

## ✅ CONCLUÍDO E VALIDADO EM PRODUÇÃO — agente local da catraca (sessão 06/07/2026)

Motivo: o painel está na nuvem (Northflank), mas a catraca Henry fica num IP
privado da rede da academia (`192.168.0.79`) — a nuvem nunca alcança um IP
privado, então "Testar conexão" sempre dava timeout. Foi implementado um
"agente local" que roda num PC da academia e faz a ponte. Confirmado
funcionando: o painel publicado mostra "Conexão com a catraca: **agente
local conectado**" e há liberações reais registradas em "Últimas tentativas
de acesso".

### Arquitetura (dois modos, escolhidos automaticamente pelo sistema)
- **Direto**: nenhum agente conectado → fala TCP direto do servidor pra catraca. Vale quando o painel roda na mesma rede da catraca (deploy 100% local).
- **Agente**: agente local conectado → comando repassado por WebSocket até o agente, que fala TCP com a catraca de dentro da rede da academia. É o modo em uso hoje (painel na nuvem).

### Arquivos novos (dentro de `academia-gestao/`) — já enviados ao GitHub
- `src/services/agenteGateway.service.js` — servidor WebSocket (`/agente/socket`) que aceita a conexão do agente local, autenticado por `AGENTE_TOKEN`, com heartbeat (ping/pong) e envio de comandos com timeout.
- `src/services/catracaGateway.service.js` — ponto único usado por todo o sistema para acionar a catraca; decide entre modo "direto" e "agente".

### Arquivos modificados — já enviados ao GitHub
- `package.json` — dependência `ws`.
- `src/server.js` — `http.createServer(app)` + `server.listen` (antes era `app.listen`), pra aceitar upgrade de WebSocket na mesma porta.
- `src/routes/terminal.routes.js` — rotas da catraca (pânico, liberar-aluno, testar, liberar) chamam `catracaGateway` em vez de `henryCatraca.service` direto; nova rota `GET /api/terminal/catraca/agente/status`.
- `src/services/acessoTerminal.service.js` — `liberarNaCatraca()` usa `catracaGateway.liberarAcesso`.
- `.env.example` — nova variável `AGENTE_TOKEN`.
- `README.md` — seção 9 reescrita explicando os dois modos.
- `public/index.html` / `public/app.js` — indicador "Conexão com a catraca: ..." na janela "Liberar Equipamentos", mostrando "agente local conectado" ou "modo direto".
- `public/terminal.js` — `TERMINAL_TOKEN` trocado (ver variáveis de ambiente abaixo).

### Pasta nova e independente: `agente-local/` (raiz do repositório, fora de `academia-gestao/`)
Programa Node.js standalone, **instalado e rodando agora** num PC da academia (mesma rede da catraca), gerenciado pelo **PM2** (reinicia sozinho se cair, e sobe automaticamente no boot via `pm2-windows-startup`).
- `agente-local/package.json`, `agente-local/.env.example` + `.env` (preenchido), `agente-local/henryCatraca.js` (cópia autocontida do cliente TCP), `agente-local/agente.js` (conexão WebSocket com reconexão automática + execução dos comandos), `agente-local/README.md`.
- Recurso opcional de biometria própria da catraca (`BIOMETRIA_CATRACA_ATIVA`) continua **desativado** (`false`) e não testado contra hardware real — só ativar depois de validar o protocolo com a catraca física.

### Ainda pendente desta frente
1. Testar a liberação de fato contra o hardware Henry físico em cenários variados (a esta altura já houve liberações reais registradas, mas vale seguir observando).
2. Se um dia trocar o PC que roda o agente, repetir a instalação (`agente-local/README.md`) e o setup do PM2 nesse novo PC.
3. Guardar o valor de `AGENTE_TOKEN` em local seguro (é o mesmo nos 3 lugares: Northflank, `academia-gestao/.env` local, `agente-local/.env`) — não está neste arquivo por segurança.

---

## ✅ CONCLUÍDO — rework do painel admin (sessão 06/07/2026, mesma leva de uploads)

Todos os arquivos abaixo foram reenviados ao GitHub e confirmados funcionando em produção (branding "Academia Superação" aparece no painel publicado, Contas a Receber carrega sem erro depois da migração).

### Arquivos novos
- `src/routes/config.routes.js`
- `src/jobs/backup.js`

### Arquivos modificados
- `public/index.html`, `public/app.js`, `public/style.css`
- `src/db/schema.sql` (2 tabelas novas: `pagamentos_cobranca`, `configuracoes` — migração já rodada em produção via Shell do Northflank)
- `src/routes/pagamentos.routes.js`, `src/routes/alunos.routes.js`, `src/routes/terminal.routes.js`
- `src/server.js`, `package.json`, `.gitignore`
- `src/routes/auth.routes.js` (também precisou ser reenviado — ficou faltando numa primeira leva de upload)

### O que foi feito neste rework (resumo por área)

**Organização geral do painel** (estilo Secullum Academia.Net): perfil do aluno em abas (Dados pessoais, Biometria & acesso, Anamnese, Avaliações, Matrículas, Agendamentos, Financeiro); "Acessos recentes" como gaveta lateral persistente.

**Contas a Receber** — fluxo completo estilo Secullum: busca por nome/aluno/status, modal "Conta" com sub-grade de pagamentos (quitação automática), modal "Pagamento", incluir/excluir/alterar/parcelar conta, aba Financeiro do perfil do aluno espelha essa tela.

**Catraca**: janela flutuante arrastável, formato compacto tipo "Liberar Equipamentos" do Secullum (liberar 1 acesso + lado, indicar pessoa, pânico/cancelar pânico), IP/porta atrás de "Configuração avançada". Limitação conhecida: hardware Henry libera sempre nos dois lados por comando (o "lado" só fica no histórico); pânico é mecanismo por software, não substitui trava mecânica de emergência.

**Relatórios**: Financeiro → Contas a Receber (filtros); Acessos → Acesso Diário, Acesso Pessoal, Último Acesso.

**Outras adições**: importar/exportar alunos em CSV; backup automático a cada 24h (disco efêmero, não confiável — usar botão "Baixar backup agora"); tela de Configurações (nome do app + "Licenciado para").

---

## Sessão anterior (auto cadastro + pagamento pelo totem) — já publicada

1. **Auto cadastro + pagamento pelo totem**: aluno novo se cadastra sozinho no totem, escolhe plano, paga via Pix, e o acesso (catraca) é liberado automaticamente assim que o pagamento é confirmado.
2. **Pagamento Mercado Pago via API de Orders** (`/v1/orders`) — não a API antiga de Payments.
3. **Verificação ativa de pagamento** (polling), sem depender só do webhook.
4. **QR Pix gerado no próprio totem** (client-side) a partir do código copia-e-cola.
5. **Testado e validado**: Pix real de R$1,00 confirmado ponta a ponta; reconhecimento facial ok no iPhone; login admin ok local.

### Arquivos alterados nessa sessão (já no GitHub)
- `src/services/payment/mercadopago.service.js`, `src/routes/terminal.routes.js`, `public/terminal.html`/`public/terminal.js`, `src/db/schema.sql`.
- `src/db/criar-test-user.js` — removido pelo usuário.

## Variáveis de ambiente relevantes (Northflank e `.env` local)

- `PAYMENT_PROVIDER=mercadopago`
- `MERCADOPAGO_ACCESS_TOKEN` — token de PRODUÇÃO (`APP_USR-...`); API de Orders não aceita token de teste.
- `MERCADOPAGO_WEBHOOK_SECRET` — configurado.
- `MERCADOPAGO_TEST_PAYER_EMAIL` — não usar (deixar apagado).
- `TERMINAL_TOKEN` — segredo do totem. **Trocado nesta sessão** (o valor antigo hardcoded em `terminal.js` foi substituído por um novo, sincronizado entre `academia-gestao/.env`, `public/terminal.js` e `agente-local/.env`). Confirme que o Northflank também tem esse mesmo valor novo — senão o totem para de autenticar.
- `HENRY_CATRACA_IP=192.168.0.79` / `HENRY_CATRACA_PORT=3000` — IP/porta padrão da catraca.
- `AGENTE_TOKEN` — segredo compartilhado entre o servidor e `agente-local/`; **configurado e validado** nos 3 lugares (Northflank, `.env` local, `agente-local/.env`).
- `DATABASE_URL` / `DATABASE_AUTH_TOKEN` — Turso. Local usa SQLite em arquivo (`file:./local.db`) por padrão; produção (Northflank) usa Turso — **migração já rodada em produção** via Shell do Northflank.

## Pendências

1. **Trocar senha padrão do admin** (`admin123`) — adiado explicitamente pelo usuário. Fazer quando o usuário pedir.
2. Testar a liberação de acesso via agente contra mais cenários reais de uso (dias/horários variados, quedas de internet do PC do agente).
3. Se quiser reativar simulação de pagamento de teste no futuro, investigar mais a fundo com o suporte do Mercado Pago (duas tentativas anteriores não funcionaram).
4. Biometria própria da catraca (`BIOMETRIA_CATRACA_ATIVA`) segue desativada e não validada contra hardware real.

## Aprendizados importantes (evitar repetir)

- **Deploy manual é frágil para múltiplos arquivos**: em pelo menos duas ocasiões desta sessão, um upload "completo" na verdade deixou de fora um arquivo novo (`config.routes.js`, depois `backup.js`, depois `auth.routes.js`), cada um causando `MODULE_NOT_FOUND` e crash-loop ("no healthy upstream") em produção. **Sempre conferir a lista completa de arquivos novos/modificados contra o que existe de fato no GitHub antes de considerar um upload concluído** — não confiar só na memória de "já mandei esse".
- **Diagnóstico de crash em produção**: Northflank → Deployments → instância com "Instance is crashing" → botão "View Logs"/"Logs" mostra o stack trace exato (`Cannot find module '...'`, `Require stack`) — sempre olhar aí primeiro em vez de supor a causa.
- **Rodar comandos administrativos (migração, etc.) direto no Northflank**: o botão "Shell (SSH)" de uma instância saudável abre um terminal dentro do container já com as variáveis de ambiente de produção carregadas — evita ter que copiar credenciais sensíveis (como `DATABASE_AUTH_TOKEN` do Turso) para a máquina local.
- **Cuidado ao transcrever segredos longos (tokens/JWT) via prints de tela** — risco real de erro de leitura (ex.: "O" vs "0"). Preferir copiar direto da fonte (Northflank, gerenciador de senhas) para o destino, sem intermediário digitando de novo.
- **`.env` com a mesma variável duplicada**: no formato usado pelo `dotenv`, a **última** ocorrência da chave é a que vale — evitar duplicar linhas ao editar `.env` manualmente (fácil de acontecer copiando comandos `Add-Content` mais de uma vez).
- **PATH do Windows após `npm install -g <pacote>`**: o executável pode não ser reconhecido nem em uma janela nova do PowerShell, se a pasta de pacotes globais do npm (`npm config get prefix`) não estiver no PATH do sistema. Corrigir permanentemente em "Editar as variáveis de ambiente do sistema" → Path — o truque `$env:Path += "..."` só vale pra aquela janela.
- **`localhost:3000` (servidor local) e o painel publicado na nuvem são processos separados**, cada um com seu próprio estado de conexão do agente — o agente conecta no `SERVIDOR_WS_URL` configurado (a nuvem, neste caso), então o indicador de status só muda na aba certa.
- A API de Orders (`/v1/orders`) do Mercado Pago exige token de produção, mesmo pra simular.
- O e-mail de teste fixo da documentação e conta de teste via API não funcionaram para simular Pix pela API de Orders.
- Chrome traduz automaticamente nomes técnicos na tela — desconfiar de nomes "estranhos" antes de assumir erro de configuração.
- Deploy é por upload manual de arquivos no GitHub (sem `git push`) — sempre listar exatamente quais arquivos mudaram após qualquer edição de código.
- Um campo `required` do HTML escondido (`display:none`) num bloco condicional, com o botão de submit do mesmo `<form>` visível em outro lugar, faz o Chrome bloquear o envio silenciosamente — validar manualmente em JS campos que podem ficar escondidos condicionalmente.
- `z-index` do toast precisa ser maior que o de modais/painéis.
