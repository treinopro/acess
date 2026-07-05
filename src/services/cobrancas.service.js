const { v4: uuid } = require('uuid');
const db = require('../db/client');

// Tipos de plano que geram cobrança recorrente automaticamente. "avulso" e
// "pacote_aulas" são pagamentos únicos e não entram nesse ciclo.
const TIPOS_RECORRENTES = ['mensal', 'trimestral', 'semestral', 'anual'];

function ehRecorrente(tipoPlano) {
  return TIPOS_RECORRENTES.includes(tipoPlano);
}

function somarDias(dataISO, dias) {
  const data = new Date(`${dataISO}T00:00:00`);
  data.setDate(data.getDate() + dias);
  return data.toISOString().slice(0, 10);
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
    if (!ehRecorrente(matricula.plano_tipo) || !matricula.duracao_dias) continue;

    // Data do próximo vencimento: com base na última cobrança gerada para esta
    // matrícula, ou na data de início se ainda não existe nenhuma.
    const ultimaCobranca = await db.execute({
      sql: `SELECT vencimento FROM cobrancas WHERE matricula_id = ? ORDER BY vencimento DESC LIMIT 1`,
      args: [matricula.id],
    });

    const proximoVencimento = ultimaCobranca.rows[0]
      ? somarDias(ultimaCobranca.rows[0].vencimento, matricula.duracao_dias)
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

  return geradas;
}

module.exports = { ehRecorrente, criarCobrancaDoCiclo, gerarCobrancasRecorrentes };
