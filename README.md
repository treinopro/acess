# Academia Gestão — MVP

API de gestão de alunos para academias e estúdios: cadastro de alunos, planos/matrículas, agendamento de aulas com check-in, e cobrança recorrente (Mercado Pago / InfinitePay).

Stack: Node.js + Express + libSQL (SQLite local ou Turso na nuvem).

## 1. Rodando 100% local (sem conta na nuvem)

```bash
cd academia-gestao
npm install
cp .env.example .env
# não precisa mudar nada no .env para rodar local: DATABASE_URL=file:./local.db já funciona

npm run migrate   # cria as tabelas em local.db (também aplica novas colunas/tabelas em bancos já existentes)
npm run seed       # cria usuário admin@academia.com / admin123 e um plano de exemplo
npm run dev         # sobe em http://localhost:3000
```

Abra `http://localhost:3000` no navegador para usar o painel administrativo (login, alunos, planos, agenda, contas a receber, usuários). Se você já tinha o projeto rodando antes das telas terem sido adicionadas, rode `npm run migrate` de novo — é seguro rodar quantas vezes quiser, ele só aplica o que ainda falta.

Teste rápido:

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@academia.com","senha":"admin123"}'
```

## 2. Subindo para o GitHub

```bash
git init
git add .
git commit -m "MVP inicial - gestão de alunos"
git branch -M main
git remote add origin https://github.com/<seu-usuario>/academia-gestao.git
git push -u origin main
```

O `.gitignore` já exclui `node_modules`, `.env` e o banco local (`local.db`) — nada sensível vai para o repositório.

## 3. Banco de dados persistente com Turso

O Turso oferece um plano gratuito de SQLite distribuído, compatível com o mesmo cliente usado localmente.

```bash
# instalar CLI (uma vez)
curl -sSfL https://get.tur.so/install.sh | bash

turso auth login
turso db create academia-gestao
turso db show academia-gestao --url          # copie para DATABASE_URL
turso db tokens create academia-gestao         # copie para DATABASE_AUTH_TOKEN
```

Cole os dois valores no `.env` (local) e, para produção, nas variáveis de ambiente do Render (passo 4). Depois rode a migração apontando para o Turso:

```bash
npm run migrate
```

## 4. Deploy no Render

Opção A — Blueprint automático (usa o `render.yaml` já incluso):

1. Suba o projeto no GitHub (passo 2).
2. No Render, clique em **New > Blueprint** e selecione o repositório.
3. O Render lê `render.yaml` e cria o serviço web automaticamente.
4. Preencha manualmente as variáveis marcadas `sync: false`: `DATABASE_URL`, `DATABASE_AUTH_TOKEN` (do Turso) e as credenciais de pagamento.
5. Deploy. O `startCommand` já roda a migração (`npm run migrate`) antes de iniciar o servidor.

Opção B — manual: New > Web Service, conectar o repo, build command `npm install`, start command `npm start`, e configurar as mesmas variáveis de ambiente do `.env.example`.

## 5. Integração de pagamentos

O provedor ativo é controlado por `PAYMENT_PROVIDER` no `.env` (`mercadopago` ou `infinitepay`). Os dois podem coexistir — a rota `POST /api/pagamentos/cobrar` aceita `provedor` por requisição.

### Mercado Pago

1. Crie uma aplicação em [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/overview) e gere um Access Token.
2. Preencha `MERCADOPAGO_ACCESS_TOKEN` no `.env`.
3. Configure a URL de webhook no painel do Mercado Pago apontando para `https://seu-dominio/api/pagamentos/webhook/mercadopago`.
4. Para cobrança recorrente de verdade (assinaturas), veja [docs de Assinaturas](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/overview) — o scaffold atual usa Checkout Pro (cobrança avulsa por link); o módulo em `src/services/payment/mercadopago.service.js` é o ponto de extensão para trocar por `preapproval` (assinaturas).

### InfinitePay (InfinityPay)

1. Pegue sua InfiniteTag (handle) no app/dashboard da InfinitePay.
2. Preencha `INFINITEPAY_HANDLE` no `.env` (sem o `$`).
3. Defina `INFINITEPAY_WEBHOOK_URL` apontando para `https://seu-dominio/api/pagamentos/webhook/infinitepay`.
4. Documentação oficial: [infinitepay.io/checkout-documentacao](https://www.infinitepay.io/checkout-documentacao).

## 6. Endpoints principais

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/login` | Login (retorna JWT) |
| GET/POST/PUT/DELETE | `/api/alunos` | CRUD de alunos |
| PATCH | `/api/alunos/:id/status` | Ativo/inativo/trancado/inadimplente |
| GET | `/api/alunos/:id/perfil` | Perfil completo (dados, anamnese, avaliações, matrículas, agendamentos, cobranças) |
| PATCH/DELETE | `/api/alunos/:id/biometria` | Cadastra/remove o ID de referência do leitor biométrico/catraca |
| PATCH | `/api/alunos/:id/codigo-acesso` | Gera/regenera o código do QR pessoal ("meu acesso") do aluno |
| DELETE | `/api/alunos/:id/face` | Remove o reconhecimento facial cadastrado (permite recadastrar) |
| PUT | `/api/alunos/:id/anamnese` | Cria ou atualiza a anamnese (saúde) |
| GET/POST | `/api/alunos/:id/avaliacoes` | Histórico de avaliações físicas (peso, medidas, % gordura) |
| DELETE | `/api/alunos/avaliacoes/:id` | Remove uma avaliação física |
| GET/POST/PUT/DELETE | `/api/planos` | CRUD de planos (exclusão bloqueada se houver matrículas vinculadas) |
| PATCH | `/api/planos/:id/desativar` \| `/reativar` | Ativa/desativa sem excluir |
| POST | `/api/planos/matricular` | Matricula aluno em um plano (bloqueia duplicata e já gera a 1ª cobrança) |
| GET | `/api/planos/matriculas` | Lista matrículas |
| PATCH | `/api/planos/matriculas/:id/status` | Cancela/tranca/reativa uma matrícula (interrompe a recorrência) |
| GET/POST | `/api/agendamentos/turmas` | Turmas/horários |
| GET/POST | `/api/agendamentos` | Lista/marca aula (respeita capacidade máxima) |
| POST | `/api/agendamentos/checkin` | Check-in (QR code, catraca, app, manual) |
| POST | `/api/pagamentos/cobrar` | Gera cobrança + link de pagamento (Mercado Pago/InfinitePay) |
| GET/POST/PUT/DELETE | `/api/pagamentos/cobrancas` | Contas a receber: busca por aluno/status, cadastro manual, edição, exclusão |
| POST | `/api/pagamentos/webhook/mercadopago` | Webhook Mercado Pago |
| POST | `/api/pagamentos/webhook/infinitepay` | Webhook InfinitePay |
| GET/POST/PATCH/DELETE | `/api/usuarios` | Gestão de usuários do sistema (somente admin) |

Todas as rotas exceto `/health`, `/api/auth/login` e os webhooks exigem header `Authorization: Bearer <token>`. As rotas de `/api/usuarios` exigem, além disso, que o usuário logado tenha `papel = admin`.

## 7. Biometria e integração com catracas

O campo `biometria_id` em cada aluno guarda apenas uma referência (ID/hash) gerada pelo leitor biométrico ou software da catraca — o app não captura nem armazena o template biométrico em si, pois isso depende do SDK proprietário de cada fabricante (ZKTeco, Control iD, etc.). Fluxo sugerido: cadastre o aluno no leitor/catraca, copie o ID retornado por ele e cole no campo "Biometria" do perfil do aluno (ou envie via `PATCH /api/alunos/:id/biometria`) para linkar os dois cadastros.

## 8. Cobrança recorrente automática

Ao matricular um aluno em um plano (`POST /api/planos/matricular`):

- Se o aluno já tiver uma matrícula **ativa** no mesmo plano, a API recusa com erro 409 (evita matrícula duplicada).
- A primeira cobrança do ciclo é criada automaticamente em "Contas a Receber" (vencimento = data de início).
- Para planos recorrentes (`mensal`, `trimestral`, `semestral`, `anual`) com renovação automática habilitada, as próximas mensalidades são geradas sozinhas por um job de recorrência (`src/jobs/recorrencia.js`), que roda:
  - uma vez toda vez que o servidor sobe;
  - e depois a cada 24h, enquanto o processo continuar no ar (`setInterval` em `src/server.js`).
- Planos `avulso` e `pacote_aulas` não geram renovação — é cobrança única.
- Para cancelar a renovação de um aluno, use o botão "Cancelar" na tabela de Matrículas (ou `PATCH /api/planos/matriculas/:id/status` com `{"status":"cancelada"}`). Isso interrompe a geração de novas cobranças para aquela matrícula.

**Nota sobre produção:** em serviços "free tier" do Render o servidor pode dormir por inatividade, o que pausa o `setInterval`. Para garantir que a recorrência rode mesmo assim, configure um **Render Cron Job** (ou qualquer scheduler externo) para chamar `npm run gerar-cobrancas` uma vez por dia — o comando é idempotente, então rodar mais de uma vez no mesmo dia não duplica cobranças.

## 9. Integração com a catraca Henry (TCP/IP) — funciona local E na nuvem

Em vez de depender do Secullum Academia.Net ou do Kernel7x.dll (COM), o sistema fala diretamente o protocolo proprietário da Henry (linha 7x: Primme Acesso 8X, Primme Acesso SF, Argos) por socket TCP — porta padrão **3000**. Implementação de baixo nível em `src/services/henryCatraca.service.js`:

- `liberarAcesso({ ip, port, mensagem })` — abre a catraca diretamente (fluxo do terminal/kiosk: após confirmar matrícula/pagamento do aluno).
- `permitirEntrada` / `impedirEntrada` — confirma ou bloqueia a passagem depois que a própria catraca captura um evento (cartão/biometria do equipamento) via `escutar()`.
- `escutar({ ip, port })` — escuta bloqueante do próximo evento enviado pela catraca.
- `testarConexao({ ip, port })` — apenas testa se a porta está acessível.

**Nenhuma rota/serviço chama `henryCatraca.service.js` diretamente.** Todos passam por `src/services/catracaGateway.service.js`, que decide sozinho, a cada chamada, qual dos dois modos usar:

| Modo | Quando é usado | Como funciona |
|---|---|---|
| **Direto** | Nenhum agente local conectado (ex.: servidor rodando localmente, na mesma rede da catraca) | Fala TCP direto daqui mesmo, via `henryCatraca.service.js`. Zero configuração extra — é o que já funcionava antes. |
| **Agente** | Um agente local está conectado (ver pasta `agente-local/` na raiz do repositório) | O comando é repassado por WebSocket até o agente, que fala TCP com a catraca de dentro da rede da academia, e devolve o resultado. Necessário quando o painel está hospedado na nuvem (Northflank/Render) — a nuvem não alcança o IP privado da catraca (ex.: `192.168.0.79`). |

A troca entre os dois modos é automática e transparente — nenhuma tela do painel muda. `GET /api/terminal/catraca/testar` devolve um campo `modo` (`"direto"` ou `"agente"`) indicando qual foi usado naquele teste, e `GET /api/terminal/catraca/agente/status` (admin) devolve `{ conectado, conectado_desde, ultimo_pong, modo }` a qualquer momento.

Configure `HENRY_CATRACA_IP` e `HENRY_CATRACA_PORT` no `.env` do servidor (usado como padrão quando a "Configuração avançada" do painel fica em branco) e, se o painel estiver na nuvem, também `AGENTE_TOKEN` (string aleatória — precisa ser **igual** à configurada no `.env` do agente local). Ver `agente-local/README.md` para instalar e rodar o agente num PC da academia.

Rotas relevantes (somente admin), em `src/routes/terminal.routes.js`:

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/terminal/catraca/testar?ip=&port=` | Testa conectividade (direto ou via agente) — resposta inclui `modo` |
| GET | `/api/terminal/catraca/agente/status` | Status da conexão do agente local |
| POST | `/api/terminal/catraca/liberar` | Dispara abertura manual (teste de campo) — body opcional `{ ip, port, mensagem }` |

**Nota:** o protocolo foi portado a partir da especificação pública do protocolo Henry Primme Acesso/Argos (mesma família usada pelo Kernel7x/Secullum). Se seu modelo específico usar comandos diferentes, ajuste as strings de comando em `henryCatraca.service.js` (e no arquivo equivalente em `agente-local/henryCatraca.js`) conforme o manual do equipamento. Ainda falta testar contra a catraca real (assim que houver acesso de rede a ela).

**Arquitetura (nuvem + agente local):** implementada em `src/services/agenteGateway.service.js` (servidor WebSocket embutido no mesmo processo/porta do Express, path `/agente/socket`) + `src/services/catracaGateway.service.js` (abstração usada por toda a aplicação) + a pasta `agente-local/` (programa standalone que roda no PC da academia). O agente conecta DE DENTRO da rede local PARA a nuvem (WebSocket de saída) — por isso não é preciso abrir porta nenhuma no roteador da academia.

## 10. Totem de auto atendimento (`/terminal.html`)

Tela de identificação para o aluno liberar sua própria entrada, pensada para rodar num tablet/PC ao lado da catraca. Cobre os 4 métodos de identificação já implementados para alunos **existentes**: CPF, QR pessoal lido da tela do celular, reconhecimento facial recorrente, e biometria própria da catraca (ver abaixo). Auto cadastro + pagamento de aluno novo direto pelo totem ainda **não** foi implementado (fica como próxima fase — hoje o totem mostra um aviso "em construção" e direciona para a recepção).

### Como configurar

1. Defina `TERMINAL_TOKEN` no `.env` do servidor (uma string longa aleatória — é o segredo que autentica o totem, já que o aluno não faz login).
2. Abra `public/terminal.js` e troque a constante `TERMINAL_TOKEN` no topo do arquivo pelo **mesmo valor**. Esse token fica visível a quem inspecionar o código do totem — por isso o dispositivo precisa ficar fisicamente controlado (ao lado da catraca, sem acesso público ao teclado/console).
3. Acesse `http://<servidor>:3000/terminal.html` no dispositivo do totem.

### Métodos de identificação (aluno já cadastrado)

A tela inicial do totem mantém a câmera sempre ligada e escaneando em segundo plano (rosto e QR ao mesmo tempo, a cada ~600ms) — não precisa clicar em nada, o aluno só se aproxima ou mostra o celular. O campo de CPF fica sempre visível ao lado, como alternativa manual pra quem ainda não tem rosto/QR cadastrado.

| Método | Como funciona |
|---|---|
| Reconhecimento facial | A webcam do totem compara o rosto ao vivo (via face-api.js, rodando no navegador) contra o descritor facial cadastrado (`alunos.face_descriptor`), continuamente, sem precisar tocar na tela. Limiar de similaridade configurável via `FACE_MATCH_THRESHOLD` no `.env` (padrão `0.65`). |
| QR do celular | O aluno recebe um link pessoal (`/meu-acesso.html?codigo=...`) uma vez, salva no celular, e mostra o QR pra mesma webcam (lido com jsQR) nas próximas visitas — reconhecido no mesmo loop contínuo, sem tela separada. |
| CPF | Digita o CPF no campo sempre visível na tela inicial; fallback mais simples, sem hardware extra. |
| Biometria da própria catraca | Se a catraca tiver leitor de digital embutido, ela mesma captura e envia o evento por TCP (`escutar()`); o servidor só valida via `POST /api/terminal/validar-biometria-catraca`. Depende do agente local para responder `permitir_entrada`/`impedir_entrada` de volta à catraca. |

Depois de qualquer tentativa (liberada ou negada), a tela de resultado aparece por ~3 segundos e o totem volta sozinho a escanear — se chegar outra pessoa na sequência, ele já está tentando reconhecer, sem precisar de nenhum clique.

Alunos cadastrados **antes** de o totem existir ainda não têm QR/rosto vinculados — usam o botão "Primeira vez no totem" na tela inicial (`GET /api/terminal/vincular/codigo?cpf=`, `POST /api/terminal/vincular/facial`) para vincular um desses métodos usando o CPF como prova inicial de identidade.

Toda tentativa de acesso (liberado ou negado, por qualquer método) fica registrada em `acessos_catraca`, consultável por staff em `GET /api/terminal/acessos?aluno_id=` (admin).

**Dependências externas hospedadas localmente:** `terminal.html` e `meu-acesso.html` usam `qrcodejs`, `jsQR` e `face-api.js` (com os pesos do modelo) a partir de `public/vendor/`, servidos pelo próprio `express.static` — não dependem de internet no dispositivo do totem. Rode este script **uma vez**, num PC com internet (pode ser o mesmo do servidor), para popular essa pasta:

```powershell
$base = ".\public\vendor"
New-Item -ItemType Directory -Force -Path "$base\face-api\weights" | Out-Null

Invoke-WebRequest -Uri "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js" -OutFile "$base\qrcode.min.js"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js" -OutFile "$base\jsQR.js"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js" -OutFile "$base\face-api\face-api.min.js"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights/tiny_face_detector_model-shard1" -OutFile "$base\face-api\weights\tiny_face_detector_model-shard1"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights/face_landmark_68_model-shard1" -OutFile "$base\face-api\weights\face_landmark_68_model-shard1"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights/face_recognition_model-shard1" -OutFile "$base\face-api\weights\face_recognition_model-shard1"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights/face_recognition_model-shard2" -OutFile "$base\face-api\weights\face_recognition_model-shard2"
```

Rode a partir da pasta `academia-gestao` (onde fica a pasta `public`). Os 3 arquivos de manifesto (`*-weights_manifest.json`) já vêm prontos no repositório — só faltam os binários acima (não são texto, por isso precisam de download em vez de serem gerados diretamente).

## 11. Próximos passos sugeridos

Auto cadastro + pagamento (QR code/maquininha InfinitePay) direto pelo totem para alunos novos, cartão RFID como método de acesso adicional, notificações automáticas (WhatsApp/e-mail), relatórios de frequência/faturamento/churn, assinatura recorrente real (Mercado Pago Subscriptions), app do aluno, e regras de LGPD para os dados de anamnese/avaliação física/reconhecimento facial (tabelas `anamneses`, `avaliacoes_fisicas` e `alunos.face_descriptor`) — ver o documento de planejamento para o roteiro completo por fases. (Agente local para a arquitetura nuvem+catraca já foi implementado — ver seção 9 e `agente-local/README.md`; falta apenas testar contra a catraca física real.)

**Biometria cadastrada direto no leitor da catraca:** hoje o campo `alunos.biometria_id` só guarda um ID que foi cadastrado manualmente no leitor da própria catraca (pelo software/menu dela) e colado no painel. Para cadastrar a digital *pelo nosso sistema* — seja na hora da matrícula, seja depois pelo painel — seria preciso implementar o comando de cadastro de biometria do protocolo Henry (colocar a catraca em "modo cadastro", capturar o índice/template retornado e gravar em `biometria_id`). Ainda não está mapeado qual comando TCP faz isso neste modelo; verificar no manual do protocolo Henry ou com o suporte Primme/Henry antes de implementar.
