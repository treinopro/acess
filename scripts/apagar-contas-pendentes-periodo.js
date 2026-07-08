// Script de EXCLUSAO de cobrancas (contas) pendentes dentro de um periodo,
// filtrando por valor. Feito para o caso: contas de 01/01/2026 ate 09/06/2026,
// com valor de R$65,00 ou R$60,00, com status = 'pendente'.
//
// Roda em cima da tabela `cobrancas` (ver src/db/schema.sql). O campo de data
// usado no filtro e `vencimento` (data de vencimento da cobranca), que e o
// significado natural de "conta de tal periodo" no sistema.
//
// SEGURANCA:
//   - MODO SEGURO POR PADRAO: dry-run sem --aplicar (so mostra, nao apaga nada).
//   - Cobrancas que ja tiverem algum pagamento parcial lancado em
//     pagamentos_cobranca NAO sao excluidas mesmo que o status ainda diga
//     'pendente' (mesma regra de seguranca usada em
//     scripts/limpar-fantasmas-mensalidade.js) - ficam listadas a parte.
//   - So mexe no banco local (file:./local.db), nunca em DATABASE_URL do
//     .env, pra nao correr risco de apagar algo em producao (Turso) sem
//     querer.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/apagar-contas-pendentes-periodo.js              (dry-run)
//   node scripts/apagar-contas-pendentes-periodo.js --aplicar    (aplica de verdade)
//
// Parametros opcionais (senao usa os defaults do pedido original):
//   --de=2026-01-01 --ate=2026-06-09 --valores=6500,6000 --status=pendente

const { createClient } = require('@libsql/client');

const args = process.argv.slice(2);
const APLICAR = args.includes('--aplicar');

function getArg(nome, padrao) {
  const prefixo = `--${nome}=`;
  const achado = args.find((a) => a.startsWith(prefixo));
  return achado ? achado.slice(prefixo.length) : padrao;
}

const DE = getArg('de', '2026-01-01');
const ATE = getArg('ate', '2026-06-09');
const STATUS = getArg('status', 'pendente');
const VALORES_CENTAVOS = getArg('valores', '6500,6000')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => !Number.isNaN(v));

// Sempre o banco local, mesmo que o .env aponte para producao (Turso) - evita
// apagar em produção por engano rodando este script.
const db = createClient({ url: 'file:./local.db' });

function reais(centavos) {
  return `R$${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO (grava no banco)' : 'DRY-RUN (só mostra, não grava)'} ===`);
  console.log(`Filtro: status='${STATUS}' | vencimento entre ${DE} e ${ATE} | valores: ${VALORES_CENTAVOS.map(reais).join(' ou ')}\n`);

  if (!VALORES_CENTAVOS.length) {
    console.error('Nenhum valor válido em --valores. Abortando.');
    process.exit(1);
  }

  const placeholders = VALORES_CENTAVOS.map(() => '?').join(',');
  const candidatas = await db.execute({
    sql: `
      SELECT c.id, c.valor_centavos, c.vencimento, c.status, c.descricao, c.provedor,
             a.nome as aluno_nome
      FROM cobrancas c
      JOIN alunos a ON a.id = c.aluno_id
      WHERE c.status = ?
        AND c.vencimento >= ?
        AND c.vencimento <= ?
        AND c.valor_centavos IN (${placeholders})
      ORDER BY c.vencimento ASC
    `,
    args: [STATUS, DE, ATE, ...VALORES_CENTAVOS],
  });

  let excluidas = 0;
  const bloqueadasPorSeguranca = [];

  for (const c of candidatas.rows) {
    const pagamentos = await db.execute({
      sql: 'SELECT COALESCE(SUM(valor_centavos),0) as total FROM pagamentos_cobranca WHERE cobranca_id = ?',
      args: [c.id],
    });
    const totalPago = Number(pagamentos.rows[0].total);

    if (totalPago > 0) {
      bloqueadasPorSeguranca.push({ aluno: c.aluno_nome, cobranca_id: c.id, valor_pago: totalPago });
      continue;
    }

    console.log(
      `  ${APLICAR ? 'EXCLUINDO' : '[dry-run] excluiria'}: ${c.aluno_nome} | ${reais(c.valor_centavos)} | vencimento ${c.vencimento} | ${c.descricao || '(sem descrição)'} | cobrança ${c.id}`
    );

    if (APLICAR) {
      await db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: [c.id] });
    }
    excluidas++;
  }

  console.log(`\nTotal ${APLICAR ? 'excluídas' : 'que seriam excluídas'}: ${excluidas}`);
  if (bloqueadasPorSeguranca.length) {
    console.log(`ATENÇÃO: ${bloqueadasPorSeguranca.length} não foram mexidas por segurança (já têm pagamento parcial lançado):`);
    bloqueadasPorSeguranca.forEach((b) =>
      console.log(`  ${b.aluno} | cobrança ${b.cobranca_id} | valor pago=${reais(b.valor_pago)}`)
    );
  }
  console.log(`\n=== FIM (${APLICAR ? 'aplicado' : 'dry-run — nada foi gravado'}) ===`);
  if (!APLICAR) {
    console.log('\nSe os números acima fizerem sentido, rode de novo com --aplicar para gravar de verdade:');
    console.log('  node scripts/apagar-contas-pendentes-periodo.js --aplicar');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao apagar contas:', err);
    process.exit(1);
  });
