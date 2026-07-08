// Alguns planos foram cadastrados em duplicidade (mesmo nome+tipo+valor). Quando isso
// acontece, é comum o desconto (aba Planos > desconto por forma de pagamento) ter sido
// configurado só numa das cópias — geralmente a antiga, que já não tem nenhum aluno
// matriculado — enquanto a cópia que os alunos realmente usam ficou sem desconto. Esse
// script encontra esses casos automaticamente e copia a configuração de desconto da
// cópia "doadora" (sem matrícula, mas com desconto) pra cópia "em uso" (com matrícula,
// mas sem desconto) — sem mexer em mais nada.
//
// Só age quando o caso é 100% inequívoco: dentro do grupo de duplicatas, exatamente uma
// cópia tem matrícula(s) e está SEM desconto, e exatamente uma outra cópia (sem
// matrícula nenhuma) está COM desconto configurado. Qualquer outra combinação (nenhuma
// com desconto, mais de uma com desconto, a que já tem matrícula já tem desconto também,
// etc.) fica de fora — só relatório, nada é alterado.
//
// Por padrão (sem --aplicar) é SOMENTE LEITURA — só mostra o que faria.
//
// Como rodar contra o local.db de teste (a partir da pasta academia-gestao):
//   node scripts/corrigir-desconto-planos-duplicados.js            (dry-run)
//   node scripts/corrigir-desconto-planos-duplicados.js --aplicar  (aplica de verdade)
//
// Como rodar contra PRODUCAO:
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/corrigir-desconto-planos-duplicados.js --confirmar-producao"
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/corrigir-desconto-planos-duplicados.js --aplicar --confirmar-producao"

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

function descreverDesconto(p) {
  if (!p.desconto_tipo) return 'sem desconto configurado';
  const valor = p.desconto_tipo === 'percentual' ? `${p.desconto_percentual}%` : formatarMoeda(p.desconto_valor_centavos);
  return `${valor} no ${p.desconto_forma_pagamento || '?'}`;
}

function chaveGrupo(p) {
  const nome = String(p.nome || '').trim().toLowerCase();
  return `${nome}__${p.tipo}__${p.valor_centavos}`;
}

function lerFlag(nome) {
  return process.argv.includes(`--${nome}`);
}

async function main() {
  const aplicar = lerFlag('aplicar');
  const result = await db.execute(`
    SELECT p.*,
      (SELECT COUNT(*) FROM matriculas m WHERE m.plano_id = p.id) AS total_matriculas
    FROM planos p
    ORDER BY p.nome, p.valor_centavos, p.criado_em
  `);
  const planos = result.rows;

  const grupos = new Map();
  for (const p of planos) {
    const chave = chaveGrupo(p);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(p);
  }
  const duplicados = [...grupos.values()].filter((g) => g.length > 1);

  if (!duplicados.length) {
    console.log('Nenhum plano duplicado encontrado — nada a fazer.');
    return;
  }

  const correcoes = [];
  console.log('=== ANALISANDO DUPLICATAS ===\n');
  for (const grupo of duplicados) {
    const nome = grupo[0].nome;
    console.log(`"${nome}" (${grupo[0].tipo}, ${formatarMoeda(grupo[0].valor_centavos)}) — ${grupo.length} cadastros:`);
    for (const p of grupo) {
      console.log(`  id ${p.id} | ${p.total_matriculas} matrícula(s) | ${descreverDesconto(p)} | criado em ${p.criado_em}`);
    }

    const emUsoSemDesconto = grupo.filter((p) => p.total_matriculas > 0 && !p.desconto_tipo);
    const orfaComDesconto = grupo.filter((p) => p.total_matriculas === 0 && p.desconto_tipo);

    if (emUsoSemDesconto.length === 1 && orfaComDesconto.length === 1) {
      const alvo = emUsoSemDesconto[0];
      const doador = orfaComDesconto[0];
      console.log(`  -> Vou copiar o desconto de ${doador.id} (órfão) para ${alvo.id} (em uso, sem desconto).`);
      correcoes.push({ alvo, doador });
    } else {
      console.log('  -> Nada a corrigir automaticamente aqui (ou já está OK, ou é ambíguo — revise na mão).');
    }
    console.log('');
  }

  console.log('=== RESUMO ===');
  console.log(`Planos duplicados com correção de desconto identificada: ${correcoes.length}`);
  for (const { alvo, doador } of correcoes) {
    console.log(`  "${alvo.nome}": id ${alvo.id} vai receber "${descreverDesconto(doador)}" (copiado de ${doador.id})`);
  }

  if (!aplicar) {
    console.log('\nEste script não alterou nada — é só um relatório (dry-run). Revise a lista acima e rode de novo com --aplicar pra aplicar as correções listadas.');
    return;
  }

  if (!correcoes.length) {
    console.log('\n--aplicar informado, mas não há nenhuma correção identificada agora. Nada foi feito.');
    return;
  }

  console.log(`\n=== APLICANDO: corrigindo desconto em ${correcoes.length} plano(s) ===`);
  for (const { alvo, doador } of correcoes) {
    await db.execute({
      sql: `UPDATE planos SET desconto_tipo = ?, desconto_percentual = ?, desconto_valor_centavos = ?, desconto_forma_pagamento = ? WHERE id = ?`,
      args: [doador.desconto_tipo, doador.desconto_percentual, doador.desconto_valor_centavos, doador.desconto_forma_pagamento, alvo.id],
    });
    console.log(`  Corrigido: "${alvo.nome}" (id ${alvo.id}) agora com ${descreverDesconto(doador)}.`);
  }
  console.log(`\n${correcoes.length} plano(s) corrigido(s). Agora dá pra excluir as cópias órfãs com segurança (scripts/relatorio-planos-duplicados.js --aplicar).`);
}

main()
  .catch((err) => {
    console.error('Erro:', err.message);
    process.exit(1);
  })
  .finally(() => process.exit(0));
