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
  // OR IGNORE: reforça a checagem "jaExiste" já feita em gerarCobrancasRecorrentes
  // — se duas execuções da rotina ficarem sobrepostas (ex.: dois reinícios do
  // servidor muito próximos), o índice único idx_cobrancas_recorrencia_matricula_vencimento
  // (ver schema.sql) faz esse segundo INSERT ser ignorado em vez de duplicar a cobrança.
  const id = uuid();
  await db.execute({
    sql: `INSERT OR IGNORE INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento)
          VALUES (?, ?, ?, ?, 'pendente', 'recorrencia', ?, ?)`,
    args: [id, alunoId, matriculaId, valorCentavos, descricao, vencimento],
  });
  return id;
}

// Último dia do mês (YYYY-MM-DD) de uma competência "YYYY-MM" — usado como
// limite padrão de "gerar contas até o mês corrente" quando o painel não
// informa um período específico.
function ultimoDiaDoMes(anoMes) {
  const [ano, mes] = anoMes.split('-').map(Number);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  return `${anoMes}-${String(ultimoDia).padStart(2, '0')}`;
}

/**
 * Roda a rotina de renovação: para cada matrícula ativa com renovação
 * automática e plano recorrente, gera TODAS as cobranças pendentes que
 * faltarem até `ateData` (inclusive) — não só a próxima. Chamada SÓ
 * manualmente agora (botão "Gerar Contas a Receber" no painel — ver
 * src/routes/pagamentos.routes.js), nunca mais automaticamente (decisão do
 * dono do sistema, 2026-07: evitar qualquer geração "por conta própria" sem
 * o admin decidir o período na hora).
 *
 * `ateData` (formato YYYY-MM-DD, padrão: hoje) é o limite do período pedido
 * no painel — ex.: "mês corrente" manda o último dia do mês atual; "gerar
 * até outubro" manda 2026-10-31. Cada matrícula avança seu PRÓPRIO ciclo (1,
 * 3, 6 ou 12 meses conforme o tipo do plano) a partir da última cobrança já
 * gerada, então um plano trimestral só gera uma cobrança nova quando o mês
 * do seu próprio ciclo de renovação cai dentro do período pedido — pedir
 * "gerar até setembro" não cria cobrança nova pra um plano trimestral cujo
 * próximo vencimento é só em outubro. A checagem de duplicidade
 * (`jaExiste`, por matrícula + vencimento exato) é feita a cada ciclo do
 * loop, então não duplica cobrança já existente em nenhum mês do intervalo.
 */
async function gerarCobrancasRecorrentes({ ateData } = {}) {
  const hoje = new Date().toISOString().slice(0, 10);
  const limite = ateData || hoje;

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

    const diaAlvo = diaVencimentoPadrao(matricula.data_inicio);

    // Data do próximo vencimento: com base na última cobrança gerada para esta
    // matrícula, ou na data de início se ainda não existe nenhuma. Soma em
    // MESES (não em dias fixos) e alinha no dia-alvo (10 ou 20) da matrícula —
    // ver comentário de MESES_POR_TIPO acima sobre por que dias fixos causam
    // cobrança fantasma.
    const ultimaCobranca = await db.execute({
      sql: `SELECT vencimento FROM cobrancas WHERE matricula_id = ? ORDER BY vencimento DESC LIMIT 1`,
      args: [matricula.id],
    });
    let proximoVencimento = ultimaCobranca.rows[0]
      ? somarMesesComDiaAlvo(ultimaCobranca.rows[0].vencimento, MESES_POR_TIPO[matricula.plano_tipo], diaAlvo)
      : matricula.data_inicio;

    // Gera TODOS os ciclos que faltarem até `limite` (não só o próximo) — é
    // isso que permite "gerar contas dos próximos meses de uma vez", em vez
    // de precisar clicar o botão uma vez por mês. Cada volta do loop avança
    // mais um ciclo (1/3/6/12 meses, conforme o plano) e só entra se esse
    // vencimento já estiver dentro da janela pedida. Sem margem extra de dias
    // aqui (diferente da rotina automática antiga): agora quem decide até
    // onde gerar é o admin, escolhendo o período no painel — "mês corrente"
    // deve gerar só o que vence dentro do mês corrente, não vazar pro mês
    // seguinte.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const antecedenciaOk = proximoVencimento <= limite;
      if (!antecedenciaOk) break;

      const jaExiste = await db.execute({
        sql: `SELECT id FROM cobrancas WHERE matricula_id = ? AND vencimento = ?`,
        args: [matricula.id, proximoVencimento],
      });
      if (!jaExiste.rows[0]) {
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

      // Avança pro próximo ciclo desta matrícula e repete a checagem — só
      // sai do loop quando o próximo vencimento passar da janela pedida.
      proximoVencimento = somarMesesComDiaAlvo(proximoVencimento, MESES_POR_TIPO[matricula.plano_tipo], diaAlvo);
    }
  }

  // Guarda quando/quantas cobranças a rotina gerou, e até qual período foi
  // pedido — usado pelo painel pra mostrar "Última geração de contas a
  // receber" ao lado do botão "Gerar Contas a Receber".
  await db.execute({
    sql: `INSERT INTO configuracoes (chave, valor) VALUES ('ultima_geracao_cobrancas', ?)
          ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
    args: [JSON.stringify({ executadoEm: new Date().toISOString(), geradas, ateData: limite })],
  });

  return geradas;
}

module.exports = { ehRecorrente, criarCobrancaDoCiclo, gerarCobrancasRecorrentes, ultimoDiaDoMes };
