// Lista os planos agrupados por nome+tipo+valor (as "duplicatas" prováveis) e mostra,
// pra cada um, quantas matrículas de verdade apontam pra ele — pra decidirmos com
// segurança quais planos duplicados não têm nenhum aluno matriculado e podem ser
// excluídos, mantendo só o(s) que realmente estão em uso.
//
// Este script é SOMENTE LEITURA — não apaga nada. É só um relatório pra revisão manual.
//
// Como rodar contra o local.db de teste (a partir da pasta academia-gestao):
//   node scripts/relatorio-planos-duplicados.js
//
// Como rodar contra PRODUCAO:
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/relatorio-planos-duplicados.js --confirmar-producao"

require('dotenv').config();
const { createClient } = require('@libsql/client');

const DATABASE_URL = process.env.DATABASE_URL || 'file:./local.db';
const USANDO_PRODUCAO = DATABASE_URL !== 'file:./local.db';
const CONFIRMAR_PRODUCAO = process.argv.includes('--confirmar-producao');
if (USANDO_PRODUCAO && !CONFIRMAR_PRODUCAO) {
  console.error('\n=== BLOQUEADO ===');
  console.error('DATABASE_URL aponta para um banco que NAO e o local.db de teste:');
  console.error(`  ${DATABASE_URL}`);
  console.error('Rode de novo com --confirmar-producao se for isso mesmo que voce quer.');
  process.exit(1);
}

const db = createClient({
  url: DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

if (USANDO_PRODUCAO) {
  console.log('\n=========================================================');
  console.log(' ATENCAO: conectado em PRODUCAO (Turso), nao e o local.db');
  console.log(` URL: ${DATABASE_URL}`);
  console.log('=========================================================\n');
}

function formatarMoeda(centavos) {
  return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function chaveGrupo(p) {
  // Agrupa por nome (normalizado) + tipo + valor — mesma "aparência" de plano pro
  // usuário final, mesmo que tenha sido cadastrado mais de uma vez em momentos
  // diferentes (ex.: migração duplicada do Secullum).
  const nome = String(p.nome || '').trim().toLowerCase();
  return `${nome}__${p.tipo}__${p.valor_centavos}`;
}

async function main() {
  const result = await db.execute(`
    SELECT p.*,
      (SELECT COUNT(*) FROM matriculas m WHERE m.plano_id = p.id) AS total_matriculas,
      (SELECT COUNT(*) FROM matriculas m WHERE m.plano_id = p.id AND m.status = 'ativa') AS matriculas_ativas
    FROM planos p
    ORDER BY p.nome, p.valor_centavos, p.criado_em
  `);
  const planos = result.rows;
  console.log(`Total de planos cadastrados: ${planos.length}\n`);

  const grupos = new Map();
  for (const p of planos) {
    const chave = chaveGrupo(p);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(p);
  }

  const duplicados = [...grupos.values()].filter((g) => g.length > 1);
  const semDuplicata = [...grupos.values()].filter((g) => g.length === 1);

  console.log(`Grupos sem duplicata (só 1 plano com esse nome+tipo+valor): ${semDuplicata.length}`);
  console.log(`Grupos com duplicata (2+ planos iguais cadastrados): ${duplicados.length}\n`);

  if (!duplicados.length) {
    console.log('Nenhum plano duplicado encontrado — nada a fazer.');
    return;
  }

  const candidatosExclusao = [];
  const precisamRevisaoManual = [];

  console.log('=== DUPLICATAS ENCONTRADAS ===\n');
  for (const grupo of duplicados) {
    const nome = grupo[0].nome;
    const tipo = grupo[0].tipo;
    const valor = formatarMoeda(grupo[0].valor_centavos);
    console.log(`"${nome}" (${tipo}, ${valor}) — ${grupo.length} cadastros:`);
    const comUso = grupo.filter((p) => p.total_matriculas > 0);
    const semUso = grupo.filter((p) => p.total_matriculas === 0);
    for (const p of grupo) {
      const status = p.ativo ? 'ativo' : 'INATIVO';
      console.log(
        `  id ${p.id} | ${status} | ${p.total_matriculas} matrícula(s) total (${p.matriculas_ativas} ativa(s)) | criado em ${p.criado_em}`
      );
    }
    if (comUso.length === 1 && semUso.length === grupo.length - 1) {
      console.log(`  -> Mantém id ${comUso[0].id} (é o único com matrícula). Exclui os outros ${semUso.length}.`);
      candidatosExclusao.push(...semUso);
    } else if (comUso.length === 0) {
      console.log(`  -> Nenhum dos ${grupo.length} tem matrícula nenhuma. Nenhum uso real — revisão manual pra decidir qual manter (ou excluir todos).`);
      precisamRevisaoManual.push(grupo);
    } else {
      console.log(`  -> ${comUso.length} desses TÊM matrícula (mais de um "real"?). Revisão manual necessária, não vou sugerir exclusão automática aqui.`);
      precisamRevisaoManual.push(grupo);
    }
    console.log('');
  }

  console.log('=== RESUMO ===');
  console.log(`Planos duplicados SEM nenhuma matrícula, seguros pra excluir (mantendo o(s) que tem uso): ${candidatosExclusao.length}`);
  if (candidatosExclusao.length) {
    console.log('IDs sugeridos para exclusão:');
    for (const p of candidatosExclusao) {
      console.log(`  ${p.id}  ("${p.nome}", ${p.tipo}, ${formatarMoeda(p.valor_centavos)}, ${p.total_matriculas} matrículas)`);
    }
  }
  console.log(`\nGrupos que precisam de revisão manual (ambíguos — nenhum uso, ou mais de um com uso): ${precisamRevisaoManual.length}`);

  console.log('\nEste script não apagou nada — é só um relatório. Revise a lista acima antes de decidir o que excluir.');
}

main()
  .catch((err) => {
    console.error('Erro:', err.message);
    process.exit(1);
  })
  .finally(() => process.exit(0));
