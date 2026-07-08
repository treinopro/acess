// SOMENTE identifica e apaga cobrancas provedor='recorrencia' que sao
// duplicata de uma cobranca provedor='legado' JA EXISTENTE pra mesma
// matricula_id + vencimento. Usa '../src/db/client' de proposito - isso
// mexe na PRODUCAO (Turso), o mesmo banco que o servidor real usa.
//
// Contexto: subimos o servidor local sem perceber que ele conecta na
// producao (nao no local.db de teste). A rotina de recorrencia rodou no(s)
// boot(s) do servidor e, pra matriculas cuja cobranca 'legado' mais recente
// tinha o MESMO vencimento que o proximo ciclo calculado, criou uma
// cobranca 'recorrencia' nova em vez de reconhecer que aquele ciclo ja
// tinha conta (a checagem "jaExiste" olha matricula_id+vencimento, mas o
// caso real é a legado ter um vencimento X e o calculo gerar o mesmo X por
// coincidencia de ciclo - vamos confirmar isso com o relatorio abaixo antes
// de apagar qualquer coisa).
//
// REGRA DE SEGURANCA: só marca como "seguro apagar" cobrancas
// provedor='recorrencia' que:
//   1) tem uma cobranca provedor='legado' na MESMA matricula_id + vencimento
//   2) estao com status='pendente' (nunca mexe em paga/atrasada/cancelada)
// Cobrancas 'recorrencia' que nao batem com uma legado existente NAO sao
// tocadas por este script (podem ser ciclos legitimos gerados normalmente).
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/limpar-recorrencia-duplicada-producao.js            (dry-run)
//   node scripts/limpar-recorrencia-duplicada-producao.js --aplicar   (apaga de verdade)

const db = require('../src/db/client');

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO (apaga de verdade, PRODUCAO)' : 'DRY-RUN (só mostra, não apaga nada)'} ===\n`);

  const pares = await db.execute(`
    SELECT
      r.id as recorrencia_id, r.status as recorrencia_status, r.valor_centavos, r.criado_em as recorrencia_criado_em,
      l.id as legado_id,
      a.nome, r.matricula_id, r.vencimento
    FROM cobrancas r
    JOIN cobrancas l ON l.matricula_id = r.matricula_id AND l.vencimento = r.vencimento AND l.provedor = 'legado'
    JOIN alunos a ON a.id = r.aluno_id
    WHERE r.provedor = 'recorrencia'
    ORDER BY r.criado_em DESC
  `);

  console.log(`Cobranças 'recorrencia' que duplicam uma 'legado' já existente (mesma matrícula + vencimento): ${pares.rows.length}\n`);

  const seguras = [];
  const naoSeguras = [];
  for (const p of pares.rows) {
    const valorReais = (Number(p.valor_centavos) / 100).toFixed(2).replace('.', ',');
    if (p.recorrencia_status === 'pendente') {
      seguras.push(p);
      console.log(`  [apagar] ${p.nome} | vencimento=${p.vencimento} | R$${valorReais} | status=${p.recorrencia_status} | criado_em=${p.recorrencia_criado_em} | recorrencia_id=${p.recorrencia_id} (legado_id=${p.legado_id})`);
    } else {
      naoSeguras.push(p);
      console.log(`  [MANTER] ${p.nome} | vencimento=${p.vencimento} | R$${valorReais} | status=${p.recorrencia_status} (não é 'pendente' - não mexo) | recorrencia_id=${p.recorrencia_id}`);
    }
  }

  console.log(`\nResumo: ${seguras.length} seguras para apagar (pendentes), ${naoSeguras.length} mantidas (status diferente de pendente).`);

  if (!APLICAR) {
    console.log('\n=== FIM (dry-run — nada foi apagado) ===');
    if (seguras.length > 0) {
      console.log('Se a lista "[apagar]" acima fizer sentido, rode de novo com --aplicar:');
      console.log('  node scripts/limpar-recorrencia-duplicada-producao.js --aplicar');
    }
    return;
  }

  for (const p of seguras) {
    await db.execute({ sql: `DELETE FROM cobrancas WHERE id = ?`, args: [p.recorrencia_id] });
  }
  console.log(`\n=== FIM: ${seguras.length} cobrança(s) duplicada(s) apagada(s) ===`);
  if (naoSeguras.length > 0) {
    console.log(`${naoSeguras.length} mantida(s) por não estar 'pendente' - revise manualmente se necessário (lista acima).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
