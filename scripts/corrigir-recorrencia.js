// Script de CORREÇÃO (não é mais só diagnóstico) da duplicação de cobranças
// recorrentes causada pela migração do Secullum.
//
// O QUE ESTE SCRIPT FAZ, EM ORDEM:
//
//  1. Re-verifica (na hora, direto no banco — não confia no JSON salvo antes)
//     cada uma das cobranças "duplicata provável" já identificadas. Só marca
//     como segura pra excluir se, AGORA, status != 'pago' E não existe nenhum
//     pagamento lançado em pagamentos_cobranca. Se algo mudou nesse meio tempo
//     (por ex. alguém pagou a cobrança errada por engano), o script NÃO exclui
//     e avisa pra revisão manual.
//
//  2. Exclui as cobranças confirmadas como seguras (a "Mensalidade - X" gerada
//     a mais pelo motor de recorrência, com vencimento == data_inicio da
//     matrícula, nunca paga).
//
//  3. Religa o matricula_id nas cobranças "legado" que ficaram órfãs na
//     migração — MAS só quando: (a) o aluno tem exatamente 1 matrícula ativa
//     recorrente (sem ambiguidade de qual cobrança pertence a qual plano) E
//     (b) o vencimento da cobrança cai no dia 10 ou dia 20 (o padrão real de
//     mensalidade nos dados migrados). Cobrança legado com vencimento em
//     qualquer outro dia É quase sempre avaliação física, produto ou taxa
//     avulsa (valores como R$85,23, R$120, R$149,99, R$300 em datas soltas
//     tipo dia 06, 15, 28...) — ligar isso à matrícula quebraria a regra de
//     "só mensalidade em atraso bloqueia acesso" e corromperia o cálculo de
//     próximo vencimento. Essas ficam de fora, listadas para revisão manual,
//     SEM nenhum UPDATE.
//     Isso é a correção da causa raiz: sem isso, o job de recorrência ia
//     continuar "não enxergando" o histórico legado e duplicando de novo no
//     próximo ciclo.
//
//  4. Recalcula data_fim de cada matrícula ativa recorrente com base na
//     ÚLTIMA cobrança de fato (agora corretamente linkada), usando a regra
//     nova: soma em MESES (não em dias fixos) e alinha no dia-alvo (10 se a
//     matrícula começou entre os dias 1-15, 20 se começou entre 16 e o fim do
//     mês) — a mesma lógica já usada no diagnóstico anterior.
//
// MODO SEGURO POR PADRÃO: sem argumento nenhum, roda em modo DRY-RUN (só
// imprime o que faria, não grava nada). Só grava de verdade se rodar com
// --aplicar.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/corrigir-recorrencia.js            (dry-run, não grava nada)
//   node scripts/corrigir-recorrencia.js --aplicar   (aplica de verdade)

const fs = require('fs');
const path = require('path');
const db = require('../src/db/client');

const APLICAR = process.argv.includes('--aplicar');
const TIPOS_RECORRENTES = ['mensal', 'trimestral', 'semestral', 'anual'];
const MESES_POR_TIPO = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };

function diaVencimentoPadrao(dataISO) {
  const dia = Number(dataISO.slice(8, 10));
  return dia <= 15 ? 10 : 20;
}

function somarMesesComDiaAlvo(dataISO, meses, diaAlvo) {
  const [ano, mes] = dataISO.split('-').map(Number);
  const totalMeses = (mes - 1) + meses;
  const novoAno = ano + Math.floor(totalMeses / 12);
  const novoMesIndex = totalMeses % 12;
  const ultimoDiaDoMes = new Date(novoAno, novoMesIndex + 1, 0).getDate();
  const dia = Math.min(diaAlvo, ultimoDiaDoMes);
  const mm = String(novoMesIndex + 1).padStart(2, '0');
  const dd = String(dia).padStart(2, '0');
  return `${novoAno}-${mm}-${dd}`;
}

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO (grava no banco)' : 'DRY-RUN (só mostra, não grava)'} ===\n`);

  const caminhoAnterior = path.join(__dirname, 'relatorio-diagnostico-recorrencia.json');
  const anterior = JSON.parse(fs.readFileSync(caminhoAnterior, 'utf8'));

  // --- ETAPA 1 e 2: re-verificar e excluir duplicatas seguras ---
  console.log('--- Etapa 1/3: re-verificando e excluindo duplicatas seguras ---');
  let excluidas = 0;
  let bloqueadasPorSeguranca = [];

  for (const d of anterior.provaveisDuplicatas) {
    for (const c of d.cobrancas_recorrencia_suspeitas) {
      const atual = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [c.id] });
      const linha = atual.rows[0];
      if (!linha) continue; // já não existe mais (rodou antes?)

      const pagamentos = await db.execute({
        sql: 'SELECT COALESCE(SUM(valor_centavos),0) as total FROM pagamentos_cobranca WHERE cobranca_id = ?',
        args: [linha.id],
      });
      const temPagamento = Number(pagamentos.rows[0].total) > 0;
      const seguro = linha.status !== 'pago' && !temPagamento;

      if (!seguro) {
        bloqueadasPorSeguranca.push({ aluno: d.aluno, cobranca_id: linha.id, status: linha.status, valor_pago: Number(pagamentos.rows[0].total) });
        continue;
      }

      console.log(`  ${APLICAR ? 'EXCLUINDO' : '[dry-run] excluiria'}: ${d.aluno} | ${d.plano} | R$${(linha.valor_centavos / 100).toFixed(2)} | vencimento ${linha.vencimento} | cobrança ${linha.id}`);
      if (APLICAR) {
        await db.execute({ sql: 'DELETE FROM cobrancas WHERE id = ?', args: [linha.id] });
      }
      excluidas++;
    }
  }

  console.log(`\nTotal ${APLICAR ? 'excluídas' : 'que seriam excluídas'}: ${excluidas}`);
  if (bloqueadasPorSeguranca.length) {
    console.log(`ATENÇÃO: ${bloqueadasPorSeguranca.length} não foram mexidas por segurança (já pagas ou com pagamento lançado):`);
    bloqueadasPorSeguranca.forEach((b) => console.log(`  ${b.aluno} | cobrança ${b.cobranca_id} | status=${b.status} | valor pago=R$${(b.valor_pago / 100).toFixed(2)}`));
  }

  // --- ETAPA 3: religar matricula_id nas cobranças legado órfãs ---
  console.log('\n--- Etapa 2/3: religando matricula_id das cobranças legado ---');
  const matriculasAtivasRecorrentes = await db.execute(`
    SELECT m.id, m.aluno_id, m.data_inicio, a.nome as aluno_nome, p.tipo as plano_tipo
    FROM matriculas m
    JOIN alunos a ON a.id = m.aluno_id
    JOIN planos p ON p.id = m.plano_id
    WHERE m.status = 'ativa' AND m.renovacao_automatica = 1
  `);

  const porAluno = new Map();
  for (const m of matriculasAtivasRecorrentes.rows) {
    if (!TIPOS_RECORRENTES.includes(m.plano_tipo)) continue;
    if (!porAluno.has(m.aluno_id)) porAluno.set(m.aluno_id, []);
    porAluno.get(m.aluno_id).push(m);
  }

  let linkadas = 0;
  let ambiguos = [];
  let foraDoPadrao = [];
  for (const [alunoId, matriculas] of porAluno.entries()) {
    if (matriculas.length !== 1) {
      ambiguos.push({ aluno: matriculas[0].aluno_nome, aluno_id: alunoId, qtd_matriculas_ativas: matriculas.length });
      continue;
    }
    const matricula = matriculas[0];
    const legadoOrfao = await db.execute({
      sql: `SELECT id, valor_centavos, vencimento, status FROM cobrancas WHERE aluno_id = ? AND provedor = 'legado' AND matricula_id IS NULL`,
      args: [alunoId],
    });
    if (!legadoOrfao.rows.length) continue;

    for (const c of legadoOrfao.rows) {
      const diaVencimento = Number(c.vencimento.slice(8, 10));
      const pareceMensalidade = diaVencimento === 10 || diaVencimento === 20;

      if (!pareceMensalidade) {
        foraDoPadrao.push({ aluno: matricula.aluno_nome, cobranca_id: c.id, valor_centavos: c.valor_centavos, vencimento: c.vencimento });
        continue;
      }

      console.log(`  ${APLICAR ? 'LINKANDO' : '[dry-run] linkaria'}: ${matricula.aluno_nome} | cobrança legado ${c.id} (R$${(c.valor_centavos / 100).toFixed(2)}, venc ${c.vencimento}) -> matrícula ${matricula.id}`);
      if (APLICAR) {
        await db.execute({ sql: 'UPDATE cobrancas SET matricula_id = ? WHERE id = ?', args: [matricula.id, c.id] });
      }
      linkadas++;
    }
  }

  console.log(`\nTotal ${APLICAR ? 'linkadas' : 'que seriam linkadas'}: ${linkadas}`);
  if (ambiguos.length) {
    console.log(`ATENÇÃO: ${ambiguos.length} aluno(s) com mais de 1 matrícula ativa recorrente — não linkado automaticamente (risco de ambiguidade), precisa revisão manual:`);
    ambiguos.forEach((a) => console.log(`  ${a.aluno} (${a.aluno_id}) | ${a.qtd_matriculas_ativas} matrículas ativas`));
  }
  if (foraDoPadrao.length) {
    console.log(`\nNÃO linkadas (vencimento fora do dia 10/20 — provável avaliação/produto/taxa avulsa, não mensalidade): ${foraDoPadrao.length}`);
    foraDoPadrao.forEach((f) => console.log(`  ${f.aluno} | cobrança ${f.cobranca_id} | R$${(f.valor_centavos / 100).toFixed(2)} | venc ${f.vencimento}`));
  }

  // --- ETAPA 4: recalcular data_fim de cada matrícula ativa recorrente ---
  console.log('\n--- Etapa 3/3: recalculando data_fim (regra nova: mês a mês + dia-alvo 10/20) ---');
  let recalculadas = 0;
  for (const m of matriculasAtivasRecorrentes.rows) {
    if (!TIPOS_RECORRENTES.includes(m.plano_tipo)) continue;
    const meses = MESES_POR_TIPO[m.plano_tipo];

    const ultimaCobranca = await db.execute({
      sql: `SELECT vencimento FROM cobrancas WHERE matricula_id = ? ORDER BY vencimento DESC LIMIT 1`,
      args: [m.id],
    });

    const diaAlvo = diaVencimentoPadrao(m.data_inicio);
    const baseData = ultimaCobranca.rows[0] ? ultimaCobranca.rows[0].vencimento : m.data_inicio;
    const novaDataFim = somarMesesComDiaAlvo(baseData, meses, diaAlvo);

    console.log(`  ${m.aluno_nome} | ${m.plano_tipo} | base=${baseData} -> nova data_fim=${novaDataFim}`);
    if (APLICAR) {
      await db.execute({ sql: 'UPDATE matriculas SET data_fim = ? WHERE id = ?', args: [novaDataFim, m.id] });
    }
    recalculadas++;
  }
  console.log(`\nTotal ${APLICAR ? 'recalculadas' : 'que seriam recalculadas'}: ${recalculadas}`);

  console.log(`\n=== FIM (${APLICAR ? 'aplicado' : 'dry-run — nada foi gravado'}) ===`);
  if (!APLICAR) {
    console.log('\nSe os números acima fizerem sentido, roda de novo com --aplicar para gravar de verdade:');
    console.log('  node scripts/corrigir-recorrencia.js --aplicar');
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Erro na correção:', err);
  process.exit(1);
});
