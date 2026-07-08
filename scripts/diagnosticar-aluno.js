// Diagnostico detalhado de um aluno especifico: mostra as matriculas e TODAS
// as cobrancas ligadas (com provedor, secullum_numero e matricula_id) pra
// entender a origem de uma cobranca duplicada/fantasma.
//
// Como rodar (a partir da pasta academia-gestao), com o nome (ou parte do
// nome) do aluno entre aspas:
//   node scripts/diagnosticar-aluno.js "maria clara de melo"

const { createClient } = require('@libsql/client');

const busca = process.argv[2];
if (!busca) {
  console.error('Uso: node scripts/diagnosticar-aluno.js "nome ou parte do nome"');
  process.exit(1);
}

const db = createClient({ url: 'file:./local.db' });

async function main() {
  const alunos = await db.execute({
    sql: `SELECT id, nome, cpf, secullum_id, status FROM alunos WHERE nome LIKE ? ORDER BY nome`,
    args: [`%${busca}%`],
  });

  if (alunos.rows.length === 0) {
    console.log('Nenhum aluno encontrado com esse nome.');
    return;
  }

  for (const aluno of alunos.rows) {
    console.log(`\n=== ${aluno.nome} (id=${aluno.id}, secullum_id=${aluno.secullum_id}, status=${aluno.status}) ===`);

    const matriculas = await db.execute({
      sql: `SELECT id, plano_id, data_inicio, status, renovacao_automatica, secullum_id FROM matriculas WHERE aluno_id = ? ORDER BY data_inicio`,
      args: [aluno.id],
    });
    console.log(`-- Matrículas (${matriculas.rows.length}) --`);
    for (const m of matriculas.rows) {
      const plano = await db.execute({ sql: `SELECT nome FROM planos WHERE id = ?`, args: [m.plano_id] });
      const nomePlano = plano.rows[0] ? plano.rows[0].nome : '(plano não encontrado)';
      console.log(`  matricula id=${m.id} plano="${nomePlano}" data_inicio=${m.data_inicio} status=${m.status} renovacao_automatica=${m.renovacao_automatica} secullum_id=${m.secullum_id}`);
    }

    const cobrancas = await db.execute({
      sql: `SELECT id, matricula_id, valor_centavos, status, provedor, secullum_numero, vencimento, pago_em, criado_em, descricao FROM cobrancas WHERE aluno_id = ? ORDER BY vencimento`,
      args: [aluno.id],
    });
    console.log(`-- Cobranças (${cobrancas.rows.length}) --`);
    for (const c of cobrancas.rows) {
      const valorReais = (Number(c.valor_centavos) / 100).toFixed(2).replace('.', ',');
      console.log(`  cobranca id=${c.id} matricula_id=${c.matricula_id} provedor=${c.provedor} secullum_numero=${c.secullum_numero} valor=R$${valorReais} status=${c.status} vencimento=${c.vencimento} pago_em=${c.pago_em} criado_em=${c.criado_em} descricao="${c.descricao}"`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
