# Status do projeto — Academia Superação (academia-gestao)

Última atualização: 18/07/2026. **Leia só a seção "ESTADO ATUAL" abaixo pra retomar o trabalho** — o resto do arquivo é histórico de sessões passadas, mantido como referência de "por que as coisas são como são".

> **Nota sobre este arquivo (18/07/2026)**: este arquivo foi reconstruído do zero nesta data porque a cópia anterior, lida pela ponte remota, estava travada em 08/07/2026 — faltavam TODAS as sessões feitas entre 08/07 e 15/07 (arquitetura Turso-único, correções da catraca, painel do agente, protocolo HTTP reverse-engineered, etc.). O conteúdo perdido foi recuperado porque o usuário tinha o histórico completo salvo em outro lugar e colou de volta nesta sessão. **Combinado com o usuário: este arquivo deve ser mantido sempre atualizado a partir de agora**, pra esse tipo de perda não se repetir. Prática adotada: ao final de cada sessão de trabalho relevante, atualizar a seção "ESTADO ATUAL" e a seção da sessão do dia, entregar via `SendUserFile` + gravar via `device_commit_files`, e conferir que a resposta veio com `"rejected":[]`. Se em algum momento futuro este arquivo for lido e parecer desatualizado/incompleto (data antiga demais, faltando uma sessão que você lembra ter acontecido), **desconfie da leitura antes de confiar nela** — peça pro usuário conferir o arquivo de verdade no PC dele antes de qualquer edição.

## ESTADO ATUAL (comece por aqui)

**Arquitetura de dados (desde 11-14/07/2026, ver detalhe no item 1 abaixo)**: Turso (nuvem) é a ÚNICA fonte de verdade — cadastro, planos, cobranças e decisão de acesso. Tanto o processo da nuvem (Northflank) quanto o processo local da academia (`academia-gestao-totem`) apontam pro MESMO Turso. O `local.db` não é mais um banco separado de teste — é só um cache/fallback, sincronizado periodicamente (~12 min), usado automaticamente apenas quando o Turso não responde. **Não existe mais "ambiente local seguro pra testar"**: qualquer ação (inclusive testes) feita pelo painel, seja via `localhost:3000` ou pelo endereço da nuvem, mexe no mesmo dado real. Pra testar algo novo com baixo risco, use dado de teste (ex.: o cadastro "Academia superação", `biometria_id: 115`, já usado pra testes da catraca) em vez de contar com "estar local" como proteção.

**Pendências reais agora, por item (ver detalhamento completo mais abaixo):**

1. ✅ Arquitetura "tudo no Turso" — implementada e testada, inclusive queda de internet simulada. Sem pendência.
2. Duplicatas dos planos — adiado por pedido do usuário, sem novidade.
3. ⏸️ Webcam USB do totem — pausada/revertida (problema de energia física, precisa de hub USB alimentado pra retomar). Totem voltando a usar a câmera embutida normalmente.
4. ✅ Lote de 6 pedidos (terminal online, navegação do portal, aviso de vencimento, matrículas pendentes, totais em contas a receber, botão limpar busca) — implementado. Falta confirmar `pm2 restart` + `git push` se ainda não foi feito.
5. Totem — trocar `SENHA_DESTRAVAR_QUIOSQUE` (hoje `'academia2026'`, fixa no código) por uma senha real em `public/terminal.js`.
6. Aviso sonoro do totem — implementado, falta confirmar reload da tela de Configurações + `pm2 restart academia-gestao-totem`.
7. Portal remoto com senha (CPF + código) — implementado e migração já rodada em produção; falta confirmar o `git push` mais recente.
8. Cartão automático na catraca — parcialmente resolvido pelo item 15 (protocolo HTTP descoberto), mas ainda sem código escrito; aguardando fechar a dúvida do `lblId` de atualização.
9. ✅ Incidente de conexão do agente + painel de controle na bandeja — resolvido e implementado. Falta só: confirmar botão "Visualizar acessos", criar atalho na Área de Trabalho manualmente, `pm2 save` se ainda não rodou.
10. Janelas flutuantes redimensionáveis + filtro "1º acesso do dia" — implementado, falta `pm2 restart` + `git push` e confirmação visual do usuário.
11. ✅ Catraca não liberava pra Maria Fagna (nome longo) — resolvido e confirmado ao vivo (15/07). Sem pendência.
12. ✅ Nome do aluno nas pendências de sincronização — implementado, falta `pm2 restart` + `git push`.
13. ✅ Bloqueio ativo de inadimplente na catraca (biometria direta) — resolvido e confirmado ao vivo, inclusive durante queda de internet simulada. `BLOQUEIO_ATIVO_CATRACA=true` já ativo em produção. Sem pendência, só ficar de olho se o PM2 volta a ficar "fantasma".
14. ✅ Guia de comandos — criado como artefato persistido no Cowork (`comandos-academia`). Atualizar conforme surgem novos fluxos.
15. 🔎 Protocolo HTTP/administrativo da catraca (criar/editar cartão, capturar biometria remotamente) — em investigação, bem avançado; falta 1 teste final pelo navegador (mudar "Nível de controle" do cartão de teste e capturar a requisição) pra confirmar o `lblId` de atualização (`1258`, quase certo) antes de escrever qualquer código.
16. ✅ "Localhost não abre" (PM2 não subia sozinho) — causa raiz corrigida no `abrir-sistemas.bat` (agora sobe os processos PM2 sozinho antes de abrir o navegador). Falta testar ao vivo e considerar `pm2-windows-startup`/Tarefa Agendada pra sobreviver a reinícios do Windows.
17. **Nova feature 18/07/2026 — "Recuperação de Clientes" (evasão/retenção)**: código escrito e gravado no projeto, AINDA NÃO instalado/migrado/testado/enviado ao GitHub. Ver seção própria abaixo pro passo a passo. Como agora não existe mais "ambiente local seguro", os testes devem ser feitos com dado de baixo risco (mandar mensagem de teste pra você mesmo, conceder acesso especial só pro cadastro de teste), não mais "testar local depois produção".

## Onde está publicado

- App: `https://academia--acess--tpff5w2s24vs.code.run`
- Totem: `https://academia--acess--tpff5w2s24vs.code.run/terminal.html` (mas o TABLET físico do totem deve apontar pro endereço LOCAL do PC da recepção, ex.: `http://192.168.0.2:3000/terminal.html` — nunca pro endereço da nuvem, ver item 1 abaixo)
- Painel admin: mesmo endereço do App (login: e-mail cadastrado do admin)
- Repositório: GitHub `treinopro/acess`, branch `main` — **deploy via `git push origin main`**, o Northflank redeploya sozinho
- Hospedagem: Northflank (Buildpack, porta pública 8080), projeto `acess-academia` / time `acessfits-team`
- Banco de dados: Turso (libSQL) — única fonte de verdade, usada tanto pela nuvem quanto pelo processo local `academia-gestao-totem`. `local.db` é só cache/fallback (ver item 1).
- PC da academia (recepção): roda só o processo PM2 `academia-gestao-totem` (NUNCA junto com `academia-gestao-local` — os dois brigam pela porta 3000) + `catraca-agente` (fala com a catraca Henry em `192.168.0.79:3000`). Subir tudo com `abrir-sistemas.bat` (self-healing desde o item 16) ou manualmente via PM2 — ver "Guia de comandos" (artefato persistido no Cowork, item 14).

---

## Sessão 18/07/2026 — Recuperação de Clientes (evasão/retenção)

Feature nova, do zero: lista de alunos que pararam de aparecer, aniversariantes do mês, envio de mensagem (e-mail real ou link do WhatsApp manual) e concessão opcional de acesso especial/gratuito. Todo o código foi escrito e gravado nas pastas do projeto neste PC — **falta rodar os passos pendentes abaixo antes de usar**.

### O que foi construído

**Banco de dados** (`src/db/schema.sql`, 3 tabelas novas, `CREATE TABLE IF NOT EXISTS` — seguras rodar de novo):
- `mensagens_templates` — modelos reutilizáveis de mensagem (saudação, corpo, tipo de link, se concede dias grátis).
- `concessoes_acesso` — concessões de acesso especial/gratuito (aluno, dias, validade, motivo, quem concedeu). Não mexe em nenhuma cobrança real.
- `mensagens_enviadas` — histórico de tudo que foi enviado/gerado (e-mail ou link de WhatsApp), pra nunca reenviar sem querer.

**Backend novo**:
- `src/services/email.service.js` — envio de e-mail via Gmail SMTP + Senha de App (`nodemailer`), lê `GMAIL_USER`/`GMAIL_APP_PASSWORD`/`GMAIL_FROM_NOME` do ambiente. Se não configurado, dá erro claro (não trava o resto do sistema).
- `src/routes/recuperacao.routes.js` (novo, montado em `/api/recuperacao`, admin-only) — endpoints: `GET /dias-sem-acesso` (lista com dias sem aparecer, mesmo quem nunca acessou), `GET /aniversariantes` (mês/dia), CRUD de `/templates`, `POST /enviar` (e-mail ou WhatsApp, em lote), `POST /conceder-acesso` (avulso), `GET /concessoes`, `GET /historico`, `GET /status` (se e-mail está configurado).
- `src/services/acessoTerminal.service.js` — **alterado com cuidado**: `verificarAutorizacaoAluno` e `listarAutorizacoesBiometricas` agora checam `concessoes_acesso` antes de bloquear por inadimplência. Regra explícita: uma concessão ativa **só contorna bloqueio por mensalidade em atraso** (status `inadimplente` ou cobrança vencida) — cadastro **trancado ou inativo continua bloqueando igual antes**, porque isso é decisão manual do admin, não relacionada a pagamento. "5 dias grátis" nunca reabre sozinho um cadastro que foi trancado de propósito.

**Frontend novo** (`public/index.html` + `public/app.js` + `public/style.css`), menu "Recuperação de Clientes" (visível só pra admin, igual Usuários/Configurações/Catraca):
- Aba **Dias sem acesso**: lista com dias sem aparecer, destaque laranja pra quem também está em atraso (mesmo critério visual de "Contas em atraso"), seleção múltipla, botão "Enviar mensagem" por linha ou em lote, botão "Conceder acesso" avulso (com confirmação e prompt de quantos dias).
- Aba **Aniversariantes**: seletor de mês, calendário visual (dias com aniversariante destacados, clicável pra filtrar), lista, seleção múltipla + envio em lote. Aviso "🎂 aniversariante(s) hoje" aparece no topo da seção e como toast logo após o login do admin.
- Aba **Modelos de mensagem**: CRUD de templates (nome, saudação com `{nome}`, corpo, tipo de link — acesso do aluno / oferta personalizada / sem link —, e opção "concede N dias grátis" por modelo).
- Aba **Histórico**: tudo que foi enviado/gerado, filtrável por aluno/canal.
- Composer de envio (modal): escolhe canal (WhatsApp sempre manual — só gera o link `wa.me`, o admin clica e confirma o envio ele mesmo; e-mail de verdade via SMTP), modelo opcional, prévia da mensagem, e checkbox "conceder acesso especial" com confirmação explícita antes de liberar.

### Decisões tomadas com o usuário nesta sessão
- **E-mail**: Gmail SMTP com Senha de App (reaproveitando `academiasuperacao01@gmail.com`), não um provedor transacional separado — o usuário coloca `GMAIL_USER`/`GMAIL_APP_PASSWORD` no `.env`/Northflank.
- **WhatsApp**: sempre manual, sem nenhum disparo automático — o sistema só gera o link pronto (`wa.me/...?text=...`), o admin clica e confirma o envio de verdade no WhatsApp dele.
- **Acesso especial**: desligado por padrão, só ativa quando o admin marca a caixa "Conceder acesso especial" no composer (ou usa o botão avulso "Conceder acesso"), com confirmação explícita mostrando quantos dias e quantos alunos antes de liberar.

### Passos pendentes antes de usar (nesta ordem)

1. **`npm install`** na pasta do projeto — `nodemailer` foi adicionado ao `package.json` mas ainda não está instalado no `node_modules` deste PC.
2. **`node src/db/migrate.js`** — cria as 3 tabelas novas. **Importante, dado a arquitetura atual (item 1)**: isso vai direto pro Turso (produção), porque não existe mais banco local separado — é o que precisa acontecer mesmo, já que Turso é a única fonte de verdade tanto pra nuvem quanto pro processo local.
3. **Configurar o e-mail**: gerar uma Senha de App em `myaccount.google.com/apppasswords` pra `academiasuperacao01@gmail.com` (exige verificação em duas etapas ativada na conta) e colocar `GMAIL_USER`/`GMAIL_APP_PASSWORD` no `.env` local e nas variáveis de ambiente do Northflank (produção). Sem isso, o canal "E-mail" fica desabilitado no composer (mas o WhatsApp manual funciona normalmente, não depende disso).
4. **Testar com dado de baixo risco** (não existe mais "ambiente seguro" — ver ESTADO ATUAL): mandar uma mensagem de teste pro próprio WhatsApp/e-mail do usuário, conceder um acesso especial de teste só no cadastro "Academia superação" (`biometria_id: 115`, já usado pros testes da catraca) e conferir que aparece em "Histórico".
5. `git add` / `git commit` / `git push origin main` (deploy automático no Northflank) e configurar `GMAIL_USER`/`GMAIL_APP_PASSWORD`/`APP_URL` nas variáveis de ambiente do Northflank também.

### Sugestões pra evoluir depois (não implementadas ainda)
- Disparo automático (ex.: e-mail sozinho pra quem completa 30 dias sem acesso) — hoje é 100% manual de propósito, por decisão do usuário nesta sessão; dá pra automatizar depois com um job agendado parecido com o de cobranças vencidas.
- Métricas de reengajamento: quantos dos que receberam mensagem voltaram a acessar em X dias — dá pra cruzar `mensagens_enviadas` com `acessos_catraca` depois que houver volume de dados real.
- SMS como canal adicional (hoje só e-mail e WhatsApp manual).
- Segmentação automática por "tempo de casa"/plano, pra personalizar a oferta de recuperação.

---

## Detalhamento completo — sessões de 11 a 15/07/2026

### 1. Biometria/facial/cadastros divididos entre local e online — RESOLVIDO: tudo agora no Turso, offline só de backup/fallback

**Decisão final do usuário (11/07/2026).** Depois de o risco do fix simples original ter sido levantado, o usuário definiu a arquitetura definitiva, bem mais ampla do que só "replicar acessos":

> "coloque tudo no online, absolutamente tudo e deixe que o offline se alimente do banco online tambem [...] concentre tudo no online e o banco offline deve servir apenas de backup, sendo atualizado periodicamente das mudanças que forem feitas no online [...] quando eu precisa consultar alguma condiçao de cadastro puxa essas informações apenas de um banco o online, em caso de queda de internet, poderia usar o banco offline como uma segunda alternativa [...] quando acontecer esses eventos de falta de conexão com a internet o sistema offline deve continuar funcionando com as informaçoes que tem naquele momento e atualizar atraves de fila assim que a internet voltar."

Resumo do que foi acordado e implementado:
- Turso é a única fonte de verdade para cadastro de alunos, planos, cobranças e decisão de acesso (facial/QR/CPF/biometria). O `local.db` não é mais um banco "de verdade" — é só um espelho/cache.
- Cadastro e vinculação de rosto NUNCA usam fallback — se o Turso não responder, a operação falha mesmo (decisão do usuário: não faz sentido cadastrar contra um cache desatualizado).
- Decisão de acesso (aluno já identificado, entrando pela catraca) usa fallback pro `local.db` só quando o Turso não responder — risco aceito explicitamente: "em uma eventualidade o cliente acessar a catraca mesmo que o status dele não permita, não me traz tanto prejuízo".
- Registro do acesso em si: tenta gravar no Turso; se falhar, entra numa fila local (`.jsonl`) e é reenviado sozinho assim que o Turso voltar.
- Sincronização periódica Turso → `local.db` (a cada ~12 min) mantém o cache atualizado pras consultas de fallback.
- Zero mudança de comportamento na produção atual da nuvem — tudo isso só liga através de um novo processo dedicado ("modo totem"), com o processo de produção existente seguindo exatamente como está hoje.
- Alerta visível no console quando o Turso falhar (e quando se recuperar).
- Consultas de cadastro (ver aluno, buscar) também caem pro cache local durante queda de internet.
- Edições de cadastro e pagamentos feitos offline entram numa fila com REGRA DE CONFLITO: ao sincronizar, se o valor no Turso mudou por outro caminho enquanto a academia estava offline (ex.: pagamento via Mercado Pago), a pendência NUNCA é aplicada sozinha — fica esperando o admin decidir no painel.
- Geração de mensalidades recorrentes deixou de ser automática — só roda quando o admin clica "Gerar Contas a Receber" no painel, escolhendo o período.

**O endereço do totem.** O totem (tablet na recepção) deve apontar pro endereço LOCAL do PC que roda `academia-gestao-totem` (ex.: `http://192.168.0.2:3000/terminal.html`), NÃO pro endereço da nuvem — se o tablet estiver configurado com o endereço da nuvem e a internet cair, a requisição nem sai do prédio, nenhuma lógica de fallback tem chance de rodar. O painel administrativo (uso do dia a dia, inclusive de fora da academia) continua no endereço da nuvem — `192.168.0.2` só é alcançável de dentro da rede Wi-Fi da academia.

**Arquivos novos/alterados** (primeira leva — arquitetura base): `src/db/clientOffline.js`, `src/services/dbResiliente.service.js` (`comFallback`), `src/services/filaAcessosOffline.service.js`, `src/jobs/syncOfflineCache.js` (sincroniza `planos`/`alunos`/`matriculas`/`cobrancas`/`pagamentos_cobranca` do Turso pro `local.db` a cada `SYNC_OFFLINE_INTERVALO_MS`, padrão 12 min — faz `SELECT *` dinâmico, então toda coluna nova em `alunos` precisa existir também no `local.db`, ver `scripts/atualizar-schema-local.js`), `src/services/acessoTerminal.service.js` (variantes `ParaAcesso` fallback-aware, separadas do cadastro/vinculação só-Turso), `src/routes/terminal.routes.js`, `ecosystem.config.js` (novo app PM2 `academia-gestao-totem`, com `EXECUTAR_JOBS_AGENDADOS=false` e `MODO_TOTEM_OFFLINE=true`).

**Segunda leva** (consulta/edição de cadastro offline + recorrência manual): `src/services/filaCadastroOffline.service.js` (fila `fila-cadastro-totem.jsonl` com regra de conflito — relê o Turso na hora de sincronizar e só aplica sozinho se nada mudou por outro caminho), `src/routes/alunos.routes.js` (`GET /`, `/:id`, `/:id/perfil` caem pro `local.db` offline; `PUT`/`PATCH status` enfileiram; novas rotas `GET /pendencias-sincronizacao` e `POST /pendencias-sincronizacao/:id/resolver`), `src/routes/pagamentos.routes.js` (pagamento enfileira offline, usando status da conta como campo-guarda de conflito), `src/services/cobrancas.service.js` (`gerarCobrancasRecorrentes({ ateData })` gera todos os ciclos faltantes até a data, sem duplicar), `src/server.js` (recorrência automática REMOVIDA de vez, em todo processo; flush automático da fila de cadastro a cada 30s), `public/index.html`/`app.js` (seletor de mês no botão "Gerar Contas a Receber"; seção "Pendências de sincronização" em Configurações).

**Limitações conhecidas desta versão**: só `PUT /api/alunos/:id`, `PATCH /api/alunos/:id/status` e `POST /pagamentos/cobrancas/:id/pagamentos` têm fila/conflito — outras edições (anamnese, avaliações, parcelamento, valor de conta, importação CSV, planos) exigem Turso disponível, falham direto numa queda. `GET /api/alunos/:id/perfil` offline não mostra anamnese/avaliações/agendamentos (só aluno, matrículas, cobranças).

**Pré-requisito antes de ativar no PC do totem**: `local.db` precisa ter o schema completo — rodar `node scripts/atualizar-schema-local.js` uma vez se for a primeira vez usando esse arquivo.

**Como ativar no PC do totem**: `pm2 start ecosystem.config.js --only academia-gestao-totem` (não rodar junto com `academia-gestao-local`); apontar o navegador do tablet pro endereço local (nunca a nuvem); liberar porta 3000 no Firewall + IP fixo (DHCP reservado) no roteador.

**Como testar/confirmar**: simular queda de internet no PC do totem — acesso continua funcionando via cache, banner 🔴 aparece, acesso feito na queda entra na fila; buscar/editar aluno e lançar pagamento offline devem enfileirar ao invés de dar erro; ao reconectar — banner 🟢, fila sincroniza sozinha, conflitos aparecem em "Pendências de sincronização"; recorrência nunca roda sozinha; cadastro novo/vincular rosto com Turso indisponível deve falhar (sem fallback), como esperado.

### 2. Duplicatas dos planos — adiado por pedido do usuário

Sem mudança desde a última atualização. Continua precisando do output exato da última tentativa de rodar em produção.

### 3. Totem — webcam USB via app nativo (APK) PAUSADA/REVERTIDA; totem voltou pra câmera embutida

**Decisão final (11/07/2026)**: abandonar por enquanto a webcam USB (e o app Android nativo construído pra ela) e reverter o totem pra câmera embutida do tablet via `getUserMedia`, direto no navegador — sem APK, sem Capacitor, sem proxy.

**Por que reverter**: análise linha a linha do Logcat confirmou causa raiz física, não de software — `EventHub: Removing device ... due to epoll hang-up event` se repetia a cada ~9-30s durante o streaming; a porta USB perdia energia E dados ao mesmo tempo (desligamento físico real, ~3s de queda). A câmera (chip Jieli Technology) declara `mMaxPower=200` (~400mA), mais do que a porta USB-OTG do tablet sustenta de forma estável durante captura ativa. Sem um hub USB alimentado entre o tablet e a câmera, isso não tem solução só por software.

**O que foi revertido**: `public/terminal.js` — `USAR_WEBCAM_USB` voltou pra `false`; `public/terminal.html` — os 3 elementos de vídeo voltaram de `<img>` pra `<video autoplay muted playsinline>`. Nada foi apagado — `native-usb-webcam-bridge.js` continua incluído (inofensivo fora do Capacitor).

**O que foi ARQUIVADO** (não apagado, pronto pra retomar): pasta `totem-app-scaffold/totem-app/` completa (projeto Capacitor + `UsbWebcamPlugin.java`) em `D:\Meus documentos\Downloads\projeto acess aca\totem-app-scaffold\totem-app\`, com `README.md` atualizado ("PAUSADO" no topo). Já resolvidos e prontos pra reuso: carregamento de modelo facial (renomear shards pra `.bin` + `noCompress`), bug de cor (`PIXEL_FORMAT_YUV420SP`), crash nativo (`fecharCameraEImageReader()`), corrida de reconexão (rastreamento de `dispositivoAtualId`), mitigação de congelamento (detecção de quadro parado).

**Pendente pra retomar (se e quando)**: conseguir hub USB alimentado, testar de olho no Logcat procurando `epoll hang-up`; se estável, reativar (`USAR_WEBCAM_USB = true`, reverter `<video>` pra `<img>`).

**Pendente sem relação com a webcam**: modo kiosk completo (bloquear barra de endereço/UI do navegador) + autostart no boot — segue não feito (o que já foi implementado, trap de navegação via JS, está no item 5).

**Navegador travando durante o reconhecimento (câmera embutida) — diagnosticado e mitigado**: causa era o CUSTO do reconhecimento facial (não a câmera) — a etapa pesada (68 pontos + descritor de 128 números) rodava em sequência a cada 600ms enquanto a pessoa se posicionava. Corrigido separando a detecção barata (roda sempre) da pesada (`INTERVALO_MINIMO_RECONHECIMENTO_PESADO_MS = 1200ms` de cooldown entre tentativas pesadas), aplicado tanto no reconhecimento contínuo quanto no cadastro facial. Status: corrigido e enviado, ainda não confirmado se resolveu de vez — vale conferir no overlay de debug do totem se o TensorFlow.js está rodando em `webgl` ou caiu pra `cpu`.

### 4. Lote de 6 pedidos (terminal online, navegação, avisos e buscas) — IMPLEMENTADO (11-12/07/2026)

1. **Terminal online "bagunçado"** — causa era deploy desatualizado na nuvem (código local já tinha os fixes, faltava só `git push`). Confirmado com o usuário e resolvido só com deploy.
2. **Portal, botão "voltar" só ia pro início** — trocado por navegação "um nível de cada vez" (`portal.html`/`portal.js`): fecha só o subpainel aberto, só reseta tudo (volta a digitar CPF) se já estiver no dashboard principal.
3. **Aviso de vencimento no totem** ("faltam N dias"/"vencido há N dias", com opção de pagar) — novas funções em `acessoTerminal.service.js` (`buscarAvisoVencimentoSeguro`, nunca quebra a liberação de acesso); `tentarLiberar()` inclui `aviso_vencimento`; overlay colorido no totem (âmbar/vermelho).
4. **Matrículas "pendente" sem botão de ação** (ex.: Robson Junior Reis Lima) — condição corrigida de `status === 'ativa'` pra `(status === 'ativa' || status === 'pendente')` em dois lugares (`app.js`), com texto de confirmação diferente pro caso pendente.
5. **Contas a Receber sem totais visíveis** — `carregarContas()` agora acumula e mostra `N conta(s) — total X, pago Y`, mesmo padrão dos relatórios.
6. **Botão (x) pra limpar busca** — 5 campos de busca envolvidos em `.campo-busca-wrap` com botão `.btn-limpar-busca`, aparecendo via CSS puro (`:not(:placeholder-shown)`), sem JS pra mostrar/esconder.

### 5. Totem — tela cheia acidental + bloqueio de navegação (modo quiosque) — IMPLEMENTADO (11-12/07/2026)

- **Tela cheia acidental corrigida**: `ativarTelaCheiaNoPrimeiroToque()` ignora cliques em campos de formulário e toques com mais de um dedo.
- **Bloqueio de voltar/trocar página**: armadilha via History API (reempurra o estado ao tentar voltar) + bloqueio de atalhos de teclado que navegariam pra trás.
- **Destravamento**: no tablet, tocar com DOIS dedos abre overlay pedindo senha; no notebook, `Ctrl+Shift+L` abre o mesmo overlay SEM pedir senha. Senha atual fixa no código: `const SENHA_DESTRAVAR_QUIOSQUE = 'academia2026';` — **⚠️ PENDENTE**: trocar por uma senha real antes de usar em produção, ainda não confirmado se foi trocada.
- **Limitação documentada**: isso NÃO bloqueia a barra de endereço nem a UI do navegador — bloqueio completo de verdade precisa de app dedicado (Fully Kiosk Browser) ou "Fixar app" nativo do Android, nenhum configurado ainda.

### 6. Aviso sonoro do totem + tela mudando de cor (verde/vermelho) — IMPLEMENTADO (12/07/2026)

- 3 situações configuráveis (`primeiroAcesso`, `acessoLiberado`, `acessoNegado`), cada uma com tipo (voz/beep/nenhum), texto e número de beeps.
- Armazenamento em `configuracoes` (chave/valor), `PADROES.som_totem` em `config.routes.js`, validado com zod.
- Detecção de "primeiro acesso do dia": novas `jaTeveAcessoLiberadoHojeEm`/`verificarPrimeiroAcessoHojeSeguro` em `acessoTerminal.service.js`.
- Reprodução no totem: Web Audio API (beep) + Web Speech API (`pt-BR`); fundo da tela pinta verde/vermelho (`tela-flash-liberado`/`tela-flash-negado`), incluindo correção de um caso de borda no fechamento do botão "Pagar contas" que não limpava a cor.
- Configuração pelo admin: painel em Configurações → "Aviso sonoro no totem", com botão "Testar".
- **⚠️ Ressalva**: TTS pode falhar silenciosamente no tablet se a rede dele não tiver saída pra internet (alguns motores de voz do Android puxam voz online). Beep sempre funciona.
- **Pendente**: reload (F5) em Configurações pra ver o painel novo + `pm2 restart academia-gestao-totem`.

### 7. Portal remoto — senha de acesso (CPF + código da biometria) — IMPLEMENTADO (12/07/2026)

**Decisão do usuário**: reaproveitar o código sequencial que já existe fisicamente (`biometria_id`, o mesmo "cartão" da catraca Henry) como senha do portal, em vez de pagar por SMS/WhatsApp — CPF como usuário, código como senha, revelado no primeiro acesso ou cadastro novo.

- Nova coluna `alunos.portal_senha_revelada` (0/1) — marca se o aluno já viu a senha alguma vez.
- Índice único parcial em `alunos.biometria_id` (agora que também é senha, precisa ser único de verdade).
- `acessoTerminal.service.js` — `calcularProximoCodigoAluno()` (piso de segurança 1538, maior código conhecido do sistema antigo) e `atribuirCodigoAluno(alunoId)`.
- `portal.routes.js` — `autenticarAlunoPortal(cpf, senha)`; `GET /aluno` libera só com CPF na primeira vez, gera/revela o código, e passa a exigir senha depois; todas as outras rotas com CPF também exigem senha; `POST /cadastro` já devolve a senha na hora.
- Rate limit extra por CPF (8 tentativas/15min, além do limite geral de 30/15min por IP) — o código é sequencial (baixa entropia), então limitar só por IP não bastava.
- `portal.html`/`portal.js` — campo de senha, painel "Guarde sua senha de acesso" no 1º acesso, caixa destacada no cadastro novo.

**O que falta**: ✅ `scripts/adicionar-senha-portal.js` já rodado contra o Turso (12/07); falta confirmar o `git push` mais recente pro Northflank atualizar o portal; avisar a recepção que alunos antigos vão ver a tela de "1º acesso" na primeira vez que entrarem depois do deploy (esperado, não é bug).

**Nota**: o script embrulho `rodar-producao-migracao.ps1` não funciona mais porque o `.env` já não tem a linha "comentada" que ele espera (Turso ficou ativo por padrão) — rodar scripts de migração direto (`node scripts/nome.js --confirmar-producao`) em vez do embrulho.

### 8. Catraca Henry — geração automática de "cartão" pra novo aluno — PENDENTE (avançando via item 15)

**O problema**: (1) o botão "Capturar pela catraca" só funciona pra aluno que JÁ tem cartão físico na catraca — só escuta uma leitura de identificação já reconhecida, não cria nada novo. (2) No sistema antigo, "novo aluno" gerava um código sequencial e mandava criar o cartão remotamente, ANTES do aluno enrolar a digital — esse passo falta no sistema novo.

**Por que não foi implementado direto**: o protocolo binário Henry (`henryCatraca.service.js`) só tem liberar/permitir/impedir + escutar eventos — nunca teve documentado um comando de criar cartão novo. Tentar adivinhar às cegas contra o equipamento de produção tinha risco real de corromper o banco de cartões da própria catraca.

**Caminho combinado**: capturar via F12 → Network (HAR) ou Wireshark o processo de criação manual de cartão no menu administrativo da própria catraca (`192.168.0.79`, só acessível da rede da academia). **Isso já foi feito — ver item 15, que resolveu a maior parte desta pendência.** `calcularProximoCodigoAluno()`/`atribuirCodigoAluno()` (item 7) já estão prontos pra reaproveitar quando o envio à catraca for implementado.

### 9. Incidente de conexão do agente da catraca (ETIMEDOUT) + Painel de controle do Agente — RESOLVIDO / IMPLEMENTADO (14/07/2026)

**O incidente**: `catraca-agente` (PM2) ficava dando `ETIMEDOUT` persistente, mesmo com a rede/porta confirmadas OK (`Test-NetConnection` ok, socket cru fora do PM2 conectou normal). Isolado num estado específico do PROCESSO PM2 antigo — um processo novo do zero (`teste-agente-manual`) conectou de primeira. **Fix**: `pm2 delete catraca-agente` + recriar do zero + `pm2 save`. Confirmado funcionando (sincronização de cache, 1189 registros, sem novos `ETIMEDOUT`).

**Painel de controle do Agente da Catraca** (novo, pedido pelo usuário — ícone na bandeja, igual ao app antigo):
- Não foi possível compilar um `.exe` de verdade (sem acesso de rede pra toolchain .NET/Visual Studio neste ambiente).
- Solução equivalente: `agente-local/AgenteCatracaPainel.ps1` + `AgenteCatracaPainel.vbs` (abre sem janela de console) — Windows Forms, ícone na bandeja (cinza/verde/vermelho), janela com Iniciar/Parar/Reiniciar/Ver logs/Visualizar acessos/seletor Automático-Manual (atalho na pasta de Inicialização do Windows).
- 3 bugs corrigidos ao vivo: PATH "congelado" do Explorer (resolvido usando caminho completo de `pm2.cmd`), `pm2 jlist` quebrando o parser JSON do PowerShell 5.1 (chaves duplicadas por capitalização — trocado por `pm2 pid <nome>`), botão "Visualizar acessos" sem tratamento de erro (agora com `MessageBox` + `debug-painel.log`).
- Trava de instância única via Mutex; integrado ao `abrir-sistemas.bat`.

**Pendente**: criar atalho físico na Área de Trabalho manualmente (botão direito no `.vbs` → Enviar para → Área de trabalho); confirmar botão "Visualizar acessos" (`http://localhost:3000/`).

### 10. Janelas flutuantes redimensionáveis/minimizáveis/maximizáveis + filtro "1º acesso do dia" — IMPLEMENTADO (14/07/2026)

- `#painel-acessos` (Acompanhamento de acessos) convertido pro mesmo sistema de janela flutuante já usado pela catraca — arrastável, com `resize: both`.
- Nova `adicionarControlesJanela(janela)` — botões "−" (minimizar) e "□" (maximizar pra 90vw×85vh, NÃO tela cheia real, como pedido), reaproveitável.
- `GET /api/terminal/acessos?apenas_primeiro=true` — usa `ROW_NUMBER() OVER (PARTITION BY aluno_id + dia)` pra filtrar só a primeira ocorrência de cada aluno no dia; tentativas sem aluno reconhecido nunca são agrupadas entre si.

**Pendente**: `pm2 restart` + `git push`; usuário ainda não confirmou visualmente o comportamento das janelas (só testável em navegador Windows real).

### 11. Catraca não libera pra Maria Fagna quando o agente está conectado — ✅ RESOLVIDO E CONFIRMADO (15/07/2026)

**Sintoma**: acesso liberado no log, mas a catraca não abria — só com ela, sempre, usando o leitor de digital direto (não totem/QR/facial).

**Investigação**: cadastro conferido (sem duplicidade/colisão de id), cache local com uma única entrada correta, teste decisivo do usuário (agente parado → abre normal; agente rodando → não abre) isolou o problema num comportamento específico enquanto o agente está conectado — mas outro aluno (Bruno) passou normalmente logo depois, descartando "trava geral".

**Causa provável**: nome dela bem mais longo que a média ("Maria fagna ismael alencar siqueira", 35 caracteres, contra "Bruno henrique", 14) — a mensagem `"Bem-vindo(a) <nome completo>"` mandada junto do comando de liberação (campo do protocolo REON) provavelmente estourava o limite que o display físico da catraca aceita, travando o comando sem devolver erro.

**Mitigação**: `agente-local/agente.js`, `loopBiometria()` — mensagem agora usa só o primeiro nome, limitada a 24 caracteres.

**Confirmação final**: testado ao vivo pelo usuário com o agente conectado — dedo dela abriu a catraca normalmente em múltiplas tentativas seguidas. Hipótese confirmada, sem pendência.

### 12. Pendências de sincronização sem mostrar o nome do aluno — IMPLEMENTADO (14/07/2026)

**Causa raiz**: a fila de pendências (`filaCadastroOffline.service.js`) nunca enriquecia os itens — só guardava o que cada rota mandava, e as 3 rotas que enfileiram (`alunos.routes.js` × 2, `pagamentos.routes.js` × 1) montavam a descrição usando só o id bruto.

**Correção**: novo helper `nomeAlunoOffline(id)` (best-effort, reaproveita o snapshot offline já existente) usado nas 3 rotas — `descricaoResumo` agora vem com o nome quando disponível. `app.js` prioriza `item.alunoNome` na exibição.

**Pendente**: `pm2 restart` + `git push`; as 2 pendências já visíveis num screenshot anterior continuam sem nome (criadas antes do fix) — resolver normalmente pelo painel, pendências novas já vêm com nome.

### 13. Aluno inadimplente conseguindo passar na catraca (biometria direta) + incidente do PM2 travado — ✅ RESOLVIDO E CONFIRMADO (14-15/07/2026)

**O pedido do usuário**: o agente deveria saber o último status conhecido de cada aluno (atualizado com frequência) e decidir bloquear/liberar com base nisso, mesmo offline.

**Causa raiz**: a parte de "saber o status" já existia desde o item 1 (`cacheAutorizacao.json`, atualizado por pull periódico + push em tempo real) — o log do próprio usuário provou que o cache sabia corretamente que o aluno estava em atraso. Faltava só agir sobre isso: `loopBiometria()` (biometria lida direto no leitor da catraca) tinha um comportamento fail-open deliberado — quando o cache dizia "não autorizado", só registrava no log, nunca bloqueava de verdade (decisão de risco aceita numa conversa anterior).

**Correção**: `agente-local/agente.js`, `loopBiometria()` — quando o cache diz "não autorizado", o agente agora manda `henry.impedirEntrada()` de verdade.

**Ressalva de segurança aplicada**: `impedirEntrada()` nunca tinha sido testado contra o hardware real (diferente de `liberarAcesso()`, comprovadamente funcional, e de `permitirEntrada()`, testado em 08/07 e com problema conhecido — travava a tela). Por segurança, ficou atrás da variável `BLOQUEIO_ATIVO_CATRACA` (default `"false"`, zero mudança de comportamento até testar ao vivo e confirmar).

**Confirmação final (15/07/2026)**: testado ao vivo com `BLOQUEIO_ATIVO_CATRACA=true`, usando a conta de teste "Academia superação" (`biometria_id: 115`, confirmado pelo usuário como conta de teste) — log mostrou bloqueio ativo e o usuário confirmou fisicamente que a catraca recusou a entrada. Testado também um caso de controle (Robson, aluno normal) — continuou passando sem problema. **Também testado durante queda de internet simulada**: tanto a liberação normal quanto o bloqueio ativo continuaram decidindo certo usando só o cache local (~52s sem internet), sem perder nenhum evento da fila. `BLOQUEIO_ATIVO_CATRACA=true` já está ativo em produção — sem pendência.

**Incidente à parte descoberto durante a investigação — daemon do PM2 travado (RESOLVIDO)**: `pm2 list` mostrava tudo "online" mas com `cpu: 0%`/`memory: 0b` sempre, inclusive processos comprovadamente vivos. `academia-gestao-totem` chegou a ficar "online" sem porta aberta de verdade e sem nenhum log. Rodar `node src/server.js` direto (sem PM2) funcionou de cara — isolou o problema no PM2 (daemon corrompido), não no código. **Fix**: `pm2 kill` + subir tudo de novo do zero + `pm2 save`. Descoberto de brinde: `academia-gestao-local` e `academia-gestao-totem` estavam rodando AO MESMO TEMPO nesse PC (briga de porta) — `academia-gestao-local` foi parado, só `academia-gestao-totem` deve rodar nesse PC. Também descoberto e corrigido: `local.db` desse PC com schema desatualizado (faltava `portal_senha_revelada`) — corrigido com `scripts/atualizar-schema-local.js`.

**Pendente**: nenhuma pra este item — só ficar de olho se o PM2 volta a apresentar o estado "fantasma" (mesmo fix se acontecer de novo).

### 14. Guia de comandos (artefato persistido) — CRIADO (15/07/2026)

Página de referência rápida (HTML autocontido, persistida como artefato no Cowork — `comandos-academia`), organizada por situação: iniciar tudo do zero, ver o que está rodando/diagnosticar, resolver "localhost não abre"/PM2 fantasma, reiniciar um processo específico, erro de coluna faltando no banco, mandar mudanças pra nuvem, ligar/desligar `BLOQUEIO_ATIVO_CATRACA`, tabela de referência de processos PM2. Cada bloco de comando com botão de copiar. Vale atualizar conforme surgirem novos fluxos.

### 15. Protocolo HTTP da catraca (admin embutido) — reverse-engineered via HAR — 🔎 EM INVESTIGAÇÃO, avançado (15/07/2026)

**Contexto**: surgiu a partir de um print do sistema antigo (Secullum), tela "Enviar e Receber" ("Enviar lista de pessoas" / "Enviar pessoas inadimplentes como estado bloqueado") — confirma que o sistema antigo empurrava periodicamente o estado bloqueado/liberado direto pro cadastro interno da catraca. O usuário capturou (F12 → Network → HAR) duas ações na tela administrativa da catraca (`192.168.0.79`): criar cartão novo de teste (matrícula 1540) e capturar biometria pra esse cartão.

**Descobertas confirmadas**: a catraca roda um servidor HTTP leve (`Server: REP Server`), endpoint único `/rep.html`, controlado por parâmetros de URL (`pgCode`, `opType`, `lblId`, campos `lbNN`/`cbNN`/`ckNN`). Sem sessão por cookie.

- **Criar cartão novo** (resolve o item 8): `GET /rep.html?pgCode=6&opType=1&lblId=-1&lb01=<nome>&lb02=<matrícula/biometria_id>&...&cb01=<nível de controle>&...` — confirmado com resposta "Sucesso ao executar operação".
- **Campo `cb01` (Nível de controle)**: `0` = Sempre bloqueado, `1` = Sempre liberado, `2` = Segundo cadastro. É a peça que mapeia pra "enviar pessoas inadimplentes como estado bloqueado" do sistema antigo.
- **Disparar captura de biometria nova** (resolve limitação do item 8): `GET /rep.html?pgCode=14&opType=1&lblId=0&lblRegistration1=<matrícula>` — fica esperando (long-poll) o dedo tocar e só retorna sucesso depois da captura de verdade. Comando ATIVO, bem mais confiável que o fluxo passivo existente.

**Pendência do id de atualização**: apareceram DOIS ids internos pro mesmo cartão (`1258` nos links Salvar/Excluir, `16258` em "Editar biometrias"). Pra CRIAR, `lblId=-1` sempre (não afeta o item 8). Pra ATUALIZAR um cartão existente (ex.: mudar só `cb01` de um aluno que ficou inadimplente), falta confirmar qual id usar.

**Captura Wireshark do "Enviar lista de pessoas" (protocolo bruto, mesma família do REON)**: revelou `EPER`/`EHOR` (períodos/horários), `RQ` (query de sincronização — resposta `RQ+000+C]1258`, que bate com o cartão de teste 1540 e **confirma fortemente que `1258` é o id certo pra atualização**, com `16258 = 1258 + 15000`, offset fixo pra biometria), `RU` (leitura em lote de todos os cartões), `EU` (usado pra "apagar" — sobrescreve o slot com registro zerado). A captura terminou antes de mostrar o comando real de enviar o estado bloqueado (Secullum abortou com erro nesse ponto).

**Teste com dedo real, catraca conectada ao Secullum**: aluno de teste com conta vencida, acesso negado como esperado. Protocolo capturado:
```
73+REON+000+0]00000000000000000115]15/07/2026 07:40:48]1]0]5   ← evento de biometria
73+REON+00+30]10]Vencido - negado                               ← comando de bloqueio ativo
73+REON+000+30]]15/07/2026 07:40:49]0]0]0                       ← confirmação
```
**Achado importante**: esse é EXATAMENTE o mesmo comando que `impedirEntrada()` do nosso `agente-local/henryCatraca.js` já usa (`REON+00+30]${RELEASE_TIME}]${mensagem}]1`) — não foi palpite, é o comando "oficial" usado pelo software profissional. Reforça a confiança no `BLOQUEIO_ATIVO_CATRACA` (item 13), já testado com hardware real.

Comparando o cadastro do cartão antes/depois desse teste: nenhum campo mudou (nível de controle continuou "Segundo cadastro") — o bloqueio do Secullum é 100% reativo em tempo real, não um estado pré-carregado no cartão.

**Teste com Secullum desconectado — CONFIRMADO**: acesso liberado (conta ainda vencida). Confirma que a catraca sozinha não guarda nenhum estado de bloqueio persistido — depende do agente do Secullum estar rodando E conectado. Diferença importante em relação ao nosso sistema: nosso `agente-local` roda LOCAL (mesma rede da catraca) com cache persistido, então sobrevive à queda de INTERNET (já testado, item 13) — mas não sobreviveria à queda do próprio `agente-local` (ex.: incidente do PM2 fantasma), cenário em que nem o Secullum se protegeria. Essa é a justificativa real pra ainda valer a pena perseguir `cb01` como camada extra (defesa em profundidade), não como substituto do `BLOQUEIO_ATIVO_CATRACA`.

**Decisão**: não vale mais insistir no protocolo bruto do Secullum — seguir pelo caminho HTTP já confirmado (`/rep.html`). Próximo teste: editar o cartão de teste (matrícula 1540, id 1258) pelo navegador, mudar só "Nível de controle" pra "Sempre bloqueado", Salvar, capturar via F12 → Network — confirma o `lblId` de atualização e o efeito do `cb01` de uma vez.

**Nota de segurança**: o HAR capturou login em texto puro na URL do painel da catraca — não compartilhar esse `.har`, considerar trocar essa senha por precaução (risco baixo, painel só alcançável da rede Wi-Fi da academia).

**O que falta**: 1 teste final pelo navegador (mudar nível de controle do cartão de teste + capturar) pra fechar de vez o id de atualização e confirmar o efeito do `cb01`. Nenhum código escrito ainda usando essas descobertas — decisão deliberada de só implementar depois de confirmar tudo com o usuário.

### 16. Instabilidade recorrente do "localhost não abre" — CAUSA RAIZ ENCONTRADA E CORRIGIDA (15/07/2026)

**O problema**: `abrir-sistemas.bat` clicado de manhã, `localhost:3000` recusando conexão, catraca sem nenhum agente conectado. `pm2 list` veio totalmente vazio (diferente do incidente do item 13, que era "fantasma" mas listado).

**Causa raiz**: `abrir-sistemas.bat` nunca iniciou nenhum processo PM2 — só abria as janelas do navegador e o painel da bandeja, sempre assumindo que os processos já estavam rodando de antes. Se o PC reiniciou, o daemon do PM2 caiu, ou o Windows atualizou, clicar em "abrir sistemas" só abria abas apontando pra um servidor que nem estava de pé.

**Correção**: adicionados ao início do `.bat` os comandos que garantem que `academia-gestao-totem` e `catraca-agente` estão rodando (via `pm2 start`, seguro rodar sempre — PM2 detecta "already launched" e não reinicia quem já está de pé) + `pm2 save` + `timeout /t 3` antes de abrir o navegador.

**Resultado**: "abrir sistemas" agora é auto-suficiente, não depende mais de nada ter sobrevivido de um boot anterior.

**Pendente**: testar ao vivo (fechar tudo e clicar em "abrir sistemas" pra confirmar o auto-cura); investigar por que o PM2 perde o processo/dump entre sessões (considerar `pm2-windows-startup` ou Tarefa Agendada com `pm2 resurrect` pra sobreviver a reinícios do Windows de forma mais robusta); confirmar que o `.bat`/painel da bandeja sempre roda logado como o mesmo usuário do Windows (`Nova Graf`), já que o PM2 guarda a lista de processos por usuário.

---

## Histórico anterior (sessões antes de 07/07/2026, mantido como referência)

- **06/07/2026 — rework do painel admin**: reorganização geral estilo Secullum Academia.Net (perfil do aluno em abas, "Acessos recentes" como gaveta lateral), Contas a Receber com fluxo completo (busca, modal Conta com sub-grade de pagamentos, quitação automática), janela flutuante da catraca (formato compacto "Liberar Equipamentos"), Relatórios (Financeiro, Acesso Diário, Acesso Pessoal, Último Acesso), importar/exportar CSV, backup automático a cada 24h, tela de Configurações (nome do app + "Licenciado para"). Todos os arquivos dessa leva confirmados funcionando em produção.
- **Sessão anterior a essa — auto cadastro + pagamento pelo totem**: aluno novo se cadastra sozinho no totem, escolhe plano, paga via Pix (Mercado Pago, API de Orders `/v1/orders`, não a API antiga de Payments), acesso liberado automaticamente ao confirmar pagamento; verificação ativa por polling (não só webhook); QR Pix gerado no próprio totem; testado com Pix real de R$1,00 confirmado ponta a ponta.
- **Variáveis de ambiente históricas**: `MERCADOPAGO_ACCESS_TOKEN` (produção, API de Orders não aceita token de teste), `MERCADOPAGO_WEBHOOK_SECRET` (validação de assinatura do webhook), `TERMINAL_TOKEN`/`AGENTE_TOKEN` (segredos do totem/agente, trocados e sincronizados entre `.env` local e `agente-local/.env`), `HENRY_CATRACA_IP=192.168.0.79`/`HENRY_CATRACA_PORT=3000`.

### Aprendizados importantes (evitar repetir)

- **Deploy manual é frágil pra múltiplos arquivos** — hoje o deploy é por `git push origin main` (Northflank redeploya sozinho), não mais upload manual arquivo por arquivo.
- **Diagnóstico de crash em produção**: Northflank → Deployments → instância → "View Logs" mostra o stack trace exato.
- **Comandos administrativos direto no Northflank**: botão "Shell (SSH)" de uma instância saudável abre terminal já com as variáveis de produção carregadas.
- **Cuidado ao transcrever segredos longos via print de tela** — preferir copiar direto da fonte.
- **`.env` com a mesma variável duplicada**: a última ocorrência vale, no formato do `dotenv`.
- **PATH do Windows após `npm install -g`**: pode não ser reconhecido em janela nova se a pasta global do npm não estiver no PATH do sistema — corrigir permanentemente em "Editar as variáveis de ambiente do sistema".
- Um campo `required` escondido (`display:none`) num bloco condicional faz o Chrome bloquear o envio do formulário silenciosamente — validar manualmente em JS campos que podem ficar escondidos condicionalmente.
- `z-index` do toast precisa ser maior que o de modais/painéis.
- **Nunca deixar `npm start`/`npm run dev` locais apontarem pra produção "por padrão silencioso"** sem o usuário saber — esse foi o gatilho do incidente de cobrança fantasma de 08/07 (histórico, superado pela arquitetura do item 1, mas a lição de fundo continua valendo: mudanças de ambiente/banco padrão precisam ser bem visíveis e combinadas com o usuário).
- **Todo script administrativo que mexe em dado real precisa declarar explicitamente qual banco usa** — nunca herdar do cliente compartilhado por acidente.
- **Preferir sempre um comando rodado pelo próprio usuário no PC dele (ground truth) em vez de confiar cegamente numa cópia "espiada" remotamente** — lição reforçada nesta própria sessão (18/07), quando a leitura da ponte remota trouxe uma cópia deste arquivo desatualizada em vários dias.
