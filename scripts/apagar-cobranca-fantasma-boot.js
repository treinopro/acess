// SEGURANCA MAXIMA: apaga UMA UNICA cobranca especifica, identificada por
// uma combinacao bem precisa de campos (matricula, provedor, vencimento e
// o timestamp exato de criacao). Isso mexe na PRODUCAO (Turso) - usa
// '../src/db/client', o mesmo cliente do app de verdade, de proposito.
//
// Contexto: subimos o servidor local sem perceber que o .env aponta pro
// Turso de producao (nao pro local.db de teste). No boot, a rotina de
// recorrencia rodou contra a producao e gerou 1 cobranca a mais pra Maria
// clara de melo (a producao nunca passou pela "adocao" de cobranca legado
// que fizemos no local.db, entao ela nao tinha de onde a rotina "continuar"
// certo).
//
// MODO SEGURO POR PADRAO: dry-run sem --aplicar. So mostra a linha
// encontrada, NAO apaga nada. So aceita aplicar se encontrar EXATAMENTE 1
// linha correspondente - se encontrar 0 ou mais de 1, para e avisa, por
// seguranca.
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/apagar-cobranca-fantasma-boot.js            (dry-run)
//   node scripts/apagar-cobranca-fantasma-boot.js --aplicar   (apaga de verdade)

const db = require('../src/db/client');

const APLICAR = process.argv.includes('--aplicar');

// Identifica a cobranca fantasma exata (veja o diagnostico rodado antes):
const MATRICULA_ID = '49db4284-34ec-4178-9d5b-0873e27fa0d6';
const VENCIMENTO = '2026-07-10';
const PROVEDOR = 'recorrencia';
const CRIADO_EM = '2026-07-08 01:45:52';

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO (apaga de verdade, PRODUCAO)' : 'DRY-RUN (só mostra, não apaga nada)'} ===\n`);

  const r = await db.execute({
    sql: `SELECT c.*, a.nome FROM cobrancas c JOIN alunos a ON a.id = c.aluno_id
          WHERE c.matricula_id = ? AND c.vencimento = ? AND c.provedor = ? AND c.criado_em = ?`,
    args: [MATRICULA_ID, VENCIMENTO, PROVEDOR, CRIADO_EM],
  });

  console.log(`Encontradas: ${r.rows.length} linha(s) correspondentes.\n`);
  for (const c of r.rows) {
    const valorReais = (Number(c.valor_centavos) / 100).toFixed(2).replace('.', ',');
    console.log(`  id=${c.id} aluno=${c.nome} valor=R$${valorReais} status=${c.status} vencimento=${c.vencimento} provedor=${c.provedor} criado_em=${c.criado_em}`);
  }

  if (r.rows.length !== 1) {
    console.log('\nABORTADO: esperava encontrar exatamente 1 linha, encontrei ' + r.rows.length + '. Não apagando nada por segurança.');
    return;
  }

  const alvo = r.rows[0];

  if (alvo.status !== 'pendente') {
    console.log(`\nABORTADO: a cobrança encontrada está com status "${alvo.status}", não "pendente" como esperado. Não apagando por segurança (pode já ter sido paga ou alterada).`);
    return;
  }

  if (!APLICAR) {
    console.log('\n=== FIM (dry-run — nada foi apagado) ===');
    console.log('Se a linha acima for exatamente a cobrança duplicada indevida, rode de novo com --aplicar:');
    console.log('  node scripts/apagar-cobranca-fantasma-boot.js --aplicar');
    return;
  }

  await db.execute({ sql: `DELETE FROM cobrancas WHERE id = ?`, args: [alvo.id] });
  console.log(`\n=== APAGADA: cobranca id=${alvo.id} (${alvo.nome}, R$${(Number(alvo.valor_centavos) / 100).toFixed(2).replace('.', ',')}, vencimento ${alvo.vencimento}) ===`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
