// Script de EXCLUSAO das cobrancas "fantasma" geradas pela migracao em lote do
// Secullum (dia 06/07/2026).
//
// DIAGNOSTICO (feito em cima de uma copia do local.db, sem alterar nada):
//   Nesse dia, 1229 matriculas foram criadas de uma vez (import do historico
//   do Secullum), cada uma com `data_inicio` no passado (jan-jun/2026). Ao
//   criar cada matricula, o sistema gerou automaticamente a "primeira
//   cobranca" (provedor='recorrencia') com vencimento = data_inicio - ou
//   seja, ja nasceu vencida. Isso NAO e uma divida real: e so um efeito
//   colateral de importar matriculas retroativas pra manter o historico de
//   acesso/checkins, e o aluno normalmente ja pagou esse periodo no sistema
//   antigo (Secullum), fora daqui.
//
//   Resultado: 227 cobrancas nessa situacao (uma por matricula, nenhuma com
//   pagamento parcial lancado) - em varios valores (nao so R$65/R$60), todas
//   com status ainda 'pendente' e vencimento anterior a hoje. Todas essas 227
//   ja sao de alunos com alunos.status = 'ativo' (conferido no banco).
//
//   CONFIRMADO NUM CASO REAL (Alenia Cabral Silva): ela tem uma cobranca
//   'legado' de R$480,00 ("anual promocional 480"), vencimento 2026-06-20,
//   PAGA em 2026-06-10 - ou seja, ela ja pagou o plano anual naquele dia. A
//   migracao, na mesma leva, criou UMA SEGUNDA matricula "Anual" com
//   data_inicio 2026-06-10 e gerou uma cobranca 'recorrencia' separada de
//   R$539,84 (preco cheio, nao o promocional) pendente pro mesmo dia - um
//   duplicado direto do pagamento que ela ja fez. Rodamos essa mesma checagem
//   pra todas as 227: 220 delas (97%) tem uma cobranca 'legado' PAGA do MESMO
//   aluno com vencimento a ate 20 dias de distancia - ou seja, evidencia
//   direta de que aquele periodo ja foi pago por fora, so nao no registro que
//   ficou pendente. As outras 7 NAO tem essa evidencia proxima - por
//   segurança o script NÃO apaga essas 7 automaticamente, só lista pra você
//   revisar manualmente.
//
// CRITERIO DE EXCLUSAO (mais preciso que so "valor + periodo"):
//   - c.provedor = 'recorrencia'
//   - c.status = 'pendente'
//   - c.vencimento < hoje (ja vencida)
//   - a matricula dessa cobranca foi criada no lote da migracao (--lote,
//     default 2026-07-06)
//   - a.status = 'ativo' (aluno ATIVO no cadastro) - alunos inativos/
//     trancados/inadimplentes NUNCA sao mexidos por este script, por mais
//     que a cobranca bata nos outros criterios. A ideia e que aluno inativo
//     e "conta antiga" (relacao encerrada) e a cobranca pendente dele, se
//     houver, pode ser divida real/historico que nao deve ser apagado sem
//     revisao manual.
//   - EVIDENCIA DE PAGAMENTO (--janela-dias, default 20): só apaga se existir
//     alguma cobranca 'legado' com status='pago' do MESMO aluno com
//     vencimento dentro da janela (+/- N dias) do vencimento da cobranca
//     fantasma - isto é, prova de que aquele período já foi pago por outro
//     registro. Sem essa evidência próxima, a cobrança NUNCA é apagada
//     automaticamente, só listada à parte pra revisão manual.
//   - SEGURANCA: cobranca com QUALQUER pagamento parcial ja lancado em
//     pagamentos_cobranca NUNCA e apagada, mesmo que bata os criterios acima
//     (fica listada a parte).
//
// MODO SEGURO POR PADRAO: dry-run sem --aplicar.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/apagar-cobrancas-fantasma-migracao.js            (dry-run)
//   node scripts/apagar-cobrancas-fantasma-migracao.js --aplicar  (aplica de verdade)
//
// Parametros opcionais:
//   --lote=2026-07-06     (dia em que as matriculas do import foram criadas)
//   --hoje=2026-07-08     (data de corte "vencida ate"; default = data de hoje da maquina)
//   --janela-dias=20      (tamanho da janela, em dias, pra procurar cobranca 'legado' paga por perto)

const { createClient } = require('@libsql/client');

const args = process.argv.slice(2);
const APLICAR = args.includes('--aplicar');

function getArg(nome, padrao) {
  const prefixo = `--${nome}=`;
  const achado = args.find((a) => a.startsWith(prefixo));
  return achado ? achado.slice(prefixo.length) : padrao;
}

const LOTE = getArg('lote', '2026-07-06');
const HOJE = getArg('hoje', new Date().toISOString().slice(0, 10));
const JANELA_DIAS = Number(getArg('janela-dias', '20'));

// Sempre o banco local, mesmo que o .env aponte para producao (Turso) - evita
// mexer em producao por engano rodando este script.
const db = createClient({ url: 'file:./local.db' });

function reais(centavos) {
  return `R$${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

function somarDias(dataISO, dias) {
  const d = new Date(`${dataISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO (grava no banco)' : 'DRY-RUN (só mostra, não grava)'} ===`);
  console.log(`Filtro: provedor='recorrencia' | status='pendente' | vencimento < ${HOJE} | matrícula criada em ${LOTE} (lote da migração) | aluno.status='ativo' | exige cobrança 'legado' paga a até ${JANELA_DIAS} dias\n`);

  const candidatas = await db.execute({
    sql: `
      SELECT c.id, c.aluno_id, c.valor_centavos, c.vencimento, c.descricao,
             m.id as matricula_id, m.data_inicio,
             a.nome as aluno_nome, a.status as aluno_status
      FROM cobrancas c
      JOIN matriculas m ON m.id = c.matricula_id
      JOIN alunos a ON a.id = c.aluno_id
      WHERE c.provedor = 'recorrencia'
        AND c.status = 'pendente'
        AND c.vencimento < ?
        AND m.criado_em LIKE ?
        AND a.status = 'ativo'
      ORDER BY c.vencimento ASC
    `,
    args: [HOJE, `${LOTE}%`],
  });

  // Só informativo: quantas cobrancas do MESMO lote ficaram de fora por
  // causa do aluno não estar 'ativo' (não são mexidas, nunca).
  const foraPorAlunoInativo = await db.execute({
    sql: `
      SELECT COUNT(*) as n
      FROM cobrancas c
      JOIN matriculas m ON m.id = c.matricula_id
      JOIN alunos a ON a.id = c.aluno_id
      WHERE c.provedor = 'recorrencia'
        AND c.status = 'pendente'
        AND c.vencimento < ?
        AND m.criado_em LIKE ?
        AND a.status != 'ativo'
    `,
    args: [HOJE, `${LOTE}%`],
  });
  const qtdForaPorAlunoInativo = Number(foraPorAlunoInativo.rows[0].n);

  let excluidas = 0;
  let totalCentavos = 0;
  const bloqueadasPorSeguranca = [];
  const semEvidenciaDePagamento = [];

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

    // Exige uma cobranca 'legado' PAGA do mesmo aluno com vencimento por
    // perto (prova de que aquele periodo ja foi pago em outro registro,
    // vindo da migracao/sistema antigo). Sem isso, NAO apaga - so lista pra
    // revisao manual.
    const janelaIni = somarDias(c.vencimento, -JANELA_DIAS);
    const janelaFim = somarDias(c.vencimento, JANELA_DIAS);
    const evidencia = await db.execute({
      sql: `
        SELECT id, valor_centavos, vencimento, pago_em, descricao FROM cobrancas
        WHERE aluno_id = ? AND provedor = 'legado' AND status = 'pago'
          AND vencimento BETWEEN ? AND ?
        ORDER BY ABS(julianday(vencimento) - julianday(?)) ASC
        LIMIT 1
      `,
      args: [c.aluno_id, janelaIni, janelaFim, c.vencimento],
    });

    if (!evidencia.rows.length) {
      semEvidenciaDePagamento.push({ aluno: c.aluno_nome, cobranca_id: c.id, valor: c.valor_centavos, vencimento: c.vencimento });
      continue;
    }
    const ev = evidencia.rows[0];

    console.log(
      `  ${APLICAR ? 'EXCLUINDO' : '[dry-run] excluiria'}: ${c.aluno_nome} | ${reais(c.valor_centavos)} | vencimento ${c.vencimento} | ${c.descricao || '(sem descrição)'} | cobrança ${c.id} ` +
        `(evidência: pagou ${reais(ev.valor_centavos)} em ${String(ev.pago_em).slice(0, 10)}, vencimento legado ${ev.vencimento})`
    );

    if (APLICAR) {
      await db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: [c.id] });
    }
    excluidas++;
    totalCentavos += c.valor_centavos;
  }

  console.log(`\nTotal ${APLICAR ? 'excluídas' : 'que seriam excluídas'}: ${excluidas} (soma ${reais(totalCentavos)})`);
  if (qtdForaPorAlunoInativo > 0) {
    console.log(`Info: ${qtdForaPorAlunoInativo} cobrança(s) do mesmo lote NÃO entraram na lista acima por serem de aluno com status diferente de 'ativo' (conta antiga) — não foram mexidas, revise manualmente se quiser.`);
  }
  if (semEvidenciaDePagamento.length) {
    console.log(`ATENÇÃO: ${semEvidenciaDePagamento.length} NÃO foram mexidas por não terem uma cobrança 'legado' paga por perto (sem evidência direta de pagamento do período) — revise manualmente:`);
    semEvidenciaDePagamento.forEach((b) =>
      console.log(`  ${b.aluno} | cobrança ${b.cobranca_id} | ${reais(b.valor)} | vencimento ${b.vencimento}`)
    );
  }
  if (bloqueadasPorSeguranca.length) {
    console.log(`ATENÇÃO: ${bloqueadasPorSeguranca.length} não foram mexidas por segurança (já têm pagamento parcial lançado):`);
    bloqueadasPorSeguranca.forEach((b) =>
      console.log(`  ${b.aluno} | cobrança ${b.cobranca_id} | valor pago=${reais(b.valor_pago)}`)
    );
  }
  console.log(`\n=== FIM (${APLICAR ? 'aplicado' : 'dry-run — nada foi gravado'}) ===`);
  if (!APLICAR) {
    console.log('\nSe a lista acima fizer sentido, rode de novo com --aplicar para gravar de verdade:');
    console.log('  node scripts/apagar-cobrancas-fantasma-migracao.js --aplicar');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao apagar cobranças:', err);
    process.exit(1);
  });
