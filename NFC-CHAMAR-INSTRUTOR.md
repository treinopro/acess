# Chamar instrutor via tag NFC

Cada aparelho da academia ganha uma tag NFC colada nele. O aluno encosta o
celular na tag, o navegador abre uma URL sozinho (não precisa de nenhum app
instalado — é o comportamento padrão de tags NFC gravadas com uma URL, tanto
Android quanto iPhone reconhecem), e isso avisa o instrutor por Telegram.

## Como funciona (visão geral)

```
tag NFC no aparelho  --(encosta o celular)-->  navegador abre
https://<seu-dominio>/chamar/leg-press
        |
        v
servidor (src/routes/chamar.routes.js)
  1. procura "leg-press" em src/config/equipamentos.js
  2. manda mensagem pro Telegram (src/services/notificarInstrutor.service.js)
  3. devolve uma página "Instrutor chamado!" pro aluno
```

Não tem login nem token nessa rota — a posse física da tag já é a prova
(mesmo padrão do link "meu acesso" que já existe no sistema). Não expõe
nenhum dado de aluno, só o nome do aparelho.

## 1. Criar o bot no Telegram

1. Abra o Telegram e converse com **@BotFather**.
2. Mande `/newbot`, escolha um nome (ex: "Academia Superação - Chamar
   Instrutor") e um username terminado em `bot` (ex:
   `academia_superacao_chamar_bot`).
3. O BotFather devolve um **token**, no formato
   `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Copie — é o
   `TELEGRAM_BOT_TOKEN`.

## 2. Descobrir o chat_id

Decida quem recebe o aviso: um instrutor específico, ou (recomendado) um
**grupo** com todos os instrutores.

**Se for um grupo:**
1. Crie o grupo no Telegram e adicione o bot que você acabou de criar como
   membro.
2. Mande qualquer mensagem no grupo.
3. No navegador, acesse (trocando `<TOKEN>` pelo token do passo 1):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Procure `"chat":{"id":-100xxxxxxxxxx, ...}` na resposta — esse número
   (com o sinal de menos, se tiver) é o `TELEGRAM_CHAT_ID`.

**Se for uma pessoa só:**
1. A pessoa manda `/start` numa conversa direta com o bot.
2. Acesse a mesma URL `getUpdates` acima e procure `"chat":{"id":xxxxxxxxx}`.

## 3. Configurar as variáveis de ambiente

No `.env` (local) ou nas variáveis de ambiente do Northflank (produção),
adicione (ver `.env.example`):

```
TELEGRAM_BOT_TOKEN=123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=-1001234567890
```

Em produção (Northflank), redeploy depois de adicionar.

## 4. Cadastrar os aparelhos de verdade

Edite `src/config/equipamentos.js` — a lista atual é só um exemplo/placeholder.
Cada linha é `'slug-da-tag': 'Nome que aparece no aviso'`. O slug (lado
esquerdo) é o texto que vai no final da URL gravada na tag — pode ser
qualquer coisa, sem espaço e sem barra, só precisa bater com o que for
gravado na tag NFC.

## 5. Gravar as tags NFC

Precisa de tags NFC graváveis (tipo NTAG213/215/216, baratas, compradas em
lote) e um celular com NFC. Apps recomendados:

- **Android**: "NFC Tools" (NXP/wakdev), grátis na Play Store.
- **iPhone**: "NFC Tools" também tem versão iOS (iPhone 7 ou mais novo tem
  NFC de escrita).

Passo a passo no app:
1. Aba "Escrever" / "Write".
2. Adicionar registro do tipo **URL/URI**.
3. Digitar a URL completa, ex:
   `https://academia--acess--tpff5w2s24vs.code.run/chamar/leg-press`
   (troque `leg-press` pelo slug daquele aparelho específico, cadastrado no
   passo 4).
4. Escrever/gravar, encostando o celular na tag.
5. Colar a tag no aparelho (fita dupla-face forte, ou dentro de um case
   plástico pra proteger).
6. Testar: encoste o celular na tag já colada e confirme que abre a página
   "Instrutor chamado!" e que a mensagem chega no Telegram.

## Testando sem gravar tag nenhuma

Duas formas:

- **Direto no app rodando** (local ou produção): abra no navegador
  `https://<seu-dominio>/chamar/<slug>` — mesmo efeito de encostar a tag.
- **Servidor isolado**, sem precisar do resto do app (sem banco, sem login):
  ```
  node test-chamar-instrutor.js
  ```
  Sobe só a rota `/chamar/:equipamentoId` na porta 3001 e lista no terminal
  os links de teste pra cada aparelho cadastrado (inclusive um slug que não
  existe, pra testar a página de erro 404).

## Cooldown

Pra evitar martelar o Telegram se alguém encostar várias vezes seguidas na
mesma tag, o servidor ignora chamados repetidos do **mesmo aparelho** dentro
de 60 segundos (configurável via `CHAMAR_INSTRUTOR_COOLDOWN_MS` no `.env`) —
o aluno ainda vê uma confirmação ("instrutor já a caminho"), só não dispara
mensagem nova no Telegram.
