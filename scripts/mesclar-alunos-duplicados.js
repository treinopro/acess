// Mescla alunos duplicados (mesmo nome + mesmo CPF, mas cadastrados sob
// pessoa_id diferentes no Secullum original - ex: a pessoa saiu e voltou
// anos depois e o Secullum criou um cadastro novo em vez de reaproveitar o
// antigo). A migração v2 importa cada um como um aluno separado (correto,
// já que tecnicamente são registros diferentes no Secullum), mas na prática
// você quer 1 perfil só por pessoa.
//
// Como decide quem fica (o "sobrevivente") e quem é apagado:
//   Para cada duplicata, conta quantos registros relacionados cada um tem
//   (matrículas + cobranças + anamneses + avaliações + checkins +
//   agendamentos + acessos de catraca + pagamentos do totem + treinos).
//   Quem tiver mais registros relacionados vira o sobrevivente (é o
//   cadastro "mais rico"); em empate, fica o mais antigo (criado_em menor).
//   TODOS os registros do(s) outro(s) são reapontados (UPDATE aluno_id)
//   para o sobrevivente, e só então o(s) cadastro(s) duplicado(s) são
//   apagados. Nenhum dado histórico é perdido - só passa a viver sob um
//   único aluno_id.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/mesclar-alunos-duplicados.js            (dry-run - só mostra o plano)
//   node scripts/mesclar-alunos-duplicados.js --aplicar   (mescla de verdade)

const { createClient } = require('@libsql/client');

const APLICAR = process.argv.includes('--aplicar');
const db = createClient({ url: 'file:./local.db' });

// Tabelas com aluno_id que precisam ser reapontadas ao mesclar.
const TABELAS_COM_ALUNO_ID = [
  'matriculas',
  'cobrancas',
  'anamneses',
  'avaliacoes_fisicas',
  'checkins',
  'agendamentos',
  'acessos_catraca',
  'pagamentos_totem',
  'treinos',
];

async function tabelaExiste(tabela) {
  const r = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    args: [tabela],
  });
  return r.rows.length > 0;
}

async function contarRelacionados(alunoId, tabelasExistentes) {
  let total = 0;
  const detalhe = {};
  for (const tabela of TABELAS_COM_ALUNO_ID) {
    if (!tabelasExistentes[tabela]) {
      continue; // tabela não existe neste banco (ex: pagamentos_totem, treinos) - pula
    }
    const r = await db.execute({
      sql: `SELECT COUNT(*) as n FROM ${tabela} WHERE aluno_id = ?`,
      args: [alunoId],
    });
    const n = Number(r.rows[0].n);
    detalhe[tabela] = n;
    total += n;
  }
  return { total, detalhe };
}

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO (mescla de verdade)' : 'DRY-RUN (só mostra o plano, não mescla nada)'} ===\n`);

  // Alguns bancos locais mais antigos não têm todas as tabelas (ex:
  // pagamentos_totem, treinos) - confere de antemão e pula as que não
  // existem, em vez de travar o script inteiro.
  const tabelasExistentes = {};
  for (const tabela of TABELAS_COM_ALUNO_ID) {
    tabelasExistentes[tabela] = await tabelaExiste(tabela);
  }
  const ausentes = TABELAS_COM_ALUNO_ID.filter((t) => !tabelasExistentes[t]);
  if (ausentes.length > 0) {
    console.log(`(tabelas ausentes neste banco, serão ignoradas: ${ausentes.join(', ')})\n`);
  }

  const grupos = await db.execute(`
    SELECT nome, cpf, COUNT(*) as n
    FROM alunos
    WHERE cpf IS NOT NULL AND cpf != ''
    GROUP BY nome, cpf
    HAVING COUNT(*) > 1
    ORDER BY nome
  `);

  console.log(`Grupos de aluno duplicado (mesmo nome + CPF): ${grupos.rows.length}\n`);

  if (grupos.rows.length === 0) {
    console.log('Nada a mesclar.');
    return;
  }

  for (const grupo of grupos.rows) {
    const membros = await db.execute({
      sql: `SELECT id, criado_em, secullum_id, status FROM alunos WHERE nome = ? AND cpf = ? ORDER BY criado_em`,
      args: [grupo.nome, grupo.cpf],
    });

    console.log(`--- ${grupo.nome} (CPF ${grupo.cpf}) — ${membros.rows.length} cadastros ---`);

    const candidatos = [];
    for (const m of membros.rows) {
      const { total, detalhe } = await contarRelacionados(m.id, tabelasExistentes);
      candidatos.push({ ...m, total, detalhe });
      console.log(`  id=${m.id} secullum_id=${m.secullum_id} criado_em=${m.criado_em} status=${m.status} -> ${total} registro(s) ligado(s) (${JSON.stringify(detalhe)})`);
    }

    // Escolhe o sobrevivente: mais registros relacionados; empate -> mais antigo.
    candidatos.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.criado_em < b.criado_em ? -1 : 1;
    });
    const sobrevivente = candidatos[0];
    const duplicados = candidatos.slice(1);

    console.log(`  => SOBREVIVENTE: id=${sobrevivente.id} (${sobrevivente.total} registro(s))`);
    for (const d of duplicados) {
      console.log(`  => apagar: id=${d.id} (${d.total} registro(s)) depois de reapontar tudo pro sobrevivente`);
    }
    console.log('');

    if (!APLICAR) continue;

    for (const d of duplicados) {
      for (const tabela of TABELAS_COM_ALUNO_ID) {
        if (!tabelasExistentes[tabela]) continue;
        await db.execute({
          sql: `UPDATE ${tabela} SET aluno_id = ? WHERE aluno_id = ?`,
          args: [sobrevivente.id, d.id],
        });
      }
      await db.execute({ sql: `DELETE FROM alunos WHERE id = ?`, args: [d.id] });
      console.log(`  [OK] ${grupo.nome}: id=${d.id} mesclado em id=${sobrevivente.id} e apagado`);
    }
  }

  if (!APLICAR) {
    console.log('=== FIM (dry-run — nada foi mesclado) ===');
    console.log('Se o plano acima fizer sentido, rode de novo com --aplicar:');
    console.log('  node scripts/mesclar-alunos-duplicados.js --aplicar');
  } else {
    console.log('=== FIM (mesclagem concluída) ===');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
