# Status do projeto — Academia Gestão

Última atualização: 19/07/2026 (painel responsivo pro celular + totem em TV com webcam via Raspberry Pi). **Leia só a seção "ESTADO ATUAL" abaixo pra retomar o trabalho** — o resto do arquivo é histórico de sessões passadas, mantido só como referência de "por que as coisas são como são".

## Sessão 19/07/2026 (continuação) — Painel responsivo + totem numa TV com câmera via Raspberry Pi

**Painel administrativo responsivo pro celular:** o painel (`index.html`/`app.js`/`style.css`) nasceu só pensado pra tela de PC — sidebar fixa de 220px, zero media queries. Corrigido: abaixo de 900px a sidebar vira menu "gaveta" (abre com o ☰ no topo, fecha tocando fora ou ao escolher uma seção — ver `#btn-menu-mobile`/`#sidebar-overlay` em `app.js`), formulários de duas colunas (`.grid-2`) empilham em uma, e tabelas ganham rolagem horizontal própria (`table.tabela { display:block; overflow-x:auto }` — funciona sem precisar envolver as 29 tabelas do painel numa `<div>` extra). Testado com Playwright simulando 375px de largura antes de entregar; desktop sem nenhuma mudança visual.

**Decisão de arquitetura do totem — trocando o tablet por uma TV:** o dono do sistema está trocando o dispositivo físico do totem por uma Smart TV (sem câmera embutida, sem toque). Depois de descartar tentar rodar o app do totem direto na TV (Google TV não dá suporte confiável a webcam USB genérica nem a apps de toque customizados — ver troca de mensagens desta sessão pro raciocínio completo), a solução adotada foi: um **Raspberry Pi fica fisicamente perto da catraca** com a webcam USB plugada nele, e publica o vídeo pela rede local como stream MJPEG (com CORS liberado) — a TV (ou qualquer tela, em qualquer lugar da academia) só precisa carregar `terminal.html` normalmente, que consome esse stream pela rede.

Isso reaproveita — e não repete — o problema que matou a tentativa anterior (11/07/2026, documentada em `terminal.js`): usar webcam USB direto no TABLET falhou porque a porta USB-OTG dele não sustentava a energia da webcam (caía sozinha, "no-power" no log do Android). A porta USB de um Raspberry Pi fornece energia de verdade — esse problema específico não é esperado se repetir.

**IMPORTANTE — nada disso está ligado no totem de produção ainda.** A pedido explícito do dono do sistema ("não substitua nada ainda, deixe como arquivos à parte para teste — o que já está funcionando deve ser preservado"), `terminal.html`/`terminal.js` (o totem real, com `USAR_WEBCAM_USB = false`, câmera embutida) **continuam 100% intactos e funcionando como sempre**. Toda a mudança de câmera foi isolada numa cópia paralela:

- `scripts/totem/webcam_raspberry.py` (novo) — script Python que roda no Raspberry Pi: captura a webcam via OpenCV/V4L2 (Linux enxerga webcam USB nativamente, ao contrário do Android — não precisa de app terceiro nem plugin nativo), publica MJPEG com CORS na porta 9000. Instruções completas de instalação, systemd (subir sozinho no boot) e reserva de IP no roteador estão no próprio docstring do arquivo. Testado nesta sessão: sintaxe, serving HTTP/CORS/multipart (com um quadro falso, já que não há webcam física no ambiente de teste) e rotação/encode JPEG via OpenCV — todos passaram.
- `terminal-teste-pi.html` + `terminal-teste-pi.js` (novos, cópias de `terminal.html`/`terminal.js`) — mesma lógica do totem real, só com `USAR_WEBCAM_USB = true` e `USB_WEBCAM_URL` apontando pro Raspberry Pi (**trocar `192.168.0.50` pelo IP de verdade dele — e configurar reserva de DHCP no roteador pra esse IP nunca mudar**). Abra `terminal-teste-pi.html` num navegador na mesma rede do Pi pra testar, sem nenhum risco pro totem em produção.
- **Bug real encontrado nesta sessão (e corrigido só nos arquivos de teste, não em `terminal.js`)**: o código sempre tratou o elemento de câmera como `<img>` quando `USAR_WEBCAM_USB` é `true` (`elementoCameraPronto`/`larguraCamera`/`alturaCamera` usam `.complete`/`.naturalWidth`/`.naturalHeight`, que só existem em `<img>`) e o CSS já tinha uma regra pronta pra `img.camera-feed` — mas nada no JS trocava a tag `<video>` (fixa no HTML) por um `<img>` de verdade. Sem essa troca, a câmera nunca seria detectada como "pronta" (`<video src="stream-mjpeg">` não decodifica esse formato) — ou seja, mesmo a arquitetura antiga (tablet + proxy Termux) provavelmente nunca teria funcionado se tivesse sobrevivido até essa parte, embora o problema de energia tenha aparecido antes disso ser testado a fundo. Corrigido em `terminal-teste-pi.js`: `iniciarCamera()` agora troca o `<video>` por um `<img>` (mesmo id/classe) na primeira vez que roda em modo webcam USB — testado com jsdom (troca acontece, é idempotente numa segunda chamada, não duplica elemento). **Esse mesmo bug continua existindo em `terminal.js`, adormecido, sem efeito nenhum** enquanto `USAR_WEBCAM_USB` ficar `false` lá.

**Pendências:** montar o Raspberry Pi de verdade e testar `terminal-teste-pi.html` na prática; depois disso (e só depois), promover as mudanças de `terminal-teste-pi.js` pra `terminal.js` de verdade; digitar o IP real do Raspberry Pi (hoje é um placeholder nos dois arquivos de teste); decidir/implementar uma alternativa ao campo "Ou digite seu CPF" da tela inicial do totem pra funcionar sem toque na TV (sugestão já discutida: teclado USB comum ligado na TV, já que ela tem porta USB sobrando) — ainda não implementado.

## Sessão 19/07/2026 — Auditoria de segurança geral + correção de XSS armazenado

Pedido do dono do sistema: avaliar uma lista de ~19 pontos de segurança (injeção de código, XSS/CSP, upload malicioso, DoS, autenticação/sessão, exposição via API, HTTPS, inventário de dependências) contra o código real do projeto, corrigir o que fosse prioridade, e gravar um skill reutilizável pra repetir essa auditoria em outros projetos.

**Relatório completo** entregue como `RELATORIO-SEGURANCA-2026-07-19.md` (mandado pro usuário, não versionado no repo). Resumo dos veredictos: SQL injection já bem resolvido (tudo via `db.execute({sql, args})` parametrizado — não precisa de ORM); validação com `zod` já presente nas rotas mais recentes, vale confirmar cobertura em rotas mais antigas; **XSS era real e crítico — corrigido nesta sessão** (ver abaixo); CSP ainda não implementado de propósito (estilos inline quebrariam) — vale uma passada futura com `script-src 'self'` como reforço; não há upload de arquivo binário no sistema hoje (reconhecimento facial usa descriptor numérico, não imagem) — item não se aplica; DoS mitigado parcialmente (limite de corpo 1mb + rate limit nas rotas públicas mais expostas); hashing de senha usa `bcryptjs` (dependência confirmada, fluxo completo não pôde ser conferido nesta sessão por `usuarios.routes.js` não estar na cópia local revisada — vale confirmar numa próxima sessão); JWT expira em 8h, via header (imune a CSRF clássico); 2FA e cookie httpOnly pro token são melhorias válidas mas não urgentes; HTTPS provavelmente já é terminado pelo Northflank — vale confirmar e adicionar header HSTS; sem processo de inventário de dependências — recomendado ativar Dependabot no GitHub (`treinopro/acess`), é grátis e não exige mudança de código.

**Correção de XSS armazenado (`public/app.js`):** a função `el()` (usada ~35-40 vezes pra montar linhas de tabela e outros trechos de HTML) interpolava campos vindos da API (nome, e-mail, telefone, observações, descrições, etc.) direto em `innerHTML`, sem nenhum escape. Como o sistema tem vários pontos de cadastro público sem login (totem, portal, "indicar visitante/amigo", cadastro pelo celular), um nome malicioso digitado num cadastro público rodava como script na tela do admin ao abrir a lista — e como o token JWT fica em `localStorage`, isso permitia roubo completo da sessão do admin. Corrigido adicionando uma função `escapeHtml()` (perto de `el()`, por volta da linha 111-127) e envolvendo todas as interpolações de texto livre em `escapeHtml(...)` em todos os pontos de renderização do arquivo — nomes, e-mails, telefones, observações, descrições de cobrança, exercícios, mensagens do histórico de envio, etc. — sem tocar nos trechos de HTML "de propósito" (botões condicionais, atributos `disabled`/`checked`). Validado com `node --check public/app.js` e revisão manual por amostragem. **`terminal.js`, `portal.js` e `cadastro-mobile.js` ficaram de fora desta rodada** — têm padrão parecido, mas risco bem menor (dado majoritariamente escolhido pelo próprio admin, ou auto-XSS do próprio usuário vendo o próprio nome) — vale uma passada futura se quiser fechar 100%.

**Skill gravado** em `.claude/skills/auditoria-seguranca-webapp/SKILL.md` (também salvo na sessão do Claude, fora deste repo) — captura o método usado aqui (levantar o código real antes de opinar item a item, veredicto "faz sentido / tem risco / vale a pena" por item, e o padrão de correção de XSS em apps sem framework) pra reusar em outros projetos do dono do sistema, mesmo os que não usam essa mesma stack.

**Pendências desta sessão:** confirmar hashing de senha em `usuarios.routes.js` (arquivo não estava na cópia local revisada); considerar CSP, HSTS, Dependabot e a passada de escaping em terminal/portal/cadastro-mobile como próximos passos, sem urgência.

> ⚠️ **Nota desta atualização (18/07/2026)**: a cópia deste arquivo lida pela ponte remota antes desta edição ainda estava datada de 08/07/2026, sem nenhuma das sessões feitas depois disso (relatório "Pessoas", correção do totem, rotação de credenciais expostas no chat, etc.) — o mesmo problema de cache/leitura desatualizada da ponte remota já documentado mais abaixo neste arquivo. Se você tinha uma versão mais recente salva localmente, **confira o arquivo de verdade no seu PC antes de confiar cegamente neste texto** — pode ser preciso mesclar manualmente.

## ESTADO ATUAL (comece por aqui)

- **IMPORTANTE — leia a seção "Ambiente local vs produção (mudança de 08/07/2026)" logo abaixo antes de rodar qualquer coisa neste PC.** O `.env` mudou de padrão: `npm start`/`npm run dev` direto agora caem no `local.db` (arquivo de teste), não mais na produção. Isso veio de um incidente real (cobrança fantasma em produção) coberto em detalhe naquela seção.
- **Deploy é por `git push origin main`** (não é mais upload manual de arquivo por arquivo no GitHub). O Northflank redeploya sozinho a cada push na branch `main`. **O site publicado NÃO é afetado pela mudança de `.env` acima** — a hospedagem usa variáveis configuradas direto no painel dela, nunca lê o `.env` deste PC (está no `.gitignore`, nunca vai pro GitHub).
- **Migração do Secullum, v2**: refeita do zero no `local.db` (não na produção) com idempotência (`secullum_id`/`secullum_numero`) e um mecanismo de "adoção" de cobrança `legado` já existente em vez de criar cobrança nova pro primeiro ciclo — evita o padrão de cobrança fantasma que a v1 causava. Validação ainda em andamento (ver pendências abaixo). **A produção NÃO foi migrada com essa lógica ainda** — continua com os dados antigos, só limpos das 29 cobranças fantasma do incidente (ver seção nova abaixo).
- **Pendências reais agora** (nesta ordem):
  1. Continuar validando o `local.db`: conferir 10-15 alunos no painel (incluindo os casos de referência Edna Andrade e Alenia Cabral Silva), conferir totais em Relatórios, revisar os alunos marcados para revisão no relatório da migração.
  2. Depois da validação aprovada, decidir com calma se/quando aplicar a mesma migração v2 na produção de verdade (usando `scripts/rodar-producao.ps1`, nunca `npm start` direto) — não iniciar sem confirmação explícita.
  3. Decidir se aplica a limpeza dos ~50 grupos de cobranças `legado` duplicadas antigas (2020–2025) na produção — achado separado, não relacionado ao incidente de 08/07 (script já existia de sessão anterior, ver "Sessão 07/07/2026 (tarde)").
  4. Itens mais antigos da sessão de 07/07 (tarde) — atualização na noite de 08/07: `importar-biometria-catraca.js --aplicar` **confirmado rodado** (1181 alunos vinculados no `local.db`); `religar BIOMETRIA_CATRACA_ATIVA` **testado e validado no `local.db`** (ver nova seção "Sessão 08/07/2026 (noite)" logo abaixo — 5 bugs encontrados e corrigidos em `agente-local/agente.js`). Ainda em aberto: `node src/db/migrate.js` (índice de proteção contra duplicata) em produção, `git push` das mudanças da sessão de 07/07 (tarde), decidir os casos ambíguos de aluno duplicado (Mayra/Nayra CPF 13700311494 + ~9 pares "quase-duplicata", listados na nova seção abaixo).
  5. **Nova pendência (08/07 noite): levar a biometria da própria catraca pra PRODUÇÃO** — hoje só está testada e funcionando no `local.db`. Depende de resolver antes a pendência #2 acima (migração v2 na produção). Plano detalhado passo a passo na seção "⚠️ PLANO — colocar a biometria da catraca pra funcionar em produção" logo abaixo. **Não iniciar sem decisão e presença explícita do usuário.**
- As correções de segurança da sessão da manhã de 07/07/2026 (ver seção abaixo) **já foram enviadas** via `git push` e as variáveis de ambiente (`JWT_SECRET`, `CADASTRO_PUBLICO_TOKEN`) já foram configuradas no Northflank — não estão mais pendentes de upload, só falta confirmar se `MERCADOPAGO_WEBHOOK_SECRET` bate com o painel do Mercado Pago e se as variáveis antigas da InfinitePay foram removidas do Northflank.
- **Nova feature 18/07/2026 — "Recuperação de Clientes" (evasão/retenção)**: código escrito e gravado no projeto, **AINDA NÃO instalado/migrado/enviado ao GitHub**. Antes de usar, veja a seção "Sessão 18/07/2026 — Recuperação de Clientes" logo abaixo pro passo a passo completo (rodar `npm install`, `node src/db/migrate.js`, configurar `GMAIL_USER`/`GMAIL_APP_PASSWORD`, e só então `git push`).
- **Nova feature 18/07/2026 (noite) — categorias de pessoa, visitantes/indicação, e-mail de boas-vindas automático**: pacote grande, construído tudo de uma vez a pedido seu ("faça tudo de uma vez e me avise pra apenas fazer minha parte"). Código escrito e testado localmente (migração simulada com sucesso contra uma cópia do schema real, `node --check` limpo em todos os arquivos, IDs de HTML/JS conferidos), **AINDA NÃO enviado ao GitHub nem migrado em produção**. Veja a seção **"Sessão 18/07/2026 (noite) — Categorias, visitantes e e-mail de boas-vindas"** logo abaixo pro passo a passo completo e a lista exata do que fica por sua conta (git push, `node src/db/migrate.js`, testar no ar).

## Onde está publicado

- App: `https://academia--acess--tpff5w2s24vs.code.run`
- Totem: `https://academia--acess--tpff5w2s24vs.code.run/terminal.html`
- Painel admin: `https://academia--acess--tpff5w2s24vs.code.run` (login: e-mail cadastrado do admin — a senha padrão `admin123` foi trocada via `scripts/trocar-senha-admin.js`, ver seção de segurança)
- Repositório: GitHub `treinopro/acess`, branch `main` — **deploy via `git push origin main`**
- Hospedagem: Northflank (Buildpack, porta pública 8080), serviço no projeto `acess-academia` / time `acessfits-team`
- Banco de dados: Turso (libSQL) — usado pela produção (site publicado, configurado direto no painel do Northflank) e, opcionalmente, por este PC quando rodado de propósito via `scripts/rodar-producao.ps1`. **Não é mais o padrão deste PC** — ver seção "Ambiente local vs produção (mudança de 08/07/2026)" logo abaixo. O padrão local agora é `local.db`, um arquivo SQLite separado, só de teste.

---

## Sessão 18/07/2026 (noite) — Categorias, visitantes e e-mail de boas-vindas

Pacote grande pedido de uma vez ("vamos adicionar uma nova função... caso tenha outras sugestões, me traga"). Cobre: categoria de pessoa (aluno/professor/visitante/colaborador/bolsista), acesso livre pra colaborador/bolsista, cadastro de visitante/amigo pelo totem (com indicação e limites configuráveis), e-mail automático de boas-vindas no cadastro (com link do Portal + senha), envio em massa desse mesmo convite pra "Todos os ativos", e inclusão de visitantes na Recuperação de Clientes. Construído tudo de uma vez, a seu pedido, e só entregue no final.

### O que foi construído

**Banco de dados** (`src/db/schema.sql` + `src/db/migrate.js`, incremental — seguro rodar de novo):
- `alunos.categoria` (TEXT, padrão `'aluno'`) — valores: `aluno`, `professor`, `visitante`, `colaborador`, `bolsista`. Chamei de "categoria" (não "modalidade") de propósito, pra não confundir com `turmas.modalidade` (tipo de aula), que é outro conceito.
- `alunos.indicado_por_aluno_id` (TEXT, FK opcional pra `alunos.id`) — preenchido só quando um visitante foi cadastrado por indicação de um aluno.
- Índices novos: `idx_alunos_categoria`, `idx_alunos_indicado_por`.
- `configuracoes`: duas chaves novas, editáveis em Configurações — `visitante_limite_acessos` (padrão `1`, fixo mas alterável, como você pediu) e `indicacao_limite_mensal` (padrão `2`, recomendado por você).
- Modelo de mensagem seed **"Boas-vindas / Cadastro facial"** criado automaticamente na primeira migração (mesmo texto do e-mail automático, com `{nome}` e `{senha}`) — já vem pronto no composer da Recuperação de Clientes, pra reenviar em massa.

**Backend**:
- `src/services/acessoTerminal.service.js` — `verificarAutorizacaoAluno`/`listarAutorizacoesBiometricas` agora tratam categoria: `colaborador`/`bolsista` sempre autorizados (exceto se trancado/inativo manualmente — isso continua bloqueando igual antes); `visitante` autorizado até bater o limite de acessos configurado, depois bloqueia com mensagem pedindo pra procurar a recepção. Funções novas: `limiteAcessosVisitanteEm`, `contarAcessosLiberados`, `limiteIndicacoesMensalEm`, `contarIndicacoesNoMes`.
- `src/services/emailBoasVindas.service.js` (novo) — monta e envia o e-mail padrão de boas-vindas (link do Portal do Aluno + senha de acesso), sempre best-effort (nunca atrasa/quebra o cadastro em si) e desacoplado da tabela de modelos editáveis (apagar o modelo seed não quebra o e-mail automático). Fica registrado em "Histórico" da Recuperação de Clientes, sucesso ou erro.
- `src/routes/alunos.routes.js` — cadastro pelo painel admin aceita `categoria` e dispara o e-mail de boas-vindas automaticamente quando o aluno tem e-mail.
- `src/routes/terminal.routes.js` — nome/e-mail/telefone/data de nascimento agora **obrigatórios** no auto-cadastro do totem; `GET /planos` sempre inclui a opção "Visitante" (sem custo, sem matrícula real — não polui relatórios financeiros); `POST /auto-cadastro` ganhou um fluxo dedicado pra visitante (sem Pix/matrícula/cobrança), com indicação opcional por CPF do aluno e checagem do limite mensal.
- `src/routes/portal.routes.js` — mesmo tratamento do totem espelhado no portal remoto (campos obrigatórios, opção Visitante, fluxo de indicação) — o seletor de **upgrade** de plano continua sem a opção Visitante de propósito (`GET /planos?incluir_visitante=true` só no cadastro novo).
- `src/routes/recuperacao.routes.js` — dois endpoints novos: `GET /todos-ativos` (audiência pra reenviar o convite em massa) e `GET /visitantes` + `GET /visitantes/indicadores` (relatório de visitantes e ranking de indicações no mês). O composer de envio (`POST /enviar`) ganhou suporte à variável `{senha}` no texto (só busca/gera a senha do aluno quando o modelo realmente usa isso).
- `src/routes/config.routes.js` — corrigido o bug de "Recuperação de Clientes" não aparecer na ferramenta de reordenar menus (faltava na lista de chaves válidas) + lógica de autocura: se um menu novo for adicionado no futuro e a ordem salva no banco não souber dele, ele é acrescentado sozinho em vez de sumir da tela.

**Frontend**:
- `public/terminal.html`/`terminal.js` — formulário de auto-cadastro ganhou e-mail e data de nascimento (obrigatórios), campo opcional "CPF de quem indicou", e um botão novo no menu principal **"Indicar visitante/amigo"** que já abre o formulário com o plano "Visitante" pré-selecionado (sem precisar mexer no restante do fluxo de pagamento).
- `public/portal.html`/`portal.js` e `public/cadastro-mobile.html`/`cadastro-mobile.js` — mesmos campos obrigatórios; a página "usar seu cel" (cadastro-mobile) deliberadamente **não** oferece a opção Visitante (esse fluxo é só pro cadastro pago normal — indicar visitante é uma ação direto no totem físico).
- `public/index.html`/`app.js` — formulário de aluno (criar e editar/perfil) ganhou seletor de Categoria; lista de alunos ganhou coluna Categoria; Recuperação de Clientes ganhou duas abas novas: **"Todos os ativos"** (filtro por nome/categoria, seleção múltipla, reaproveita o mesmo composer de envio) e **"Visitantes"** (acessos usados vs. limite, quem indicou, + tabela de indicações por aluno no mês, pra acompanhar o limite mensal).

### Decisões tomadas com você nesta sessão
- Limite de acessos por visitante: fixo em **1**, mas alterável depois em Configurações.
- Limite de indicações por aluno/mês: **2** (recomendado).
- Entrega: tudo de uma vez, sem pausar pra confirmação a cada parte — só ao final, com uma lista clara do que fica por sua conta.

### Sugestões extras (não implementadas ainda, pra você avaliar)
- **CSV de alunos** (exportar/importar) ainda não inclui a coluna `categoria` — hoje quem for importado cai sempre como "aluno" por padrão. Posso adicionar se for útil pro seu fluxo de importação em massa.
- O bug de ordem dos statements do `migrate.js` (comentário com `;` já resolvido antes) tem um "primo": um `CREATE INDEX` **precedido de linha de comentário** pode ser classificado por engano como statement de tabela e rodar antes de uma coluna nova existir. Não afeta a migração desta sessão (conferi um por um), mas é uma fragilidade que pode pegar alguém desavisado numa migração futura — posso blindar isso se quiser.
- Nenhum aviso de "visitante quase batendo no limite" ainda — hoje só bloqueia quando bate o limite. Se fizer sentido, dá pra mostrar um aviso preventivo no totem no penúltimo acesso.

### Passos pendentes antes de usar (nesta ordem)
1. **Enviar ao GitHub**: `git add -A && git commit -m "..." && git push origin main` (Northflank redeploya sozinho).
2. **Rodar a migração** (cria as colunas/índices novos + o modelo "Boas-vindas / Cadastro facial"): `node src/db/migrate.js` — tanto faz rodar do seu PC (usa o mesmo Turso de produção, `DATABASE_URL` no `.env`) ou de dentro do shell do Northflank, como você já fez antes.
3. **Testar**: cadastrar um aluno novo pelo painel com e-mail preenchido e conferir se o e-mail de boas-vindas chegou; no totem, testar "Indicar visitante/amigo" preenchendo os dados de um "amigo" fictício e conferir se ele aparece na aba Visitantes da Recuperação de Clientes; testar o botão "Enviar mensagem aos selecionados" na aba "Todos os ativos" escolhendo o modelo "Boas-vindas / Cadastro facial".
4. Se quiser alterar os limites de visitante/indicação, isso já está em Configurações (número de acessos por visitante e indicações por aluno/mês).

---

## Sessão 18/07/2026 — Recuperação de Clientes (evasão/retenção)

Feature nova, do zero: lista de alunos que pararam de aparecer, aniversariantes do mês, envio de mensagem (e-mail real ou link do WhatsApp manual) e concessão opcional de acesso especial/gratuito. Todo o código foi escrito e gravado nas pastas do projeto neste PC — **falta rodar 3 passos antes de usar** (ver "Passos pendentes" abaixo).

### O que foi construído

**Banco de dados** (`src/db/schema.sql`, 3 tabelas novas, `CREATE TABLE IF NOT EXISTS` — seguras rodar de novo):
- `mensagens_templates` — modelos reutilizáveis de mensagem (saudação, corpo, tipo de link, se concede dias grátis).
- `concessoes_acesso` — concessões de acesso especial/gratuito (aluno, dias, validade, motivo, quem concedeu). Não mexe em nenhuma cobrança real.
- `mensagens_enviadas` — histórico de tudo que foi enviado/gerado (e-mail ou link de WhatsApp), pra nunca reenviar sem querer.

**Backend novo**:
- `src/services/email.service.js` — envio de e-mail via Gmail SMTP + Senha de App (`nodemailer`), lê `GMAIL_USER`/`GMAIL_APP_PASSWORD`/`GMAIL_FROM_NOME` do ambiente. Se não configurado, dá erro claro (não trava o resto do sistema).
- `src/routes/recuperacao.routes.js` (novo, montado em `/api/recuperacao`, admin-only) — endpoints: `GET /dias-sem-acesso` (lista com dias sem aparecer, mesmo quem nunca acessou), `GET /aniversariantes` (mês/dia), CRUD de `/templates`, `POST /enviar` (e-mail ou WhatsApp, em lote), `POST /conceder-acesso` (avulso), `GET /concessoes`, `GET /historico`, `GET /status` (se e-mail está configurado).
- `src/services/acessoTerminal.service.js` — **alterado com cuidado**: `verificarAutorizacaoAluno` e `listarAutorizacoesBiometricas` agora checam `concessoes_acesso` antes de bloquear por inadimplência. Regra explícita: uma concessão ativa **só contorna bloqueio por mensalidade em atraso** (status `inadimplente` ou cobrança vencida) — cadastro **trancado ou inativo continua bloqueando igual antes**, porque isso é decisão manual do admin, não relacionada a pagamento. Ou seja: "5 dias grátis" nunca reabre sozinho um cadastro que você trancou de propósito.

**Frontend novo** (`public/index.html` + `public/app.js` + `public/style.css`), menu "Recuperação de Clientes" (visível só pra admin, igual Usuários/Configurações/Catraca):
- Aba **Dias sem acesso**: lista com dias sem aparecer, destaque laranja pra quem também está em atraso (mesmo critério visual de "Contas em atraso"), seleção múltipla, botão "Enviar mensagem" por linha ou em lote, botão "Conceder acesso" avulso (com confirmação e prompt de quantos dias).
- Aba **Aniversariantes**: seletor de mês, calendário visual (dias com aniversariante destacados, clicável pra filtrar), lista, seleção múltipla + envio em lote. Aviso "🎂 aniversariante(s) hoje" aparece no topo da seção e como toast logo após o login do admin.
- Aba **Modelos de mensagem**: CRUD de templates (nome, saudação com `{nome}`, corpo, tipo de link — acesso do aluno / oferta personalizada / sem link —, e opção "concede N dias grátis" por modelo).
- Aba **Histórico**: tudo que foi enviado/gerado, filtrável por aluno/canal.
- Composer de envio (modal): escolhe canal (WhatsApp sempre manual — só gera o link `wa.me`, o admin clica e confirma o envio ele mesmo; e-mail de verdade via SMTP), modelo opcional, prévia da mensagem, e checkbox "conceder acesso especial" com confirmação explícita antes de liberar.

### Decisões tomadas com você nesta sessão
- **E-mail**: Gmail SMTP com Senha de App (reaproveitando `academiasuperacao01@gmail.com`), não um provedor transacional separado — você quem coloca `GMAIL_USER`/`GMAIL_APP_PASSWORD` no `.env`/Northflank, eu nunca vejo a senha.
- **WhatsApp**: sempre manual, sem nenhum disparo automático — o sistema só gera o link pronto (`wa.me/...?text=...`), você que clica e confirma o envio de verdade no seu WhatsApp.
- **Acesso especial**: desligado por padrão, só ativa quando você marca a caixa "Conceder acesso especial" no composer (ou usa o botão avulso "Conceder acesso"), com uma confirmação explícita mostrando quantos dias e quantos alunos antes de liberar.

### Passos pendentes antes de usar (nesta ordem)

1. **`npm install`** na pasta do projeto — `nodemailer` foi adicionado ao `package.json` mas ainda não está instalado no `node_modules` deste PC.
2. **`node src/db/migrate.js`** (local) — cria as 3 tabelas novas no `local.db`. Rodar também em produção depois (Shell do Northflank, ou `git push` já dispara o deploy mas a migração de schema **não roda sozinha** — confirmar se o processo de deploy já roda `migrate` automaticamente; se não, rodar manualmente uma vez via Shell do Northflank).
3. **Configurar o e-mail**: gerar uma Senha de App em `myaccount.google.com/apppasswords` pra `academiasuperacao01@gmail.com` (exige verificação em duas etapas ativada na conta) e colocar `GMAIL_USER`/`GMAIL_APP_PASSWORD` no `.env` local e nas variáveis de ambiente do Northflank (produção). Sem isso, o canal "E-mail" fica desabilitado no composer (mas o WhatsApp manual funciona normalmente, não depende disso).
4. **Testar local primeiro** (`npm start`, cai no `local.db` — ver seção "Ambiente local vs produção" abaixo) antes de `git push` pra produção: enviar uma mensagem de teste (WhatsApp pra você mesmo, e-mail depois de configurar a Senha de App), conceder um acesso especial de teste e conferir que aparece em "Histórico".
5. Só depois de validado local: `git add` / `git commit` / `git push origin main` (deploy automático no Northflank) e configurar `GMAIL_USER`/`GMAIL_APP_PASSWORD`/`APP_URL` nas variáveis de ambiente do Northflank também.

### Sugestões pra evoluir depois (não implementadas ainda, ficam pra quando quiser)
- Disparo automático (ex.: e-mail sozinho pra quem completa 30 dias sem acesso) — hoje é 100% manual de propósito, por decisão sua nesta sessão; dá pra automatizar depois com um job agendado parecido com o de cobranças vencidas.
- Métricas de reengajamento: quantos dos que receberam mensagem voltaram a acessar em X dias — dá pra cruzar `mensagens_enviadas` com `acessos_catraca` depois que houver volume de dados real.
- SMS como canal adicional (hoje só e-mail e WhatsApp manual).
- Segmentação automática por "tempo de casa"/plano, pra personalizar a oferta de recuperação.

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

## Sessão 08/07/2026 (noite) — teste completo da biometria própria da catraca (local) + plano pra produção

**Contexto**: `BIOMETRIA_CATRACA_ATIVA` foi religado no `agente-local` pra testar de verdade contra o `local.db` (banco de teste), com o Secullum antigo temporariamente desativado (não desinstalado) pra não disputar a única conexão TCP que a catraca Henry aceita. Testes feitos com dedos reais de dois cadastros que já tinham biometria vinda do sistema antigo: Robson Junior Reis Lima (`biometria_id` "1") e Academia Superação (`biometria_id` "115", cadastro de teste do próprio usuário).

### 5 bugs encontrados e corrigidos em `agente-local/agente.js` (e um em `agente-local/.env`)

1. **`.env` do agente com `SERVIDOR_HTTP_URL` duplicado** (`SERVIDOR_HTTP_URL=SERVIDOR_HTTP_URL=http://localhost:3000`), causando `Failed to parse URL`. Corrigido manualmente pelo usuário no arquivo.
2. **`connect ETIMEDOUT 192.168.0.79:3000`** ao escutar a catraca — causado pelo Secullum antigo segurando a única conexão TCP que o equipamento aceita por vez. Resolvido desativando (fechando) o Secullum durante o teste.
3. **Extração errada do `biometria_id` do evento bruto**: o código original mandava a string toda do evento (ex.: `"0]00000000000000000001]08/07/2026 09:03:32]1]0]5I"`) pro endpoint de validação, em vez de extrair só o identificador. Corrigido pra pegar o 2º campo (separado por `]`), removendo os zeros à esquerda.
4. **Catraca travava com a mensagem na tela e não girava** mesmo com a biometria reconhecida — o comando usado (`permitirEntrada`, que espera um "index" de confirmação da própria catraca) não é o formato que esse firmware aceita. Trocado pelo comando `liberarAcesso`, o mesmo que o totem (QR/facial) já usa hoje em produção e comprovadamente funciona.
5. **Giro mecânico manual da catraca (sem tocar em nenhum dedo) gerava registro de acesso "fantasma"** atribuído a um aluno aleatório (ex.: "Maria Aparecida Silva Oliveira", que nunca tocou o leitor). Causa: a catraca manda outros tipos de evento pela mesma conexão TCP usada pra ler biometria (ex.: evento de giro), e o código tratava qualquer coisa recebida como se fosse leitura de dedo. Corrigido: eventos onde o campo do identificador vem vazio agora são ignorados por completo (não chamam mais o painel).

### Resultado — validado no `local.db`
Depois das 5 correções, testado contra `local.db` (via `.\rodar-local.ps1`) e confirmado funcionando: toque de dedo real de aluno vinculado abre a catraca de verdade e mostra o nome certo; toque de dedo sem vínculo/inativo nega sem bloquear ninguém (fail-open, como já era); giro manual sem tocar em nada não gera mais registro de acesso indevido.

### Nota sobre uma falsa suspeita desta sessão
Em determinado momento a IA suspeitou (errado) que o servidor local estivesse conectado em produção em vez de `local.db`, com base numa leitura desatualizada do arquivo `local.db` feita pela ponte remota (mesmo problema de cache já visto antes nesta mesma conversa). O usuário confirmou rodando um script direto no próprio PC que o `local.db` estava correto o tempo todo. **Lição pra próximas sessões**: pra conferir dado crítico do `local.db` ou de produção, preferir sempre um comando rodado pelo próprio usuário no PC dele (ground truth) em vez de confiar cegamente numa cópia "espiada" remotamente.

### Arquivos alterados nesta sessão de noite
- `agente-local/agente.js` — as 5 correções acima (extração do id, comando de abertura, filtro de evento de giro).
- `agente-local/.env` — `SERVIDOR_HTTP_URL` corrigido (duplicação removida) e **temporariamente apontando pra `http://localhost:3000`** (endereço de TESTE — precisa voltar pra produção antes de ir ao vivo, ver plano abaixo).
- `scripts/debug-biometria-local.js` — script avulso de conferência rápida, criado só pra resolver a falsa suspeita acima; pode ser apagado quando quiser, não faz parte do sistema.
- **Nada disso foi enviado ao GitHub ainda.**

### ⚠️ PLANO — colocar a biometria da catraca pra funcionar em PRODUÇÃO (ainda NÃO iniciado)

**Pré-requisito**: a produção (Turso) ainda não tem os dados desta frente de trabalho — nem os alunos duplicados foram mesclados lá, nem os `biometria_id` foram importados lá. Isso depende de resolver antes a pendência já registrada mais acima ("⚠️ PENDÊNCIA FUTURA — atualizar a produção (Turso) com a migração v2"). Não dá pra pular direto pra biometria em produção sem aquilo resolvido primeiro.

Ordem sugerida — **cada passo com confirmação explícita do usuário antes de avançar pro próximo**:

1. **Mesclar duplicatas de aluno na produção**, mesmo processo que já rodou no `local.db` (6 pares mesclados via `mesclar-alunos-duplicados.js --aplicar`). Adaptar o script pra aceitar produção deliberadamente (hoje ele fixa `local.db` no código de propósito, seguir o mesmo padrão de segurança da pendência de migração já registrada). `--dry-run` primeiro, revisar, backup do Turso antes de aplicar.
2. **Revisar os casos ambíguos antes de replicar em produção** — resolver no `local.db` primeiro, só depois replicar a mesma decisão em produção:
   - Dupla Mayra/Nayra, CPF `13700311494` — excluída da mesclagem automática (`--excluir-cpf`), precisa comparar telefone/data de nascimento antes de decidir mesclar ou não.
   - ~9 pares "quase-duplicata" que sobraram nos "ambíguos" da importação de biometria (nomes muito parecidos, não pegos pelo critério de CPF exato): Iago Fernando Rodrigues Gomes, Gustavo Julio de Oliveira Chaves, Carlos Davi Cabral, Ramon Brandino de Melo Nascimento, Luciana Melo dos Reis, Maria Natividade Gomes, Jhully do Nascimento dos Santos, Anderson da Silva, José Claudio Rodrigues Gomes.
3. **Importar `biometria_id` na produção** — `importar-biometria-catraca.js` já usa o cliente compartilhado (lê `.env`/`DATABASE_URL`), então basta rodar com produção ativa (via `rodar-producao.ps1` ou equivalente), usando o mesmo `cartao.txt`. `--dry-run` primeiro, revisar vinculados/ambíguos/sem correspondência, só então `--aplicar`.
4. **Rodar `node src/db/migrate.js` em produção** — cria o índice de proteção contra cobrança duplicada (pendência mais antiga, já registrada, sem relação direta com biometria mas na mesma fila de tarefas de produção — aproveitar a janela).
5. **Desligar o Secullum de vez** (hoje só foi desativado temporariamente pra testar) — enquanto continuar instalado e puder ser aberto, volta a disputar a conexão TCP com a catraca e o `ETIMEDOUT` de hoje se repete em produção. Decidir com o usuário: desinstalar ou só garantir que nunca mais é aberto.
6. **Apontar o `agente-local` pra produção de vez**:
   - `SERVIDOR_HTTP_URL` no `agente-local/.env` volta a ser `https://academia--acess--tpff5w2s24vs.code.run`.
   - Conferir que `TERMINAL_TOKEN` no `agente-local/.env` bate exatamente com o do Northflank (produção) — hoje os dois ambientes usam o mesmo valor nesse PC, o que ajudou no teste mas precisa ser confirmado antes de ir ao vivo.
   - `BIOMETRIA_CATRACA_ATIVA=true` permanece.
   - `pm2 kill` + `pm2 start agente.js --name catraca-agente` pra subir limpo com o `.env` novo.
7. **Teste ao vivo com supervisão direta**: pelo menos 2-3 alunos reais tocando o dedo, acompanhando `pm2 logs catraca-agente` e "Acessos recentes" do painel de produção ao mesmo tempo, antes de liberar pro uso normal sem supervisão.
8. **Confirmar que o autostart do PM2 continua ativo** (`pm2-windows-startup`, configurado na sessão de 06/07) — o PC/PM2 foi reiniciado várias vezes durante a depuração de hoje, vale confirmar que ainda sobe sozinho no boot.
9. **Atualizar este arquivo**: mover esta seção pra um bloco "✅ CONCLUÍDO" e tirar o item 5 da lista de pendências de "ESTADO ATUAL", depois de tudo confirmado funcionando em produção.

**Não iniciar nenhum passo desta lista sem decisão e presença explícita do usuário — envolve dado real de aluno e o único ponto de acesso físico da academia.**

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
