# Início rápido — Academia Gestão

Leia isto primeiro ao começar uma sessão nova. Pra histórico completo (por que cada coisa é como é, sessão por sessão), veja **[STATUS-PROJETO.md](STATUS-PROJETO.md)**.

## O que é

Sistema de gestão pra academia: alunos, matrículas, cobranças (Pix via Mercado Pago), catraca física (Henry, via agente local), reconhecimento facial (totem + portal remoto), relatórios. Node/Express + libSQL (Turso) no backend, front-end vanilla JS servido como arquivos estáticos (sem build/bundler).

## Onde está publicado

- App: `https://academia--acess--tpff5w2s24vs.code.run`
- Totem: `.../terminal.html` · Painel admin: `/` (login por e-mail) · Portal do aluno: `.../portal.html`
- Repositório: GitHub `treinopro/acess`, branch `main`
- **Deploy é automático**: `git push origin main` → Northflank redeploya sozinho. Não existe upload manual.
- Banco: Turso (libSQL), configurado direto no painel do Northflank (não lê o `.env` deste PC).

## ⚠️ Regra de segurança mais importante deste projeto

`npm start`/`npm run dev` neste PC **deveriam** cair por padrão no **`local.db`** (arquivo de teste local), NÃO em produção. Isso existe por causa de um incidente real (cobrança fantasma gerada em produção por engano, ver "Sessão 08/07/2026" em STATUS-PROJETO.md).

- Testar/desenvolver no dia a dia → `npm start` normal, sem se preocupar.
- Mexer em produção de propósito (migração, diagnóstico, correção pontual) → `scripts/rodar-producao.ps1`, que pede confirmação digitada ("SIM") e avisa em vermelho enquanto estiver conectado.
- **Nunca editar o `.env` na mão** pra alternar entre os dois.

**⚠️ ATENÇÃO (achado em 11/08/2026, ainda não resolvido)**: conferido o `.env` deste PC e a linha `DATABASE_URL` ATIVA hoje é a do Turso de produção — a linha `file:./local.db` está comentada. Ou seja, **`npm start`/`npm run migrate` neste PC caem direto em produção agora**, contrariando a regra acima. Não mexi no `.env` (não é decisão técnica pra tomar sozinho — o comentário ao lado da linha sugere que foi proposital, "pra rodar localmente e acessar pela nuvem sempre refletirem os mesmos dados"). Confirme com o dono do sistema se é assim mesmo que deveria estar antes de rodar `npm start`/`migrate` achando que está em `local.db` — ver "Sessão 11/08/2026" em STATUS-PROJETO.md.

## Como trabalhar neste projeto (convenção já estabelecida com o dono do sistema)

1. Investigar/implementar a mudança.
2. Perguntar explicitamente **"quer que eu comite?"** antes de `git add` — sempre arquivos específicos (`git add arquivo1 arquivo2`), **nunca `-A` nem `.`**.
3. Perguntar explicitamente **"quer que eu envie pro GitHub?"** antes de `git push` — é um passo separado do commit, sempre confirmado à parte.
4. Autorizações são por ação — uma confirmação não vale pras próximas.

## Pendências reais agora (atualizado 11/08/2026)

**Mudanças locais não commitadas** (existem na pasta do projeto neste PC, mas nunca foram enviadas ao GitHub — então não estão em produção nem em nenhum outro clone do repositório):

| Arquivo(s) | O que faz | De quando |
|---|---|---|
| `public/facial-guiado.js` | Corrige a foto de perfil capturada "olhando pra baixo" no cadastro facial guiado — usa a foto do passo "centro" (frontal confirmada) como referência em vez do quadro exato de um timeout | Sessão de reconhecimento facial (antes de 04/08) |
| `scripts/migrar-contas-pagar-secullum.js` | Script (não rastreado pelo git) que migrou 1011 contas a pagar históricas do Secullum — **já rodado com sucesso em produção**, só o próprio script nunca foi commitado | Sessão de Contas a Pagar/Balanço |
| `public/liberacao-rapida.html`/`.js` | Esconde o link "Abrir painel completo" pro papel recepção quando acessado por celular/tablet | Sessão 22/07/2026 (já documentada como pendente lá) |

*(`src/db/migrate.js` saiu desta lista em 11/08/2026: a linha pendente `secullum_id` acabou commitada junto com o módulo de treinos, sem querer — mesmo padrão de bundling descrito abaixo. Sem risco, a coluna já existe em produção. Ver "Sessão 11/08/2026" em STATUS-PROJETO.md.)*

**Atenção pra próxima sessão que for commitar algum desses arquivos**: `git add <arquivo>` sobe o arquivo INTEIRO, não só as linhas que você acabou de mexer — se o arquivo já tinha uma mudança pendente de outra sessão (como listado acima), ela vai junto no commit sem querer. **Isso já aconteceu** (07/08/2026): a correção do saldo do Balanço somando desde 1970, que estava nesta tabela, foi commitada/enviada junto com uma mudança não relacionada em `contasPagar.routes.js` porque ninguém rodou `git diff <arquivo>` antes — ver "Sessão 07/08/2026" item 5 em STATUS-PROJETO.md. Sempre rodar `git diff <arquivo>` ANTES de editar um arquivo que aparece nesta lista, pra saber exatamente o que já está pendente nele antes de somar uma mudança nova.

Antes de mexer nesses arquivos numa sessão nova: confira com `git diff <arquivo>` se ainda estão do jeito descrito acima, e pergunte ao dono do sistema se quer commitar/enviar antes de continuar — pra não perder esse trabalho nem misturar com uma mudança nova sem querer.

**Se "reconhecimento confundindo pessoas" voltar a acontecer**: desde 04/08 os acessos liberados por rosto também gravam a similaridade/margem no log (antes só os negados) — consulte esse dado antes de decidir mexer em `FACE_MATCH_LIMIAR_COSSENO`/`FACE_MATCH_MARGEM_MINIMA_COSSENO` (ver "Sessão 04/08/2026" em STATUS-PROJETO.md pro porquê de não termos mexido nisso às cegas).

**Trabalho recente fora desta linha de sessões**: em 05/08/2026 a avaliação física passou a usar um sistema separado ("AvaliaPro") — commits `cb76dc6`/`e245a9c`, não documentado a fundo nos arquivos deste projeto. Conferir as mensagens desses commits se for mexer em avaliação física.

## Onde cavar mais fundo

- **STATUS-PROJETO.md** — histórico completo, sessão por sessão, com o "porquê" de cada decisão técnica.
- **Reconhecimento facial**: `public/facial-guiado.js` (mecanismo único compartilhado), `public/facial-sface.js` (embedding SFace/OpenCV Zoo), `src/services/acessoTerminal.service.js` (matching 1:N, limiares).
- **Catraca física**: `agente-local/` (processo separado, roda no PC da recepção, fala com a Henry via TCP ou interface web dela), `src/services/catracaGateway.service.js` (lado do academia-gestao).
- **CPF**: sempre normalizado (só dígitos) via `src/utils/cpf.js` — qualquer rota nova que aceite/compare CPF deve usar `normalizarCpf()`.
