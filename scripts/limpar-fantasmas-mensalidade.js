// Script de LIMPEZA das cobranças "fantasma" geradas pelo bug antigo do job de
// recorrência (gerarCobrancasRecorrentes em src/services/cobrancas.service.js).
//
// CONTEXTO: até a correção aplicada em src/services/cobrancas.service.js, o job
// somava DIAS FIXOS (ex: 30 dias) ao vencimento anterior para calcular o
// próximo ciclo, em vez de somar MESES e alinhar no dia-alvo (10 ou 20). Isso
// fazia o vencimento "arrastar" 1 dia a cada ciclo em meses com 31 dias,
// gerando uma cobrança "Mensalidade - X" (provedor = 'recorrencia') todo mês
// em um dia levemente diferente (dia 4, 5, 6...) — nunca paga, porque o aluno
// paga a cobrança certa (dia 10/20), e essas ficam acumulando como pendentes
// "fantasmas" no Financeiro do aluno, parecendo duplicidade.
//
// Confirmado em produção no caso da aluna Layane salustiano silva: 4 cobranças
// "Mensalidade - MUSCULAÇÃO" pendentes em 2026-07-04, 06-04, 05-05, 04-05,
// além da cobrança real e correta em 2026-07-20 (dia-alvo).
//
// REGRA DE LIMPEZA (por matrícula ativa recorrente):
//   - Só mexe em cobranças com provedor = 'recorrencia' (é o único provedor
//     usado por esse job).
//   - A PRIMEIRA cobrança de uma matrícula (vencimento == data_inicio, criada
//     na hora da matrícula em planos.routes.js) é SEMPRE legítima,
//     independente do dia — a matrícula pode começar em qualquer dia do mês.
//     Nunca é tratada como fantasma.
//   - Calcula o dia-alvo da matrícula (10 se data_inicio <= dia 15, senão 20).
//     Qualquer outra cobrança 'recorrencia' pendente (ou seja, além da
//     primeira) que caia no dia-alvo também é legítima (é o ciclo atual).
//   - Qualquer cobrança 'recorrencia' pendente que NÃO seja a primeira E não
//     caia no dia-alvo é fantasma — excluída, mas SÓ SE nunca paga (sem
//     pagamentos_cobranca e status != 'pago' — mesma regra de segurança do
//     scripts/corrigir-recorrencia.js).
//
// MODO SEGURO POR PADRÃO: dry-run sem --aplicar.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/limpar-fantasmas-mensalidade.js            (dry-run)
//   node scripts/limpar-fantasmas-mensalidade.js --aplicar  (aplica de verdade)

const db = require('../src/db/client');

const APLICAR = process.argv.includes('--aplicar');
const TIPOS_RECORRENTES = ['mensal', 'trimestral', 'semestral', 'anual'];

function diaVencimentoPadrao(dataISO) {
  const dia = Number(dataISO.slice(8, 10));
  return dia <= 15 ? 10 : 20;
}

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO (grava no banco)' : 'DRY-RUN (só mostra, não grava)'} ===\n`);

  const matriculas = await db.execute(`
    SELECT m.id, m.aluno_id, m.data_inicio, m.data_fim, a.nome as aluno_nome, p.tipo as plano_tipo
    FROM matriculas m
    JOIN alunos a ON a.id = m.aluno_id
    JOIN planos p ON p.id = m.plano_id
    WHERE m.status = 'ativa' AND m.renovacao_automatica = 1
  `);

  let excluidas = 0;
  let bloqueadasPorSeguranca = [];

  for (const m of matriculas.rows) {
    if (!TIPOS_RECORRENTES.includes(m.plano_tipo)) continue;

    const pendentes = await db.execute({
      sql: `SELECT id, valor_centavos, vencimento, status FROM cobrancas
            WHERE matricula_id = ? AND provedor = 'recorrencia' AND status != 'pago'
            ORDER BY vencimento DESC`,
      args: [m.id],
    });
    if (pendentes.rows.length <= 1) continue; // nada pra limpar, só 1 (ou 0) pendente

    const diaAlvo = diaVencimentoPadrao(m.data_inicio);
    const legitimas = [];
    const fantasmas = [];
    for (const c of pendentes.rows) {
      const dia = Number(c.vencimento.slice(8, 10));
      const ehPrimeiraCobranca = c.vencimento === m.data_inicio;
      const noDiaAlvo = dia === diaAlvo;
      (ehPrimeiraCobranca || noDiaAlvo ? legitimas : fantasmas).push(c);
    }
    if (!fantasmas.length) continue;

    const manterRef = legitimas[0] ? legitimas[0].vencimento : `1ª cobrança=${m.data_inicio} ou dia-alvo=${diaAlvo}`;

    for (const c of fantasmas) {
      const pagamentos = await db.execute({
        sql: 'SELECT COALESCE(SUM(valor_centavos),0) as total FROM pagamentos_cobranca WHERE cobranca_id = ?',
        args: [c.id],
      });
      const temPagamento = Number(pagamentos.rows[0].total) > 0;
      const seguro = c.status !== 'pago' && !temPagamento;

      if (!seguro) {
        bloqueadasPorSeguranca.push({ aluno: m.aluno_nome, cobranca_id: c.id, status: c.status, valor_pago: Number(pagamentos.rows[0].total) });
        continue;
      }

      console.log(`  ${APLICAR ? 'EXCLUINDO' : '[dry-run] excluiria'}: ${m.aluno_nome} | R$${(c.valor_centavos / 100).toFixed(2)} | vencimento ${c.vencimento} (fantasma, dia-alvo real=${diaAlvo}) | referência legítima: ${manterRef} | cobrança ${c.id}`);
      if (APLICAR) {
        await db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: [c.id] });
      }
      excluidas++;
    }
  }

  console.log(`\nTotal ${APLICAR ? 'excluídas' : 'que seriam excluídas'}: ${excluidas}`);
  if (bloqueadasPorSeguranca.length) {
    console.log(`ATENÇÃO: ${bloqueadasPorSeguranca.length} não foram mexidas por segurança (já pagas ou com pagamento lançado):`);
    bloqueadasPorSeguranca.forEach((b) => console.log(`  ${b.aluno} | cobrança ${b.cobranca_id} | status=${b.status} | valor pago=R$${(b.valor_pago / 100).toFixed(2)}`));
  }
  console.log(`\n=== FIM (${APLICAR ? 'aplicado' : 'dry-run — nada foi gravado'}) ===`);
  if (!APLICAR) {
    console.log('\nSe os números acima fizerem sentido, roda de novo com --aplicar para gravar de verdade:');
    console.log('  node scripts/limpar-fantasmas-mensalidade.js --aplicar');
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Erro na limpeza:', err);
  process.exit(1);
});
