// Diagnóstico (SOMENTE LEITURA — nenhum INSERT/UPDATE/DELETE) para investigar:
//
//   1. Cobranças migradas do Secullum sem `matricula_id` (por isso o job de
//      recorrência não as enxerga como "última cobrança" de uma matrícula, e
//      recomeça o ciclo do zero a partir da data_inicio original — gerando uma
//      cobrança que duplica uma já existente no histórico migrado).
//   2. Cobranças que muito provavelmente já são essa duplicata (provedor =
//      'recorrencia' com vencimento == data_inicio da matrícula, num aluno que
//      também tem cobranças 'legado').
//   3. Para cada matrícula ativa recorrente, qual seria a nova data de
//      vencimento se a regra passar a somar MESES (não dias fixos) e alinhar
//      o dia do mês pela regra pedida (cadastro dia 1-15 => dia 10; dia 16 em
//      diante => dia 20) — comparado com o valor atual, sem gravar nada.
//   4. Cobranças com descrição em branco (pra confirmar se é só falta de
//      "observação" no Secullum original, e não uma referência de plano quebrada).
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/diagnostico-recorrencia.js
//
// Gera um relatório no console e salva um JSON completo em
// scripts/relatorio-diagnostico-recorrencia.json pra eu analisar depois.

const fs = require('fs');
const path = require('path');
const db = require('../src/db/client');

const TIPOS_RECORRENTES = ['mensal', 'trimestral', 'semestral', 'anual'];
const MESES_POR_TIPO = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };

function diaVencimentoPadrao(dataISO) {
  const dia = Number(dataISO.slice(8, 10));
  return dia <= 15 ? 10 : 20;
}

// Soma N meses a uma data (YYYY-MM-DD), preservando o "dia alvo" pedido (não
// necessariamente o dia da data original) — se o mês de destino for mais curto
// que o dia alvo (ex.: dia 31 em fevereiro), cai no último dia daquele mês.
function somarMesesComDiaAlvo(dataISO, meses, diaAlvo) {
  const [ano, mes] = dataISO.split('-').map(Number);
  const totalMeses = (mes - 1) + meses;
  const novoAno = ano + Math.floor(totalMeses / 12);
  const novoMesIndex = totalMeses % 12; // 0-11
  const ultimoDiaDoMes = new Date(novoAno, novoMesIndex + 1, 0).getDate();
  const dia = Math.min(diaAlvo, ultimoDiaDoMes);
  const mm = String(novoMesIndex + 1).padStart(2, '0');
  const dd = String(dia).padStart(2, '0');
  return `${novoAno}-${mm}-${dd}`;
}

async function main() {
  const relatorio = {
    geradoEm: new Date().toISOString(),
    cobrancasLegadoSemMatricula: { total: 0, porTipoPlano: {} },
    provaveisDuplicatas: [],
    simulacaoNovaDataVencimento: [],
    descricaoEmBranco: { total: 0, porValorCentavos: {} },
  };

  // --- 1. Cobranças legado sem matricula_id, cruzando com matrículas recorrentes ativas ---
  const legadoSemMatricula = await db.execute(`
    SELECT c.id, c.aluno_id, c.valor_centavos, c.vencimento, c.status
    FROM cobrancas c
    WHERE c.provedor = 'legado' AND c.matricula_id IS NULL
  `);
  relatorio.cobrancasLegadoSemMatricula.total = legadoSemMatricula.rows.length;

  const matriculasAtivasRecorrentes = await db.execute(`
    SELECT m.id, m.aluno_id, m.plano_id, m.data_inicio, m.data_fim, m.renovacao_automatica,
           a.nome as aluno_nome, p.nome as plano_nome, p.tipo as plano_tipo, p.duracao_dias, p.valor_centavos
    FROM matriculas m
    JOIN alunos a ON a.id = m.aluno_id
    JOIN planos p ON p.id = m.plano_id
    WHERE m.status = 'ativa' AND m.renovacao_automatica = 1
  `);

  for (const m of matriculasAtivasRecorrentes.rows) {
    if (!TIPOS_RECORRENTES.includes(m.plano_tipo)) continue;
    relatorio.cobrancasLegadoSemMatricula.porTipoPlano[m.plano_tipo] =
      (relatorio.cobrancasLegadoSemMatricula.porTipoPlano[m.plano_tipo] || 0) + 1;
  }

  // --- 2. Prováveis duplicatas: cobrança 'recorrencia' com vencimento == data_inicio da matrícula ---
  for (const m of matriculasAtivasRecorrentes.rows) {
    if (!TIPOS_RECORRENTES.includes(m.plano_tipo)) continue;

    const suspeita = await db.execute({
      sql: `SELECT id, valor_centavos, vencimento, criado_em FROM cobrancas
            WHERE matricula_id = ? AND provedor = 'recorrencia' AND vencimento = ?`,
      args: [m.id, m.data_inicio],
    });
    if (!suspeita.rows.length) continue;

    const legadoDoAluno = await db.execute({
      sql: `SELECT COUNT(*) as total FROM cobrancas WHERE aluno_id = ? AND provedor = 'legado'`,
      args: [m.aluno_id],
    });

    if (Number(legadoDoAluno.rows[0].total) > 0) {
      relatorio.provaveisDuplicatas.push({
        aluno: m.aluno_nome,
        aluno_id: m.aluno_id,
        plano: m.plano_nome,
        plano_tipo: m.plano_tipo,
        matricula_id: m.id,
        data_inicio_matricula: m.data_inicio,
        cobrancas_recorrencia_suspeitas: suspeita.rows,
        qtd_cobrancas_legado_do_aluno: Number(legadoDoAluno.rows[0].total),
      });
    }
  }

  // --- 3. Simulação da nova data de vencimento (mês a mês + dia-alvo pela regra pedida) ---
  for (const m of matriculasAtivasRecorrentes.rows) {
    if (!TIPOS_RECORRENTES.includes(m.plano_tipo)) continue;
    const meses = MESES_POR_TIPO[m.plano_tipo];
    if (!meses) continue;

    const diaAlvo = diaVencimentoPadrao(m.data_inicio);
    // Simula avançando ciclo a ciclo, com o dia-alvo fixo, a partir da data_inicio,
    // até alcançar o próximo vencimento (mesma regra de antecedência do job: até hoje+3).
    const hoje = new Date().toISOString().slice(0, 10);
    let cursor = `${m.data_inicio.slice(0, 8)}${String(diaAlvo).padStart(2, '0')}`;
    // garante que o primeiro ciclo simulado não fique no passado distante por causa do ajuste de dia
    if (cursor < m.data_inicio) cursor = somarMesesComDiaAlvo(cursor, meses, diaAlvo);
    let iteracoes = 0;
    while (cursor <= hoje && iteracoes < 600) { // limite de segurança
      cursor = somarMesesComDiaAlvo(cursor, meses, diaAlvo);
      iteracoes++;
    }

    relatorio.simulacaoNovaDataVencimento.push({
      aluno: m.aluno_nome,
      aluno_id: m.aluno_id,
      plano: m.plano_nome,
      plano_tipo: m.plano_tipo,
      data_inicio_matricula: m.data_inicio,
      data_fim_atual_no_banco: m.data_fim,
      dia_alvo_calculado: diaAlvo,
      proximo_vencimento_simulado_regra_nova: cursor,
    });
  }

  // --- 4. Cobranças com descrição em branco ---
  const semDescricao = await db.execute(`
    SELECT valor_centavos, provedor, COUNT(*) as qtd
    FROM cobrancas
    WHERE descricao IS NULL OR TRIM(descricao) = ''
    GROUP BY valor_centavos, provedor
    ORDER BY qtd DESC
  `);
  semDescricao.rows.forEach((r) => {
    relatorio.descricaoEmBranco.total += Number(r.qtd);
    const chave = `R$${(r.valor_centavos / 100).toFixed(2)} (${r.provedor})`;
    relatorio.descricaoEmBranco.porValorCentavos[chave] = Number(r.qtd);
  });

  // --- Impressão resumida no console ---
  console.log('=== 1. Cobranças legado (migradas) sem matricula_id ===');
  console.log(`Total: ${relatorio.cobrancasLegadoSemMatricula.total}`);
  console.log('Matrículas ativas recorrentes por tipo de plano (candidatas ao problema):');
  console.log(relatorio.cobrancasLegadoSemMatricula.porTipoPlano);

  console.log('\n=== 2. Prováveis duplicatas já geradas (cobrança "recorrencia" == data_inicio da matrícula) ===');
  console.log(`Total encontrado: ${relatorio.provaveisDuplicatas.length}`);
  relatorio.provaveisDuplicatas.slice(0, 20).forEach((d) => {
    console.log(`  ${d.aluno} | plano ${d.plano} (${d.plano_tipo}) | matrícula desde ${d.data_inicio_matricula} | ${d.cobrancas_recorrencia_suspeitas.length} cobrança(s) suspeita(s)`);
  });
  if (relatorio.provaveisDuplicatas.length > 20) console.log(`  ... e mais ${relatorio.provaveisDuplicatas.length - 20}`);

  console.log('\n=== 3. Simulação da regra nova de vencimento (amostra) ===');
  relatorio.simulacaoNovaDataVencimento.slice(0, 20).forEach((s) => {
    console.log(`  ${s.aluno} | ${s.plano} | próximo vencimento simulado: ${s.proximo_vencimento_simulado_regra_nova} (dia-alvo ${s.dia_alvo_calculado})`);
  });
  console.log(`Total de matrículas simuladas: ${relatorio.simulacaoNovaDataVencimento.length}`);

  console.log('\n=== 4. Cobranças com descrição em branco (agrupadas por valor) ===');
  console.log(`Total: ${relatorio.descricaoEmBranco.total}`);
  console.log(relatorio.descricaoEmBranco.porValorCentavos);

  const caminhoRelatorio = path.join(__dirname, 'relatorio-diagnostico-recorrencia.json');
  fs.writeFileSync(caminhoRelatorio, JSON.stringify(relatorio, null, 2), 'utf8');
  console.log(`\nRelatório completo salvo em: ${caminhoRelatorio}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Erro no diagnóstico:', err);
  process.exit(1);
});
