# Status do projeto — Academia Gestão

Última atualização: 08/07/2026. **Leia só a seção "ESTADO ATUAL" abaixo pra retomar o trabalho** — o resto do arquivo é histórico de sessões passadas, mantido só como referência de "por que as coisas são como são".

## ESTADO ATUAL (comece por aqui)

- **IMPORTANTE — leia a seção "Ambiente local vs produção (mudança de 08/07/2026)" logo abaixo antes de rodar qualquer coisa neste PC.** O `.env` mudou de padrão: `npm start`/`npm run dev` direto agora caem no `local.db` (arquivo de teste), não mais na produção. Isso veio de um incidente real (cobrança fantasma em produção) coberto em detalhe naquela seção.
- **Deploy é por `git push origin main`** (não é mais upload manual de arquivo por arquivo no GitHub). O Northflank redeploya sozinho a cada push na branch `main`. **O site publicado NÃO é afetado pela mudança de `.env` acima** — a hospedagem usa variáveis configuradas direto no painel dela, nunca lê o `.env` deste PC (está no `.gitignore`, nunca vai pro GitHub).
- **Migração do Secullum, v2**: refeita do zero no `local.db` (não na produção) com idempotência (`secullum_id`/`secullum_numero`) e um mecanismo de "adoção" de cobrança `legado` já existente em vez de criar cobrança nova pro primeiro ciclo — evita o padrão de cobrança fantasma que a v1 causava. Validação ainda em andamento (ver pendências abaixo). **A produção NÃO foi migrada com essa lógica ainda** — continua com os dados antigos, só limpos das 29 cobranças fantasma do incidente (ver seção nova abaixo).
- **Pendências reais agora** (nesta ordem):
  1. Continuar validando o `local.db`: conferir 10-15 alunos no painel (incluindo os casos de referência Edna Andrade e Alenia Cabral Silva), conferir totais em Relatórios, revisar os alunos marcados para revisão no relatório da migração.
  2. Depois da validação aprovada, decidir com calma se/quando aplicar a mesma migração v2 na produção de verdade (usando `scripts/rodar-producao.ps1`, nunca `npm start` direto) — não iniciar sem confirmação explícita.
  3. Decidir se aplica a limpeza dos ~50 grupos de cobranças `legado` duplicadas antigas (2020–2025) na produção — achado separado, não relacionado ao incidente de 08/07 (script já existia de sessão anterior, ver "Sessão 07/07/2026 (tarde)").
  4. Itens mais antigos ainda em aberto da sessão de 07/07 (tarde): `node src/db/migrate.js` (índice de proteção contra duplicata), `git push` das mudanças daquela sessão, confirmar `importar-biometria-catraca.js --aplicar`, decidir os 30 "ambíguos" de biometria/aluno duplicado, religar `BIOMETRIA_CATRACA_ATIVA`. Não foram tocados na sessão de 08/07 — status de cada um continua o mesmo registrado na seção "Sessão 07/07/2026 (tarde)" abaixo.
- As correções de segurança da sessão da manhã de 07/07/2026 (ver seção abaixo) **já foram enviadas** via `git push` e as variáveis de ambiente (`JWT_SECRET`, `CADASTRO_PUBLICO_TOKEN`) já foram configuradas no Northflank — não estão mais pendentes de upload, só falta confirmar se `MERCADOPAGO_WEBHOOK_SECRET` bate com o painel do Mercado Pago e se as variáveis antigas da InfinitePay foram removidas do Northflank.

## Onde está publicado

- App: `https://academia--acess--tpff5w2s24vs.code.run`
- Totem: `https://academia--acess--tpff5w2s24vs.code.run/terminal.html`
- Painel admin: `https://academia--acess--tpff5w2s24vs.code.run` (login: e-mail cadastrado do admin — a senha padrão `admin123` foi trocada via `scripts/trocar-senha-admin.js`, ver seção de segurança)
- Repositório: GitHub `treinopro/acess`, branch `main` — **deploy via `git push origin main`**
- Hospedagem: Northflank (Buildpack, porta pública 8080), serviço no projeto `acess-academia` / time `acessfits-team`
- Banco de dados: Turso (libSQL) — usado pela produção (site publicado, configurado direto no painel do Northflank) e, opcionalmente, por este PC quando rodado de propósito via `scripts/rodar-producao.ps1`. **Não é mais o padrão deste PC** — ver seção "Ambiente local vs produção (mudança de 08/07/2026)" logo abaixo. O padrão local agora é `local.db`, um arquivo SQLite separado, só de teste.

---

## Sessão 08/07/2026 — incidente de cobrança fantasma em produção e separação local vs produção

**Contexto**: nesta sessão a migração do Secullum foi refeita do zero (v2, com idempotência e "adoção" de cobrança `legado` em vez de gerar cobrança nova no primeiro ciclo) rodando só contra o `local.db`, um arquivo separado só de teste, pra nunca arriscar a produção enquanto a lógica ainda estava sendo validada.

### O incidente
O `.env` deste projeto estava desenhado (de propósito, numa sessão anterior) pra sempre apontar pra produção (Turso) — o comentário original dizia "para que rodar localmente e acessar pela nuvem sempre reflitam os mesmos dados". Isso significava que um `npm start`/`npm run dev` comum, sem nenhum cuidado extra, **sempre** conectava na produção — não existia "modo local" de verdade.

Em algum momento desta sessão o servidor foi subido localmente (por engano, achando que ia cair no `local.db` de teste) e ficou conectado na produção. A rotina de cobrança recorrente (`gerarCobrancasRecorrentes`, que roda sozinha a cada boot do servidor) rodou contra dados reais que nunca passaram pela migração v2 (então não tinham a "adoção" de cobrança `legado`) e gerou **29 cobranças `recorrencia` fantasma**, todas `pendente`, entre 06/07 21:16 e 08/07 01:45, duplicando ciclos que já tinham uma cobrança `legado` correspondente. Percebido porque um aluno (Maria clara de melo) apareceu com mensalidade duplicada no painel.

### Diagnóstico e limpeza (concluídos)
- `scripts/diagnosticar-producao-recorrencia.js` (só leitura) confirmou o alcance: 2 cobranças criadas "hoje" + os 29 pares fantasma no total.
- `scripts/limpar-recorrencia-duplicada-producao.js --aplicar` apagou 28 das 29 (as que batiam matrícula+vencimento com uma `legado` já existente e estavam `pendente` — nunca mexe em conta paga/atrasada/cancelada).
- `scripts/apagar-cobranca-fantasma-boot.js --aplicar` apagou a última (caso da Maria clara, identificado por combinação exata de campos, só aplica se encontrar exatamente 1 linha correspondente).
- Confirmado pelo usuário ("feito") que a limpeza foi aplicada. **Não foi feita uma reconferência final read-only depois da limpeza** — se quiser 100% de certeza, rodar `node scripts/diagnosticar-producao-recorrencia.js` de novo (contra produção, via `rodar-producao.ps1`) e checar que os grupos duplicados relacionados a este incidente específico não aparecem mais.

### Correção estrutural: `.env` agora tem local.db como padrão
Pra isso nunca mais acontecer, o padrão foi invertido:
- **Antes**: `npm start`/`npm run dev` comuns caíam na produção; só caía no `local.db` usando um script especial (`rodar-local.ps1`).
- **Agora**: `npm start`/`npm run dev` comuns caem no `local.db` por padrão. Pra conectar este PC na produção de propósito (raro — só pra tarefas administrativas pontuais, tipo aplicar a migração de verdade quando for a hora), existe `scripts/rodar-producao.ps1`, que pede uma confirmação digitada ("SIM") antes de conectar e mostra um aviso bem visível em vermelho o tempo todo que ficar rodando.

**Por que isso é seguro e não afeta o funcionamento real da academia**: o site publicado (Northflank, ver "Onde está publicado") não lê o `.env` deste PC — o `.env` está no `.gitignore`, nunca é enviado pro GitHub, então nunca chega no Northflank. A hospedagem tem suas próprias variáveis de ambiente configuradas direto no painel dela, já apontando pra produção, e isso não muda em nada com a edição feita aqui. Ou seja: existem 3 "modos" de rodar o sistema, totalmente isolados um do outro (cada processo do servidor só fala com UM banco por vez — nunca existe risco de um mesmo dado ser salvo nos dois ao mesmo tempo):
1. **Site publicado no Northflank** — o que a recepção/alunos usam de verdade no dia a dia. Configurado direto no painel do Northflank. Não muda com nada disto.
2. **`npm start`/`npm run dev` neste PC, sem nenhum script especial** — agora cai no `local.db` (antes caía na produção — foi essa a causa do incidente).
3. **`scripts/rodar-producao.ps1` neste PC** — conecta na produção de propósito, com confirmação, só pra uso administrativo pontual.

### O que fazer daqui pra frente
- **Pra testar/desenvolver no dia a dia**: rode `npm start` ou `npm run dev` normalmente (ou `.\rodar-local.ps1`, que faz a mesma coisa com um aviso extra na tela) — cai automaticamente no `local.db`, sem risco nenhum pra produção.
- **Pra mexer na produção de propósito** (ex.: o dia de aplicar a migração v2 de verdade, ou rodar um diagnóstico contra dados reais): use `scripts/rodar-producao.ps1` a partir da pasta `academia-gestao`, digite `SIM` quando pedir confirmação, e lembre que a partir daí QUALQUER coisa que o servidor fizer (inclusive a rotina automática de cobrança recorrente no boot) mexe em dados reais.
- **Nunca edite o `.env` na mão pra alternar entre local e produção** — os dois scripts (`rodar-local.ps1` e `rodar-producao.ps1`) já cuidam disso via variável de ambiente só daquela janela do PowerShell, sem deixar rastro nem risco de esquecer de reverter uma edição.
- **Se quiser testar localmente com dados parecidos com os reais** (não só os que já estão no `local.db` migrado): ainda não existe um script pronto pra "atualizar `local.db` com uma cópia fresca da produção" — é uma ideia levantada nesta sessão, mas não implementada. Se precisar disso no futuro, pedir pra criar um script só de leitura na produção / só escrita no `local.db` (nunca o contrário), separado dos scripts de migração.
- **Schema do `local.db` também foi corrigido nesta sessão**: estava desatualizado (faltavam as colunas de desconto em `planos` e as tabelas `treinos`/`treino_exercicios`, causando erro 500 nas abas Financeiro e Treino ao testar). Corrigido com `scripts/atualizar-schema-local.js` — idempotente, seguro rodar de novo se precisar.

### Arquivos novos/alterados desta sessão (AINDA NÃO enviados ao GitHub — são scripts administrativos, avaliar antes se todos devem ir pro repositório)
Novos: `scripts/migrar-secullum-v2.js`, `scripts/verificar-migracao.js` (correção de segurança nos dois já existentes), `scripts/zerar-dados-alunos.js`, `scripts/limpar-perguntas-duplicadas.js`, `scripts/limpar-planos-sem-secullum.js`, `scripts/mesclar-alunos-duplicados.js`, `scripts/diagnosticar-aluno.js`, `scripts/diagnosticar-producao-recorrencia.js`, `scripts/apagar-cobranca-fantasma-boot.js`, `scripts/limpar-recorrencia-duplicada-producao.js`, `scripts/atualizar-schema-local.js`, `scripts/aplicar-colunas-secullum.js`, `rodar-local.ps1`, `scripts/rodar-producao.ps1`, `remigrar-secullum.ps1` (com modo `-Auto`).
Alterados: `.env` (documentado como invertido — **conferido em 08/07/2026 à noite: a edição real ainda NÃO foi feita no arquivo**, `DATABASE_URL`/`DATABASE_AUTH_TOKEN` do Turso continuam ativos e as linhas do `local.db` continuam comentadas; ver passo a passo combinado com o usuário na conversa dessa noite).

### ⚠️ PENDÊNCIA FUTURA — atualizar a produção (Turso) com a migração v2 (ainda não é possível hoje)

Confirmado (08/07/2026, à noite) que **hoje não existe caminho pronto pra aplicar a migração v2 na produção**, mesmo depois da validação do `local.db` estar aprovada. Motivo: `scripts/migrar-secullum-v2.js` ignora de propósito o `.env`/cliente compartilhado e sempre conecta direto em `file:./local.db` (hardcoded no próprio arquivo) — foi escrito assim justamente pra nunca escrever sem querer em produção. Isso significa que `scripts/rodar-producao.ps1` **não** faz esse script mudar de banco (ele só afeta `npm start`, não `node scripts/migrar-secullum-v2.js` rodado direto).

Antes de aplicar essa migração na produção de verdade, falta:
1. Terminar a validação do `local.db` (pendência #1 de "ESTADO ATUAL").
2. Adaptar `migrar-secullum-v2.js` (ou criar uma variante) pra aceitar produção deliberadamente — ler `DATABASE_URL`/`DATABASE_AUTH_TOKEN` do ambiente (como o `rodar-producao.ps1` já faz pra `npm start`) em vez de fixar `local.db` no código.
3. Ter um jeito de backup real do Turso antes de rodar (hoje só existe backup de arquivo local — `local.db` —, Turso é remoto; precisa de algo tipo `turso db dump` ou export via Shell do Northflank).
4. Rodar primeiro em `--dry-run` contra produção, revisar o relatório com calma, só então aplicar.
5. Lembrar que `zerar-dados-alunos.js` (parte do fluxo `remigrar-secullum.ps1`) **apaga todos os dados de aluno antes de remigrar** — é destrutivo por natureza; rodar isso contra produção exige acompanhamento humano direto a cada passo, não é tarefa pra delegar/automatizar sem supervisão.

**Não iniciar nenhum desses passos sem decisão e presença explícita do usuário.**

---

## Sessão 07/07/2026 (tarde) — interferência na catraca, biometria e cobranças duplicadas

**Contexto**: a academia usa DOIS sistemas na mesma catraca Henry — o Secullum (antigo, biometria própria) e o academia-gestao (novo). O usuário relatou que, depois de ativar um recurso pra mostrar leituras de biometria no "Acessos recentes", o Secullum passou a acusar "biometria não localizada".

### Causa raiz e correção
- `agente-local/agente.js` tem um recurso experimental (`BIOMETRIA_CATRACA_ATIVA`) que escuta os eventos de biometria da própria catraca. Ele ESTAVA ativo (`true`) e, quando o academia-gestao não reconhecia o `biometria_id` (100% dos casos — nenhum aluno tinha isso cadastrado ainda), mandava `impedir_entrada` de volta pra catraca — bloqueando ativamente gente que a catraca já tinha reconhecido, e disputando a conexão TCP com o Secullum.
- **Corrigido**: `loopBiometria()` agora é *fail-open* (nunca mais bloqueia por falta de reconhecimento, só registra). `BIOMETRIA_CATRACA_ATIVA` foi posto em `false` no `.env` do agente e o processo reiniciado — confirmado sem a linha "Escuta de biometria" no log.

### Importação do vínculo biometria_id → aluno
- Novo script `scripts/importar-biometria-catraca.js`, lê `scripts/data/cartao.txt` (export bruto da catraca, protocolo Henry: identificador + nome truncado em 20 caracteres) e casa por nome com os alunos do banco.
- Dry-run revisado: 1181 vínculos confiáveis, 30 ambíguos (nome bate com mais de 1 aluno), 31 sem correspondência (maioria cartão de teste/admin). **Falta confirmar se `--aplicar` já rodou.**

### Cobranças duplicadas
- **Julho/2026 (resolvido)**: 7 alunos tinham a mensalidade de julho contada duas vezes — uma cópia `legado` (da migração do Secullum) e outra `recorrencia` (gerada pelo academia-gestao). Duas estavam `atrasado`, bloqueando acesso à toa. Removidas as cópias `legado` (`scripts/limpar-legado-vs-recorrencia.js --aplicar`), mantendo sempre a `recorrencia`.
- **Proteção nova contra repetição**: índice único `idx_cobrancas_recorrencia_matricula_vencimento` no `schema.sql` + `INSERT OR IGNORE` em `cobrancas.service.js` — protege contra o servidor gerar a mesma mensalidade duas vezes se dois reinícios muito próximos (redeploy, crash-loop) se sobrepuserem. **Falta rodar `node src/db/migrate.js` pra criar esse índice** (falhou por timeout de rede na última tentativa).
- **Histórico antigo (2021–2025), NÃO aplicado ainda**: 32 grupos (33 linhas) de cobranças `legado` duplicadas — parecem já vir duplicadas do próprio Secullum, não bug da migração. Diagnóstico em `scripts/diagnosticar-duplicatas-migracao.js`, limpeza pronta em `scripts/limpar-duplicatas-migracao.js`, dry-run revisado, falta decidir se aplica.

### Achado colateral: contas de ALUNO duplicadas (não cobrança)
- Nos 30 "ambíguos" da importação de biometria, vários batem o **mesmo CPF** em dois `aluno_id` diferentes (ex.: Iago Fernando Rodrigues Gomes, José Rivandro Kauan Ramalho Cabral, Rikely Carla Gomes Marcelino). São cadastros de aluno genuinamente duplicados — precisa de um script de fusão (migrar matrícula/cobrança/histórico pro que fica, só depois apagar o duplicado) antes de decidir o vínculo de biometria desses 30 casos. **Não iniciado.**

### Arquivos novos/alterados desta sessão de tarde (AINDA NÃO enviados ao GitHub)
Novos: `scripts/importar-biometria-catraca.js`, `scripts/diagnosticar-duplicatas-migracao.js`, `scripts/limpar-duplicatas-migracao.js`, `scripts/diagnosticar-duplicatas-mes.js`, `scripts/diagnosticar-legado-vs-recorrencia.js`, `scripts/limpar-legado-vs-recorrencia.js`.
Modificados: `agente-local/agente.js`, `src/db/schema.sql` (índice novo), `src/services/cobrancas.service.js` (INSERT OR IGNORE), `package.json` (script `importar-biometria`).

---

## ✅ CONCLUÍDO E ENVIADO — correções de segurança (sessão 07/07/2026, manhã)

Uma análise de segurança (`analise-seguranca-academia-gestao.md`, na raiz do repo junto com este arquivo) apontou 2 falhas críticas, 3 altas e 4 médias. Todas as que não tiravam funcionalidade foram corrigidas e **enviadas via `git push`** — já estão em produção. `JWT_SECRET` e `CADASTRO_PUBLICO_TOKEN` foram configurados no Northflank. Único ponto ainda não 100% confirmado: se as variáveis antigas da InfinitePay (`PAYMENT_PROVIDER`, `INFINITEPAY_HANDLE`, `INFINITEPAY_WEBHOOK_URL`) foram removidas do Northflank, e se `MERCADOPAGO_WEBHOOK_SECRET` lá bate com o painel do Mercado Pago.

### O que foi corrigido

1. **InfinitePay removida por completo** — o webhook dela (`POST /webhook/infinitepay`) confiava cegamente no `order_nsu` do corpo da requisição pra marcar cobranças como pagas, sem checar nada — qualquer aluno podia forjar essa chamada e "pagar" a própria mensalidade de graça. Como o provedor não estava em uso, a integração inteira foi removida (rotas, serviço, seletor no painel) em vez de corrigida.
2. **Webhook do Mercado Pago agora valida a assinatura** (`x-signature`) usando `MERCADOPAGO_WEBHOOK_SECRET` — que, pelas notas desta sessão anterior, já está configurado no Northflank. Se estiver mesmo, a validação já vale a partir do próximo deploy.
3. **`JWT_SECRET` sem valor padrão no código** — antes, se a variável de ambiente falhasse por qualquer motivo, o servidor assinava tokens com um segredo previsível fixo no código-fonte. Agora o servidor recusa subir sem `JWT_SECRET` definido. O valor local (`.env` deste PC) foi trocado; **o valor no Northflank continua sendo o antigo placeholder público (`troque-este-segredo-em-producao`) e precisa ser trocado lá também** — é a correção mais urgente de todas (quem tiver visto o repositório sabe esse valor e pode forjar login de admin).
4. **Rate limiting** adicionado (implementação própria, sem pacote novo, já que não há acesso a `npm install` neste ambiente) no login, no portal remoto (`/api/portal/*`) e nas rotas do totem/celular (`/api/terminal/*`).
5. **Segredo novo e separado para a página de cadastro pelo celular**: `cadastro-mobile.js` (a página aberta via QR "Usar seu cel" no totem) usava o mesmo `TERMINAL_TOKEN` do totem físico — só que, diferente do totem, essa página é entregue a qualquer visitante que escaneie o QR, então esse token ficava bem mais exposto (e ele também protege a abertura da catraca). Criada uma variável nova, `CADASTRO_PUBLICO_TOKEN`, com acesso restrito só às rotas de auto-cadastro — **precisa ser criada no Northflank também, senão a opção "Usar seu cel" quebra em produção** (dá erro 500 "não configurado no servidor").
6. **Sobrescrita de reconhecimento facial por CPF** (`/vincular/facial`, no portal e no totem): quem soubesse o CPF de um aluno conseguia vincular o PRÓPRIO rosto ao cadastro dele, sem confirmação — um jeito de entrar na academia se passando por outra pessoa. Mitigado primeiro com rate limiting agressivo por CPF (5 tentativas/hora) e auditoria; **decisão do usuário (07/07/2026): bloquear por completo** — agora, se o aluno já tem um rosto cadastrado, o portal e o totem/celular recusam (409 "procure a recepção") em vez de sobrescrever. Trocar um rosto já existente passa a exigir a recepção (painel → perfil do aluno → aba "Biometria & acesso" → remover e recadastrar pela câmera do PC). Não afeta o primeiro cadastro (totem, celular ou portal) nem o cadastro facial logo após um auto-cadastro — só bloqueia quando JÁ existe um rosto salvo.
7. Headers de segurança HTTP (sem CSP — quebraria o CSS inline das páginas), CORS restringível por `CORS_ORIGIN` (aberto por padrão até essa variável ser definida), comparação do `TERMINAL_TOKEN` em tempo constante, e a distância/limite do reconhecimento facial deixam de aparecer na resposta da API quando `NODE_ENV=production`.
8. **Script pra trocar a senha do admin** (`scripts/trocar-senha-admin.js`) — **já rodado**, senha padrão `admin123` não vale mais.

### Arquivos alterados/criados nesta sessão (já enviados ao GitHub)

Modificados: `src/routes/pagamentos.routes.js`, `src/routes/terminal.routes.js`, `src/routes/portal.routes.js`, `src/routes/auth.routes.js`, `src/middleware/auth.js`, `src/utils/jwt.js`, `src/server.js`, `public/app.js`, `public/index.html`, `public/terminal.js`, `public/terminal.html`, `public/cadastro-mobile.js`, `public/cadastro-mobile.html`, `.env.example`, `render.yaml`, `README.md`, `package.json`, `src/db/schema.sql` (só comentário).

Novos: `src/middleware/rateLimit.js`, `scripts/trocar-senha-admin.js`.

Neutralizado (não apaga sozinho — apague manualmente): `src/services/payment/infinitepay.service.js` virou um stub vazio comentado, porque este ambiente não tem uma ferramenta de exclusão de arquivo. Pode ser apagado com segurança.

### Variáveis de ambiente novas/alteradas a configurar no Northflank

- `JWT_SECRET` — **trocar pelo valor novo** (gerar com algo como `openssl rand -hex 64`; não usar o mesmo valor que ficou no `.env` local deste PC, gere um diferente pra produção). Login de todos os admins vai pedir senha de novo depois dessa troca — esperado.
- `CADASTRO_PUBLICO_TOKEN` — **variável nova**, precisa ser criada (string longa aleatória, diferente do `TERMINAL_TOKEN`) e o mesmo valor colado em `public/cadastro-mobile.js` antes do upload.
- `MERCADOPAGO_WEBHOOK_SECRET` — confirmar que o valor no Northflank é o mesmo que está configurado no painel de Webhooks do Mercado Pago (a sessão anterior registrou como "configurado", mas vale confirmar já que agora ele passou a ser realmente usado pelo código).
- `CORS_ORIGIN` — opcional, deixar em branco (comportamento não muda).
- Remover (não são mais usadas): `PAYMENT_PROVIDER`, `INFINITEPAY_HANDLE`, `INFINITEPAY_WEBHOOK_URL`.

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
- Recurso opcional de biometria própria da catraca (`BIOMETRIA_CATRACA_ATIVA`): chegou a ser ativado numa sessão seguinte e causou problemas reais (ver seção "Sessão 07/07/2026 (tarde)" acima — bloqueava alunos e atrapalhava o Secullum). Corrigido (fail-open) e posto de volta em `false` por enquanto. Só reativar depois das pendências listadas em "ESTADO ATUAL".

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

(`PAYMENT_PROVIDER` e as variáveis da InfinitePay foram removidas do código; `JWT_SECRET` e `CADASTRO_PUBLICO_TOKEN` já foram configuradas no Northflank — ver "ESTADO ATUAL" no topo do arquivo.)

- `MERCADOPAGO_ACCESS_TOKEN` — token de PRODUÇÃO (`APP_USR-...`); API de Orders não aceita token de teste.
- `MERCADOPAGO_WEBHOOK_SECRET` — configurado; agora efetivamente usado (validação de assinatura do webhook).
- `MERCADOPAGO_TEST_PAYER_EMAIL` — não usar (deixar apagado).
- `TERMINAL_TOKEN` — segredo do totem. **Trocado nesta sessão** (o valor antigo hardcoded em `terminal.js` foi substituído por um novo, sincronizado entre `academia-gestao/.env`, `public/terminal.js` e `agente-local/.env`). Confirme que o Northflank também tem esse mesmo valor novo — senão o totem para de autenticar.
- `HENRY_CATRACA_IP=192.168.0.79` / `HENRY_CATRACA_PORT=3000` — IP/porta padrão da catraca.
- `AGENTE_TOKEN` — segredo compartilhado entre o servidor e `agente-local/`; **configurado e validado** nos 3 lugares (Northflank, `.env` local, `agente-local/.env`).
- `DATABASE_URL` / `DATABASE_AUTH_TOKEN` — Turso. Local usa SQLite em arquivo (`file:./local.db`) por padrão; produção (Northflank) usa Turso — **migração já rodada em produção** via Shell do Northflank.

## Pendências

**A lista que vale é a de "ESTADO ATUAL" no topo do arquivo** (as 4 pendências reais de agora). Itens mais antigos, de menor prioridade, ainda em aberto:

1. Testar a liberação de acesso via agente contra mais cenários reais de uso (dias/horários variados, quedas de internet do PC do agente).
2. Se quiser reativar simulação de pagamento de teste no futuro, investigar mais a fundo com o suporte do Mercado Pago (duas tentativas anteriores não funcionaram).
3. Confirmar remoção das variáveis antigas da InfinitePay no Northflank e conferência do `MERCADOPAGO_WEBHOOK_SECRET` (ver "ESTADO ATUAL").

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
- **Deploy mudou de upload manual pra `git push origin main`** numa sessão posterior às citadas acima — os comentários antigos sobre "conferir upload completo" valem historicamente, mas hoje o fluxo é `git add` / `git commit` / `git push`, e vale conferir `git status` antes de considerar terminado.
- Um campo `required` do HTML escondido (`display:none`) num bloco condicional, com o botão de submit do mesmo `<form>` visível em outro lugar, faz o Chrome bloquear o envio silenciosamente — validar manualmente em JS campos que podem ficar escondidos condicionalmente.
- `z-index` do toast precisa ser maior que o de modais/painéis.
- **Nunca deixe `npm start`/`npm run dev` locais apontarem pra produção por padrão** (ver "Sessão 08/07/2026" acima) — rodar o servidor "só pra testar" gerou 29 cobranças fantasma reais porque o `.env` tinha a produção como padrão silencioso. Regra atual: local é o padrão, produção só via script que pede confirmação explícita (`scripts/rodar-producao.ps1`).
- **Qualquer script administrativo que mexe em dado real precisa declarar explicitamente qual banco usa** — os bugs mais perigosos desta sessão vieram de scripts que usavam `require('../src/db/client')` (lê `.env`, então segue o que estiver configurado ali) quando a intenção era só mexer no `local.db` de teste. Scripts de teste local devem sempre usar `createClient({ url: 'file:./local.db' })` fixo no código, nunca o cliente compartilhado — só scripts deliberadamente marcados como "isto mexe em produção" devem usar o cliente compartilhado.
- **Schema desatualizado em `local.db` só aparece quando a rota é exercitada de verdade**: `CREATE TABLE IF NOT EXISTS` (schema.sql) não adiciona coluna em tabela já existente nem recria tabela que já existe — bancos de teste antigos ficam pra trás silenciosamente até alguém clicar na tela certa e tomar 500. Ao trocar `schema.sql`, sempre atualizar também um script `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` idempotente pros bancos que já existem (ver `scripts/aplicar-colunas-secullum.js` e `scripts/atualizar-schema-local.js` como modelo).
