const { v4: uuid } = require('uuid');
const db = require('../db/client');

// Tipos de plano que geram cobrança recorrente automaticamente. "avulso" e
// "pacote_aulas" são pagamentos únicos e não entram nesse ciclo.
const TIPOS_RECORRENTES = ['mensal', 'trimestral', 'semestral', 'anual'];
// Duração de cada ciclo em MESES (não em dias fixos). Usar dias fixos (ex: 30
// para "mensal") faz o vencimento "arrastar" 1 dia a cada ciclo em meses de 31
// dias, gerando cobranças fantasma fora do padrão real (dia 10 ou 20) — foi
// exatamente esse bug que causou duplicação de mensalidade em produção (ver
// scripts/corrigir-recorrencia.js). Meses de calendário não têm esse problema.
const MESES_POR_TIPO = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };

function ehRecorrente(tipoPlano) {
  return TIPOS_RECORRENTES.includes(tipoPlano);
}

function somarDias(dataISO, dias) {
  const data = new Date(`${dataISO}T00:00:00`);
  data.setDate(data.getDate() + dias);
  return data.toISOString().slice(0, 10);
}

// Dia-alvo de vencimento: matrícula que começou entre os dias 1-15 cobra
// sempre no dia 10; começando de 16 em diante, cobra no dia 20. Mesma regra
// usada no diagnóstico/correção da duplicação de cobranças.
function diaVencimentoPadrao(dataISO) {
  const dia = Number(dataISO.slice(8, 10));
  return dia <= 15 ? 10 : 20;
}

// Soma em MESES de calendário (não em dias fixos) e alinha no dia-alvo,
// truncando se o mês de destino for mais curto que o dia-alvo.
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

// Cria a cobrança referente a um ciclo (mensalidade) de uma matrícula.
async function criarCobrancaDoCiclo({ matriculaId, alunoId, descricao, valorCentavos, vencimento }) {
  const id = uuid();
  await db.execute({
    sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento)
          VALUES (?, ?, ?, ?, 'pendente', 'recorrencia', ?, ?)`,
    args: [id, alunoId, matriculaId, valorCentavos, descricao, vencimento],
  });
  return id;
}

// Roda a rotina de renovação: para cada matrícula ativa com renovação automática
// e plano recorrente, garante que exista uma cobrança pendente cobrindo o ciclo
// atual. Chamada no início do servidor e periodicamente (ver src/jobs/recorrencia.js).
async function gerarCobrancasRecorrentes() {
  const hoje = new Date().toISOString().slice(0, 10);

  const matriculas = await db.execute(`
    SELECT m.id, m.aluno_id, m.data_inicio, m.data_fim, m.renovacao_automatica,
           p.nome as plano_nome, p.tipo as plano_tipo, p.valor_centavos, p.duracao_dias
    FROM matriculas m
    JOIN planos p ON p.id = m.plano_id
    WHERE m.status = 'ativa' AND m.renovacao_automatica = 1
  `);

  let geradas = 0;

  for (const matricula of matriculas.rows) {
    if (!ehRecorrente(matricula.plano_tipo)) continue;

    // Data do próximo vencimento: com base na última cobrança gerada para esta
    // matrícula, ou na data de início se ainda não existe nenhuma. Soma em
    // MESES (não em dias fixos) e alinha no dia-alvo (10 ou 20) da matrícula —
    // ver comentário de MESES_POR_TIPO acima sobre por que dias fixos causam
    // cobrança fantasma.
    const ultimaCobranca = await db.execute({
      sql: `SELECT vencimento FROM cobrancas WHERE matricula_id = ? ORDER BY vencimento DESC LIMIT 1`,
      args: [matricula.id],
    });

    const diaAlvo = diaVencimentoPadrao(matricula.data_inicio);
    const proximoVencimento = ultimaCobranca.rows[0]
      ? somarMesesComDiaAlvo(ultimaCobranca.rows[0].vencimento, MESES_POR_TIPO[matricula.plano_tipo], diaAlvo)
      : matricula.data_inicio;

    // Só gera quando o ciclo já venceu ou vence em até 3 dias (evita gerar
    // cobranças muito antecipadas). Como a matrícula tem renovação automática,
    // ela renova indefinidamente até ser cancelada/trancada — por isso não há
    // limite de "data_fim" aqui; em vez disso, extendemos data_fim a cada ciclo
    // para refletir até quando o aluno já tem cobrança gerada.
    const antecedenciaOk = proximoVencimento <= somarDias(hoje, 3);
    if (!antecedenciaOk) continue;

    const jaExiste = await db.execute({
      sql: `SELECT id FROM cobrancas WHERE matricula_id = ? AND vencimento = ?`,
      args: [matricula.id, proximoVencimento],
    });
    if (jaExiste.rows[0]) continue;

    await criarCobrancaDoCiclo({
      matriculaId: matricula.id,
      alunoId: matricula.aluno_id,
      descricao: `Mensalidade - ${matricula.plano_nome}`,
      valorCentavos: matricula.valor_centavos,
      vencimento: proximoVencimento,
    });
    await db.execute({
      sql: 'UPDATE matriculas SET data_fim = ? WHERE id = ?',
      args: [proximoVencimento, matricula.id],
    });
    geradas += 1;
  }

  // Guarda quando/quantas cobranças a rotina gerou — usado pelo botão manual
  // "Gerar Contas a Receber" no painel (mesmo campo "Data da última geração"
  // que existia no Secullum), independente de ter rodado pelo cron, pelo
  // intervalo de 24h do servidor ou clicado manualmente pelo admin.
  await db.execute({
    sql: `INSERT INTO configuracoes (chave, valor) VALUES ('ultima_geracao_cobrancas', ?)
          ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
    args: [JSON.stringify({ executadoEm: new Date().toISOString(), geradas })],
  });

  return geradas;
}

module.exports = { ehRecorrente, criarCobrancaDoCiclo, gerarCobrancasRecorrentes };
