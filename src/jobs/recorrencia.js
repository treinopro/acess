// Job de recorrência: garante que toda matrícula ativa com renovação automática
// tenha a próxima cobrança do ciclo já criada como "conta a receber". A primeira
// cobrança de cada matrícula é criada na hora (rota /api/planos/matricular);
// este job cuida dos ciclos seguintes (2ª mensalidade em diante).
//
// 2026-07: deixou de rodar sozinho (nem no boot do servidor, nem em intervalo
// nenhum, nem via Render Cron Job — decisão do dono do sistema: geração de
// cobrança é ação financeira, prefere disparar na hora escolhendo o período).
// O jeito normal de usar isso agora é o botão "Gerar Contas a Receber" no
// painel (ver src/routes/pagamentos.routes.js, POST /api/pagamentos/gerar-recorrentes),
// que já deixa escolher mês corrente ou meses futuros. Este arquivo continua
// existindo só pra quem quiser rodar pelo terminal (`npm run gerar-cobrancas`)
// — sem período informado, gera tudo que faltar até hoje.
require('dotenv').config();
const { gerarCobrancasRecorrentes } = require('../services/cobrancas.service');

async function rodar(opcoes) {
  const geradas = await gerarCobrancasRecorrentes(opcoes);
  console.log(`[recorrencia] ${new Date().toISOString()} — ${geradas} cobrança(s) gerada(s).`);
  return geradas;
}

// Permite rodar manualmente: `npm run gerar-cobrancas`.
if (require.main === module) {
  rodar()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[recorrencia] erro ao gerar cobranças:', err);
      process.exit(1);
    });
}

module.exports = { rodar };
