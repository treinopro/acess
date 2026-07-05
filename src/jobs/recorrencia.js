// Job de recorrência: garante que toda matrícula ativa com renovação automática
// tenha sempre a próxima cobrança do ciclo já criada como "conta a receber".
// A primeira cobrança de cada matrícula é criada na hora (rota /api/planos/matricular);
// este job cuida dos ciclos seguintes (2ª mensalidade em diante).
require('dotenv').config();
const { gerarCobrancasRecorrentes } = require('../services/cobrancas.service');

async function rodar() {
  const geradas = await gerarCobrancasRecorrentes();
  console.log(`[recorrencia] ${new Date().toISOString()} — ${geradas} cobrança(s) gerada(s).`);
  return geradas;
}

// Permite rodar manualmente: `npm run gerar-cobrancas` (ou via Render Cron Job em produção).
if (require.main === module) {
  rodar()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[recorrencia] erro ao gerar cobranças:', err);
      process.exit(1);
    });
}

module.exports = { rodar };
