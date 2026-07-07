// Complemento ao diagnostico-recorrencia.js — SOMENTE LEITURA. Verifica o status
// (pago vs pendente/atrasado) de cada uma das cobranças "duplicata provável"
// identificadas antes, porque isso decide se é seguro remover automaticamente
// (só cobrança nunca paga) ou se precisa de revisão manual (cobrança já paga —
// não se apaga pagamento real de jeito nenhum).
//
// Rodar (a partir da pasta academia-gestao):
//   node scripts/diagnostico-recorrencia-status.js

const fs = require('fs');
const path = require('path');
const db = require('../src/db/client');

async function main() {
  const caminhoRelatorioAnterior = path.join(__dirname, 'relatorio-diagnostico-recorrencia.json');
  const anterior = JSON.parse(fs.readFileSync(caminhoRelatorioAnterior, 'utf8'));

  const detalhado = [];
  let seguras = 0;
  let precisamRevisao = 0;

  for (const d of anterior.provaveisDuplicatas) {
    for (const c of d.cobrancas_recorrencia_suspeitas) {
      const cobranca = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [c.id] });
      const linha = cobranca.rows[0];
      if (!linha) continue;

      const pagamentos = await db.execute({
        sql: 'SELECT COALESCE(SUM(valor_centavos),0) as total FROM pagamentos_cobranca WHERE cobranca_id = ?',
        args: [linha.id],
      });
      const temPagamentoLancado = Number(pagamentos.rows[0].total) > 0;
      const seguroRemover = linha.status !== 'pago' && !temPagamentoLancado;

      if (seguroRemover) seguras++; else precisamRevisao++;

      detalhado.push({
        aluno: d.aluno,
        aluno_id: d.aluno_id,
        plano: d.plano,
        plano_tipo: d.plano_tipo,
        cobranca_id: linha.id,
        valor_centavos: linha.valor_centavos,
        vencimento: linha.vencimento,
        status: linha.status,
        pago_em: linha.pago_em,
        valor_ja_pago_centavos: Number(pagamentos.rows[0].total),
        seguro_remover_automaticamente: seguroRemover,
      });
    }
  }

  console.log(`=== Status das ${detalhado.length} cobranças duplicadas suspeitas ===`);
  console.log(`Seguras pra remover automaticamente (nunca pagas): ${seguras}`);
  console.log(`Precisam de revisão manual (já têm pagamento/status pago): ${precisamRevisao}`);

  if (precisamRevisao > 0) {
    console.log('\n--- Casos que precisam de revisão manual ---');
    detalhado.filter((d) => !d.seguro_remover_automaticamente).forEach((d) => {
      console.log(`  ${d.aluno} | ${d.plano} | cobrança ${d.cobranca_id} | status=${d.status} | valor pago=R$${(d.valor_ja_pago_centavos / 100).toFixed(2)} | vencimento=${d.vencimento}`);
    });
  }

  const caminho = path.join(__dirname, 'relatorio-diagnostico-recorrencia-status.json');
  fs.writeFileSync(caminho, JSON.stringify({ geradoEm: new Date().toISOString(), seguras, precisamRevisao, detalhado }, null, 2), 'utf8');
  console.log(`\nRelatório completo salvo em: ${caminho}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Erro no diagnóstico de status:', err);
  process.exit(1);
});
