# Resumo da sessão — Academia Gestão

Registro do que foi implementado/corrigido nesta sessão e do que ainda falta. Sirva-se disso como checklist de deploy e como guia pra retomar o trabalho depois.

## 1. Cobranças duplicadas (fantasmas) — corrigido

- **Causa raiz**: `gerarCobrancasRecorrentes` (em `src/services/cobrancas.service.js`) usava matemática de dias corridos em vez de meses, gerando cobranças "fantasma" em datas erradas todo mês. Corrigido para usar `somarMesesComDiaAlvo` com o dia de vencimento correto.
- **Limpeza histórica**: script `scripts/limpar-fantasmas-mensalidade.js` identifica e apaga cobranças fantasma nunca pagas (mantém sempre a primeira cobrança do ciclo e a do dia de vencimento correto). Já rodado com sucesso (480 fantasmas removidos, 0 bloqueados por segurança).

## 2. Botão "Gerar Contas a Receber" (estilo Secullum)

- `GET/POST /api/pagamentos/gerar-recorrentes` — dispara a rotina manualmente (só admin) e mostra a data/quantidade da última geração.
- Botão equivalente no painel, em Contas a Receber.

## 3. Pagamento Rápido (recepção)

- Nova seção no menu — busca aluno por **nome** (autocomplete), mostra status de acesso e contas em aberto, reaproveitando o modal de pagamento já existente.

## 4. Módulo de Treino

- Tabelas `treinos` / `treino_exercicios` (schema.sql) + rotas `src/routes/treinos.routes.js` (CRUD completo).
- Aba "Treino" no perfil do aluno: modo **nativo** (abas de treino, exercícios com série/carga/intervalo/observação, dias da semana) ou **app externo** (link configurável em Configurações, `treino_app_url`).
- Campo `alunos.treino_modo` (`nativo` | `app_externo`), configurável por aluno.

## 5. Bugs corrigidos

- **Data de pagamento "1 dia antes"**: `new Date("YYYY-MM-DD")` é interpretado como UTC e exibia a data errada no fuso do Brasil. Corrigido com `formatarDataOuDataHora`/`hojeLocalISO` (sem passar por conversão UTC).
- **Pagamento duplicado em conta já quitada**: backend agora rejeita novo pagamento se a conta já estiver `paga` (precisa remover a quitação antes). Frontend esconde o botão "+ Adicionar pagamento" quando quitada.
- **Desconto no plano**: campos `desconto_tipo` (percentual/valor), `desconto_percentual`, `desconto_valor_centavos`, `desconto_forma_pagamento` em `planos` — configurável na criação/edição do plano.

## 6. Totem de auto atendimento

- **Câmera sempre visível**: o resultado (liberado/negado) agora aparece como overlay por cima do próprio vídeo (`public/terminal.html`/`terminal.js`), sem nunca desligar a câmera — inclusive nos casos de "acesso negado - mensalidades em atraso".
- **Pagar contas em atraso pelo totem**: consulta por CPF, seleciona uma ou várias contas vencidas, paga tudo num único Pix (Mercado Pago), com confirmação por polling e liberação automática da catraca ao final. Botão "Pagar contas em atraso" aparece automaticamente no overlay de acesso negado por atraso.
- Nova tabela `pagamentos_totem` (pagamento agregado, cobre várias cobranças por um único Pix) e serviço compartilhado `src/services/pagamentoContas.service.js`.

## 7. Portal remoto do aluno (`/portal.html`)

- Acessível de fora da academia (sem instalar nada, sem login) — identificação só por CPF, mesmo princípio de confiança do totem físico.
- **Nunca aciona a catraca**, mesmo depois de pagamento confirmado.
- Funções: consulta e pagamento de contas em atraso (mesmo serviço do totem), consulta de treino (lista nativa ou link do app externo), troca/assinatura de novo plano (Pix), cadastro novo (dados + plano + Pix), cadastro de reconhecimento facial remoto (câmera do celular/PC), e "Agendar avaliação" via link do WhatsApp da recepção (configurável em Configurações → `whatsapp_contato`).
- Link do portal pronto pra copiar/divulgar em Configurações → "Link do portal do aluno".
- **Nota de segurança**: como é uma página pública, não há segredo embutido possível — a identificação usa só o CPF (aceito conscientemente, mesmo modelo do totem). Se precisar de mais privacidade no futuro, dá pra acrescentar um segundo fator (WhatsApp/SMS) sem mudar o resto.

## 8. Melhorias em Contas a Receber / Matrículas

- "Incluir conta" (tanto na tela Contas a Receber quanto na aba Financeiro do perfil) agora tem um seletor de **Plano existente** — escolher um já preenche descrição e valor; "Personalizado" mantém a digitação livre.
- Modal de edição de conta ganhou os botões **"Marcar como atrasada"** / **"Marcar como pendente"** — força o status sem precisar mexer no vencimento ou esperar o cron rodar (útil pra testar bloqueio de acesso, totem, portal).
- Aba Matrículas do perfil ganhou botão **"Cancelar"** por matrícula ativa (mesmo efeito de `PATCH /api/planos/matriculas/:id/status`).

## 9. Bug crítico no `migrate.js` (corrigido)

- `src/db/migrate.js` quebra o `schema.sql` inteiro em pedaços a cada `;` encontrado — inclusive `;` usados como pontuação normal dentro de comentários em português. Isso causava `SQL_PARSE_ERROR: SQL string does not contain any statement` e impedia a criação de tabelas novas (como `pagamentos_totem`).
- Corrigido removendo os `;` de dentro dos comentários do `schema.sql`. **Lição pra manutenção futura**: nunca usar `;` dentro de comentários SQL neste projeto — trocar por vírgula ou travessão.

## 10. Interferência do agente na biometria da catraca + cobranças duplicadas de julho/2026 (2026-07-07)

- **Causa raiz da interferência no leitor da catraca**: `agente-local/agente.js` tem um recurso experimental (`BIOMETRIA_CATRACA_ATIVA=true`) que fica escutando os eventos de biometria da própria catraca (`henry.escutar()`) e, se o academia-gestao não reconhece o `biometria_id` (era 100% dos casos — nenhum aluno tinha isso cadastrado ainda), mandava `impedir_entrada` de volta pra catraca — bloqueando ativamente gente que a catraca já tinha reconhecido pela digital, além de disputar a conexão TCP com o sistema antigo (Secullum), que também fala com o mesmo equipamento.
- **Corrigido**: `loopBiometria()` agora é *fail-open* — quando não reconhece o `biometria_id`, só registra em log/Acessos recentes, nunca mais manda `impedir_entrada`.
- **Importação do vínculo `biometria_id`**: novo script `scripts/importar-biometria-catraca.js` — lê um export bruto da própria catraca (`scripts/data/cartao.txt`, protocolo Henry: identificador + nome truncado em 20 caracteres) e casa por nome normalizado com os alunos já cadastrados. Rodado em dry-run: 1181 vínculos confiáveis (prontos pra aplicar/já aplicados — conferir), 30 ambíguos (nome batendo com mais de 1 aluno — a maioria são contas de aluno genuinamente duplicadas, ver pendências abaixo) e 31 sem correspondência (maioria cartão de teste/admin da catraca, não é aluno de verdade).
- **Cobranças de julho/2026 duplicadas**: 7 alunos tinham a mesma mensalidade contada duas vezes — uma cópia `legado` (vinda junto da migração do Secullum, sem `matricula_id`) e outra `recorrencia` (gerada pelo próprio academia-gestao, ligada à matrícula). Duas dessas cópias `legado` estavam com status `atrasado`, bloqueando acesso desses 2 alunos por uma cobrança fantasma. Diagnosticado com `scripts/diagnosticar-duplicatas-mes.js` e `scripts/diagnosticar-legado-vs-recorrencia.js`, removido com `scripts/limpar-legado-vs-recorrencia.js` (mantendo sempre a cópia `recorrencia`, que é a que sustenta a renovação automática dos próximos ciclos).
- **Proteção contra repetição**: índice único `idx_cobrancas_recorrencia_matricula_vencimento` (`matricula_id` + `vencimento`, só entre `provedor = 'recorrencia'`) no `schema.sql`, e `criarCobrancaDoCiclo` (em `cobrancas.service.js`) agora usa `INSERT OR IGNORE`. Suspeita da causa: o servidor reinicia e roda `gerarCobrancasRecorrentes` de novo a cada subida — essa semana ele reiniciou várias vezes por causa dos ajustes de segurança, e dois reinícios muito próximos podem ter corrido em paralelo. Com o índice novo, se isso acontecer de novo o segundo INSERT é ignorado em vez de duplicar.
- **Achado à parte, ainda NÃO aplicado**: 32 grupos (33 linhas) de cobranças `legado` duplicadas bem mais antigas (2021–2025) — pelo horário de criação, parecem ser duplicata que já existia no próprio Secullum (lançamento repetido na época), não um bug da migração. Diagnóstico em `scripts/diagnosticar-duplicatas-migracao.js`, limpeza pronta em `scripts/limpar-duplicatas-migracao.js` (dry-run já revisado), só falta decidir se aplica.

---

# Próximos passos / pendências

## Já combinado, ainda não implementado

1. **Configuração de aviso de cobrança** (task #23) — disparo automático/agendado/desativado, edição de mensagem, envio de oferta/link de upgrade. **Bloqueado em uma decisão sua**: qual provedor de WhatsApp usar (ainda não escolhido — posso pesquisar e recomendar Z-API, Evolution API, etc. quando quiser seguir).
2. **Lembrete de renovação de avaliação** (task #24) — aviso por WhatsApp quando a avaliação física (validade 90 dias) estiver perto de vencer, com link de agendamento. Depende do item 1.

## Pendências abertas nesta sessão (2026-07-07)

3. **Rodar `node src/db/migrate.js` de novo** — falhou por timeout de rede (`ConnectTimeoutError` no Turso) na última tentativa; o índice de proteção contra cobrança duplicada (item 10 acima) ainda não foi criado no banco.
4. **`git push` de tudo** — `agente-local/agente.js`, os scripts novos (`scripts/importar-biometria-catraca.js`, `scripts/diagnosticar-duplicatas-migracao.js`, `scripts/limpar-duplicatas-migracao.js`, `scripts/diagnosticar-duplicatas-mes.js`, `scripts/diagnosticar-legado-vs-recorrencia.js`, `scripts/limpar-legado-vs-recorrencia.js`), `schema.sql`, `cobrancas.service.js` e `package.json`. O Northflank só passa a usar a proteção nova (`INSERT OR IGNORE`) depois do deploy.
5. **Confirmar se `node scripts/importar-biometria-catraca.js --aplicar` já rodou** — o dry-run foi revisado e aprovado, mas não ficou confirmado se a aplicação de verdade (gravando os 1181 `biometria_id`) chegou a rodar.
6. **Decidir os 30 "ambíguos" da importação de biometria** — vários batem com o **mesmo CPF** em dois `aluno_id` diferentes (ex.: Iago Fernando Rodrigues Gomes, José Rivandro Kauan Ramalho Cabral, Rikely Carla Gomes Marcelino, entre outros). Isso é achado colateral: são contas de **aluno** genuinamente duplicadas (não cobrança) — provavelmente da mesma causa raiz da migração do Secullum ter sido processada mais de uma vez para essas pessoas específicas. Precisa de um script de fusão (migra matrícula/cobrança/histórico pro cadastro que vai ficar, só depois apaga o duplicado) antes de decidir o vínculo de biometria desses 30 casos.
7. **Decidir se aplica a limpeza das 33 cobranças `legado` duplicadas antigas (2021–2025)** — script pronto (`scripts/limpar-duplicatas-migracao.js`), dry-run já revisado, só falta `--aplicar`.
8. **Religar `BIOMETRIA_CATRACA_ATIVA=true`** no `.env` do `agente-local`, só depois de tudo acima confirmado — testar com cautela (o próprio README do agente já avisava: nunca tinha sido testado contra hardware real antes desta sessão) e confirmar com a recepção que o Secullum parou de acusar "biometria não localizada".

## Investigações antigas, ainda pendentes

9. **Regras de vencimento configuráveis** para cobranças recorrentes (task #17) — hoje o dia de vencimento é fixo por lógica; avaliar se precisa virar configurável por plano/matrícula.

## Deploy

- **`npm run migrate` rodou com sucesso numa sessão anterior** (schema atualizado, incluindo `pagamentos_totem`) — mas o índice novo desta sessão (item 3 acima) ainda não foi criado, por causa do timeout de rede.
- **Confirme que o `git push` das mudanças foi feito** (item 4 acima) — se o painel/totem em produção rodam a partir de um deploy na nuvem, o código só passa a valer depois do push.

## Instruções úteis

- **Rodar migrations**: `node src/db/migrate.js` (evite `npm run migrate` se precisar capturar a saída num arquivo — o wrapper do npm às vezes trunca a saída ao redirecionar no PowerShell).
- **Testar o totem**: acesse `terminal.html` no dispositivo/rede do totem. Pra simular uma conta em atraso sem esperar o vencimento passar, use "Marcar como atrasada" no modal de edição da conta (painel admin).
- **Portal do aluno**: `/portal.html` — link copiável em Configurações. Configure `whatsapp_contato` (Configurações) pra habilitar o botão de agendamento de avaliação.
- **Treino em app externo**: configure `treino_app_url` em Configurações pra alunos com `treino_modo = app_externo`.
