/**
 * Servidor de teste ISOLADO da feature "Chamar instrutor" (NFC) — sobe só a
 * rota /chamar/:equipamentoId, sem precisar do resto do app (sem banco,
 * sem login, sem as outras rotas). Útil pra testar o aviso do Telegram e o
 * texto das tags antes de gravar/colar de verdade, ou pra testar numa rede
 * separada da produção.
 *
 * Uso:
 *   node test-chamar-instrutor.js
 *   (depois abra http://localhost:3001/chamar/leg-press no navegador)
 *
 * Lê o mesmo .env do projeto (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) — ver
 * NFC-CHAMAR-INSTRUTOR.md.
 */

require('dotenv').config();
const express = require('express');
const chamarInstrutorRoutes = require('./src/routes/chamar.routes');
const equipamentos = require('./src/config/equipamentos');
const notificarInstrutor = require('./src/services/notificarInstrutor.service');

const app = express();
app.use(chamarInstrutorRoutes);

const PORT = process.env.TEST_PORT || 3001;

app.listen(PORT, () => {
  console.log(`\n[test-chamar-instrutor] rodando em http://localhost:${PORT}`);

  if (!notificarInstrutor.configurado()) {
    console.log('[test-chamar-instrutor] ATENÇÃO: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID não configurados no .env — a chamada vai responder erro 500 até configurar (ver NFC-CHAMAR-INSTRUTOR.md).');
  } else {
    console.log('[test-chamar-instrutor] Telegram configurado — os testes abaixo vão mandar mensagem de verdade pro chat configurado.');
  }

  console.log('\nAparelhos cadastrados pra teste:');
  for (const [id, nome] of Object.entries(equipamentos)) {
    console.log(`  http://localhost:${PORT}/chamar/${id}  ->  ${nome}`);
  }
  console.log(`\nTag não cadastrada (teste do 404): http://localhost:${PORT}/chamar/nao-existe\n`);
});
