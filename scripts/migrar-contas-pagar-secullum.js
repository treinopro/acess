// Migração do histórico de "Contas a Pagar" do Secullum Academia.Net pro
// academia-gestao (2026-07-28) — mesmo espírito de scripts/migrar-secullum-v2.js,
// só que pra despesas em vez de mensalidades. A tabela contas_pagar era nova
// (criada nesta sessão) e nunca tinha nenhum dado histórico — sem essa
// migração, o relatório de Balanço não tinha nenhuma despesa passada pra
// comparar com o que já foi recebido, o que inflava o "saldo atual" (bug
// real relatado e corrigido junto com esta migração).
//
// Fonte dos dados: tabela `contas_pagar` do banco Secullum restaurado
// (SeculumAcademiaNet_Restaurado, SQL Server local — mesmo backup já usado
// na migração original de Contas a Receber), exportada pra
// export/contas_pagar.csv com os nomes de credor já resolvidos (empresa ou
// pessoa) e as datas/status já calculados a partir das colunas reais do
// Secullum (ver comentário abaixo sobre o "vencimento" confuso de lá).
//
// NOTA sobre os nomes de coluna do Secullum (pra quem for reexportar no
// futuro): na tabela contas_pagar deles, "previsao_data"/"previsao_valor"
// são o vencimento/valor ESPERADOS (sempre preenchidos), enquanto a coluna
// chamada "vencimento" (nome confuso) só é preenchida quando a conta é
// efetivamente PAGA — funciona, na prática, como a data do pagamento.
// "valor_total" é o valor realmente pago. Já resolvido assim no export.
//
// Idempotência: cada linha importada carrega contas_pagar.secullum_id (id
// original de lá) — rodar de novo nunca duplica, só pula quem já existe.
//
// Como rodar (a partir da pasta academia-gestao):
//   1) node scripts/migrar-contas-pagar-secullum.js --dry-run   (só mostra contagens)
//   2) node scripts/migrar-contas-pagar-secullum.js             (grava de verdade, local.db)
// Contra PRODUÇÃO (Turso), só depois de revisar o dry-run com o usuário:
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/migrar-contas-pagar-secullum.js --dry-run --confirmar-producao"
//   (revisar o relatório, só então repetir sem --dry-run)

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
require('dotenv').config();
const { createClient } = require('@libsql/client');

const DATABASE_URL = process.env.DATABASE_URL || 'file:./local.db';
const USANDO_PRODUCAO = DATABASE_URL !== 'file:./local.db';
const CONFIRMAR_PRODUCAO = process.argv.includes('--confirmar-producao');
if (USANDO_PRODUCAO && !CONFIRMAR_PRODUCAO) {
  console.error('\n=== BLOQUEADO ===');
  console.error('DATABASE_URL aponta para um banco que NAO e o local.db de teste:');
  console.error(`  ${DATABASE_URL}`);
  console.error('Se for isso mesmo que voce quer, rode de novo com --confirmar-producao.');
  console.error('Se NAO era a intencao, feche esta janela do PowerShell e abra uma nova.');
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

const EXPORT_DIR = path.join(__dirname, '..', '..', 'export');
const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// CSV parsing — mesmo parser de migrar-secullum-v2.js (aspas + "" escapado)
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignora
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const header = rows[0];
  return rows
    .slice(1)
    .filter((r) => r.length === header.length)
    .map((r) => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = r[idx]; });
      return obj;
    });
}

function lerCSV(nomeArquivo) {
  const caminho = path.join(EXPORT_DIR, nomeArquivo);
  let texto = fs.readFileSync(caminho, 'utf8');
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  return parseCSV(texto);
}

function moedaParaCentavos(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : Math.round(n * 100);
}

async function main() {
  const linhas = lerCSV('contas_pagar.csv');
  console.log(`Lidas ${linhas.length} linhas de export/contas_pagar.csv.`);

  let novas = 0;
  let jaExistiam = 0;
  let comErro = 0;
  const somaPorStatus = { pendente: 0, atrasado: 0, pago: 0 };

  for (const linha of linhas) {
    try {
      const existente = await db.execute({
        sql: 'SELECT id FROM contas_pagar WHERE secullum_id = ?',
        args: [linha.secullum_id],
      });
      if (existente.rows.length) {
        jaExistiam += 1;
        continue;
      }

      const valorCentavos = moedaParaCentavos(linha.previsao_valor);
      const valorPagoCentavos = linha.status === 'pago' ? moedaParaCentavos(linha.valor_pago) : null;
      somaPorStatus[linha.status] = (somaPorStatus[linha.status] || 0) + (valorCentavos || 0);

      if (!DRY_RUN) {
        await db.execute({
          sql: `INSERT INTO contas_pagar
                  (id, credor, descricao, valor_centavos, vencimento, status, pago_em, valor_pago_centavos, secullum_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            uuid(), linha.credor, linha.descricao || null, valorCentavos, linha.vencimento,
            linha.status, linha.pago_em || null, valorPagoCentavos, linha.secullum_id,
          ],
        });
      }
      novas += 1;
    } catch (err) {
      comErro += 1;
      console.error(`Erro na linha secullum_id=${linha.secullum_id}:`, err.message);
    }
  }

  console.log(`\n${DRY_RUN ? '=== DRY-RUN (nada foi gravado) ===' : '=== GRAVADO ==='}`);
  console.log(`Novas: ${novas}`);
  console.log(`Já existiam (puladas): ${jaExistiam}`);
  console.log(`Com erro: ${comErro}`);
  console.log('Soma por status (das novas):');
  console.log(`  pendente: R$ ${(somaPorStatus.pendente / 100).toFixed(2)}`);
  console.log(`  atrasado: R$ ${(somaPorStatus.atrasado / 100).toFixed(2)}`);
  console.log(`  pago:     R$ ${(somaPorStatus.pago / 100).toFixed(2)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro na migração:', err);
    process.exit(1);
  });
