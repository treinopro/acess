// Migracao v2 de dados do Secullum Academia.Net (CSV) para o banco novo
// (SQLite/libSQL) do academia-gestao. Reescrita para corrigir dois bugs
// encontrados na v1 (scripts/migrar-secullum.js, mantido intacto como
// referencia/histórico — não apagar):
//
// BUG 1 (duplicação em reruns): a v1 gerava um uuid() novo a cada execução e
// usava INSERT OR IGNORE, mas como o id nunca colidia entre tentativas, uma
// migração interrompida e re-executada duplicava alunos/matrículas/cobranças
// inteiros. AQUI: cada linha importada carrega o id original do Secullum
// (secullum_id / secullum_numero, colunas novas em schema.sql) e o script
// primeiro CONSULTA o banco por esse id antes de inserir - se já existe,
// reaproveita o id novo já atribuído da vez anterior, nunca duplica.
//
// BUG 2 (cobrança fantasma pós-migração): a rotina gerarCobrancasRecorrentes
// (src/services/cobrancas.service.js), que roda sozinha a cada boot do
// servidor, calcula "próximo vencimento" olhando a cobrança mais recente
// LIGADA por matricula_id — mas cobranças legado importadas nunca tinham
// matricula_id, então a rotina achava que toda matrícula importada era nova
// e lançava uma "primeira cobrança" na data_inicio (às vezes anos atrás,
// e pior: pessoas_servicos.data_inicio no Secullum às vezes reflete a DATA
// DE PAGAMENTO/renovação mais recente, não um vencimento de verdade - ver
// caso real: Edna Andrade, matrícula "Consultoria trimestral" com
// data_inicio=2026-04-22, que é a data em que ela pagou uma mensalidade de
// MUSCULAÇÃO completamente diferente no mesmo dia). AQUI: pra cada matrícula
// recorrente, a cobrança 'legado' mais recente da MESMA pessoa+serviço (por
// servico_id, não só "por perto no tempo") é ADOTADA via matricula_id - sem
// criar nenhuma cobrança nova - então gerarCobrancasRecorrentes encontra de
// onde continuar e nunca mais inventa uma primeira cobrança fantasma. O
// dia-alvo de vencimento vem de pessoas_servicos.dia_vencimento (campo por
// matrícula individual), não mais calculado a partir de data_inicio.
//
// Como rodar CONTRA O LOCAL.DB DE TESTE (a partir da pasta academia-gestao):
//   0) node scripts/zerar-dados-alunos.js --aplicar        (limpa a tentativa anterior)
//   1) node scripts/aplicar-colunas-secullum.js             (garante as colunas novas)
//   2) node scripts/migrar-secullum-v2.js --dry-run         (só mostra contagens/relatório)
//   3) node scripts/migrar-secullum-v2.js                    (grava de verdade)
//
// Como rodar CONTRA PRODUÇÃO (Turso) — só depois de validado no local.db,
// com backup feito e decisão tomada com o usuário presente:
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/migrar-secullum-v2.js --dry-run --confirmar-producao"
//   (revisar o relatório com calma, só então repetir sem --dry-run)
// O wrapper .ps1 pede confirmação digitada e define DATABASE_URL/
// DATABASE_AUTH_TOKEN de produção só para aquela janela do PowerShell (não
// mexe no .env). A flag --confirmar-producao é uma segunda trava: mesmo que
// DATABASE_URL de produção esteja setado no ambiente por engano (ex.:
// sobrou de uma sessão anterior do PowerShell), o script recusa a rodar sem
// ela — nunca escreve em produção "sem querer".
//
// IMPORTANTE: não suba o servidor (npm start / npm run dev) nem rode
// `npm run gerar-cobrancas` entre o passo 3 (local ou produção) e a
// conferência do relatório — gerarCobrancasRecorrentes roda sozinha no boot
// do servidor.

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const { createClient } = require('@libsql/client');

// Mesmo padrão de src/db/client.js: por padrão usa local.db. Só troca de
// banco se DATABASE_URL já estiver definido como variável de ambiente ANTES
// deste processo iniciar — dotenv nunca sobrescreve uma env var já setada.
// Isso só acontece de propósito, via scripts/rodar-producao-migracao.ps1;
// nunca edite o .env na mão pra isso (ver instruções de uso no topo deste
// arquivo).
const DATABASE_URL = process.env.DATABASE_URL || 'file:./local.db';
const USANDO_PRODUCAO = DATABASE_URL !== 'file:./local.db';

// Trava extra, independente da variável de ambiente: contra um banco que
// não é o local.db de teste, este script só roda com --confirmar-producao
// explícito na linha de comando. Sem essa flag, recusa e explica por quê —
// evita repetir o incidente de cobrança fantasma (ver STATUS-PROJETO.md,
// sessão 08/07/2026), causado por o servidor conectar em produção sem
// ninguém perceber.
const CONFIRMAR_PRODUCAO = process.argv.includes('--confirmar-producao');
if (USANDO_PRODUCAO && !CONFIRMAR_PRODUCAO) {
  console.error('\n=== BLOQUEADO ===');
  console.error('DATABASE_URL aponta para um banco que NAO e o local.db de teste:');
  console.error(`  ${DATABASE_URL}`);
  console.error('Isso normalmente significa que voce esta prestes a migrar contra PRODUCAO.');
  console.error('Se for isso mesmo que voce quer (com backup feito e decisao tomada),');
  console.error('rode de novo com --confirmar-producao.');
  console.error('Se NAO era a intencao, feche esta janela do PowerShell e abra uma nova');
  console.error('(essa variavel pode ter sobrado de uma sessao anterior).');
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
const SENHA_TEMPORARIA = 'Trocar@123';

// ---------------------------------------------------------------------------
// CSV parsing (Export-Csv do PowerShell: tudo entre aspas, "" = aspas literal)
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

function lerCSV(nomeTabela) {
  const caminho = path.join(EXPORT_DIR, `${nomeTabela}.csv`);
  let texto = fs.readFileSync(caminho, 'utf8');
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  return parseCSV(texto);
}

// ---------------------------------------------------------------------------
// Helpers de conversao
// ---------------------------------------------------------------------------
function vazio(v) { return v === undefined || v === null || v === ''; }
function txt(v) { return vazio(v) ? null : v; }

function boolBR(v) {
  if (vazio(v)) return null;
  if (v === 'True') return true;
  if (v === 'False') return false;
  return null;
}

function dataBR(v) {
  if (vazio(v)) return null;
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function dataHoraBR(v) {
  if (vazio(v)) return null;
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return dataBR(v);
  return `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}`;
}

function moedaParaCentavos(v) {
  if (vazio(v)) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

function numeroFlexivel(v) {
  if (vazio(v)) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function alturaParaCm(v) {
  const n = numeroFlexivel(v);
  if (n === null) return null;
  if (n > 0 && n <= 3) return Math.round(n * 100 * 10) / 10;
  if (n > 3 && n <= 260) return n;
  return null;
}

const MARCAS_DIACRITICAS = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');

function slugify(v) {
  return String(v)
    .normalize('NFD').replace(MARCAS_DIACRITICAS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Dia-alvo padrao (fallback só quando pessoas_servicos.dia_vencimento vem
// vazio no CSV): matrícula que começou entre os dias 1-15 cobra no dia 10;
// de 16 em diante, no dia 20. Mesma regra do cobrancas.service.js.
function diaVencimentoPadrao(dataISO) {
  const dia = Number(dataISO.slice(8, 10));
  return dia <= 15 ? 10 : 20;
}

// ---------------------------------------------------------------------------
// Fila de INSERTs/UPDATEs + envio em lotes (db.batch), com retry por lote.
// ---------------------------------------------------------------------------
const ERROS_TRANSITORIOS = /ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|fetch failed|EAI_AGAIN|socket hang up/i;
const MAX_TENTATIVAS = 6;
const TAMANHO_LOTE = 200;

let fila = [];
function enfileirar(sql, args) { fila.push({ sql, args: args || [] }); }

async function despejarLote(lote, contexto) {
  if (DRY_RUN) return;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      await db.batch(lote, 'write');
      return;
    } catch (err) {
      const mensagem = `${err.message} ${err.cause?.message || ''}`;
      const transitorio = ERROS_TRANSITORIOS.test(mensagem);
      if (!transitorio || tentativa === MAX_TENTATIVAS) throw err;
      const esperaMs = 1000 * 2 ** (tentativa - 1);
      console.warn(`  (rede instável em "${contexto}", tentativa ${tentativa}/${MAX_TENTATIVAS} — retry em ${esperaMs / 1000}s...)`);
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
}

async function flush(contexto = '') {
  if (DRY_RUN) { fila = []; return; }
  while (fila.length) {
    const lote = fila.splice(0, TAMANHO_LOTE);
    await despejarLote(lote, contexto);
  }
}

// ---------------------------------------------------------------------------
// Tabelas de referencia fixas
// ---------------------------------------------------------------------------
const TIPO_SERVICO = { '1': 'mensal', '2': 'semestral', '3': 'trimestral', '4': 'anual' };

const PAGTO_TIPO = {
  '0': 'dinheiro',
  '1': 'outro',
  '2': 'cartao_credito',
  '3': 'cartao_debito',
  '4': 'pix',
  '5': 'outro',
};

const CLASSIF_DESCRICAO = {
  '1': 'Visitante', '2': '(Desconhecida)', '3': 'Profissional E.D', '4': 'BOLSISTA',
  '5': 'INSTRUTOR', '6': '2', '7': 'INSTRUTOR(A)', '8': 'COLABORADOR(A)',
  '9': 'ALUNO(A)', '10': 'Especial', '11': 'Profissional EDF',
};
const CLASSIF_ALUNO = new Set(['9', '4', '10', null]);

function estadoParaStatusAluno(estado) {
  if (estado === '0') return 'ativo';
  if (estado === '2') return 'ativo';
  if (estado === '3') return 'inativo';
  return 'ativo';
}

// Catálogo de perguntas de anamnese - id DETERMINÍSTICO (não uuid()) pra ser
// idempotente de verdade em reruns, mesmo sem coluna secullum_id própria.
const CATALOGO_PERGUNTAS = [
  { key: 'bebida', texto: 'Ingere bebidas alcoólicas com frequência?', tipo: 'sim_nao' },
  { key: 'fumo', texto: 'Fuma?', tipo: 'sim_nao' },
  { key: 'medicamentos', texto: 'Faz uso de medicamentos contínuos?', tipo: 'sim_nao' },
  { key: 'medicamentos_quais', texto: 'Quais medicamentos?', tipo: 'texto' },
  { key: 'sono', texto: 'Dorme bem (pelo menos 8 horas por noite)?', tipo: 'sim_nao' },
  { key: 'esportes', texto: 'Pratica esportes?', tipo: 'sim_nao' },
  { key: 'esportes_quais', texto: 'Quais esportes?', tipo: 'texto' },
  { key: 'ginastica', texto: 'Pratica ginástica regularmente?', tipo: 'sim_nao' },
  { key: 'ginastica_modalidade', texto: 'Qual modalidade?', tipo: 'texto' },
  { key: 'dieta', texto: 'Faz dieta?', tipo: 'sim_nao' },
  { key: 'dieta_qual', texto: 'Qual dieta?', tipo: 'texto' },
  { key: 'acompanhamento_medico', texto: 'Tem acompanhamento médico?', tipo: 'sim_nao' },
  { key: 'acompanhamento_qual', texto: 'Qual?', tipo: 'texto' },
  { key: 'problema_fratura', texto: 'Possui fratura, cirurgia ou lesão?', tipo: 'sim_nao' },
  { key: 'problema_cardiaco', texto: 'Possui problema cardíaco?', tipo: 'sim_nao' },
  { key: 'problema_circulatorio', texto: 'Possui problema circulatório?', tipo: 'sim_nao' },
  { key: 'problema_endocrino', texto: 'Possui problema endócrino?', tipo: 'sim_nao' },
  { key: 'problema_ortopedico', texto: 'Possui problema ortopédico?', tipo: 'sim_nao' },
  { key: 'problema_respiratorio', texto: 'Possui problema respiratório?', tipo: 'sim_nao' },
  { key: 'enxaqueca', texto: 'Tem enxaquecas?', tipo: 'sim_nao' },
  { key: 'bronquite_asma', texto: 'Tem bronquite ou asma?', tipo: 'sim_nao' },
  { key: 'problemas_descricao', texto: 'Descreva os problemas de saúde (detalhes)', tipo: 'texto' },
  { key: 'placa_pinos', texto: 'É portador de placa, pinos ou próteses?', tipo: 'sim_nao' },
  { key: 'marca_passo', texto: 'É portador de marca-passo?', tipo: 'sim_nao' },
  { key: 'filhos', texto: 'Tem filhos?', tipo: 'sim_nao' },
  { key: 'filhos_quantos', texto: 'Quantos filhos?', tipo: 'texto' },
];

const ALT_PARA_PERGUNTA = {
  1: { pergunta: 'bebida', valor: 'sim' }, 2: { pergunta: 'bebida', valor: 'sim' }, 3: { pergunta: 'bebida', valor: 'nao' },
  4: { pergunta: 'fumo', valor: 'sim' }, 5: { pergunta: 'fumo', valor: 'nao' },
  6: { pergunta: 'medicamentos', valor: 'sim' }, 7: { pergunta: 'medicamentos', valor: 'nao' },
  8: { pergunta: 'medicamentos_quais', valor: 'texto' },
  9: { pergunta: 'sono', valor: 'sim' }, 10: { pergunta: 'sono', valor: 'sim' }, 11: { pergunta: 'sono', valor: 'nao' },
  12: { pergunta: 'esportes', valor: 'sim' }, 13: { pergunta: 'esportes', valor: 'nao' },
  14: { pergunta: 'esportes_quais', valor: 'texto' },
  15: { pergunta: 'ginastica', valor: 'sim' }, 16: { pergunta: 'ginastica', valor: 'nao' },
  17: { pergunta: 'ginastica_modalidade', valor: 'texto' },
  18: { pergunta: 'dieta', valor: 'sim' }, 19: { pergunta: 'dieta', valor: 'nao' },
  20: { pergunta: 'dieta_qual', valor: 'texto' },
  21: { pergunta: 'acompanhamento_medico', valor: 'sim' }, 22: { pergunta: 'acompanhamento_medico', valor: 'nao' },
  23: { pergunta: 'acompanhamento_qual', valor: 'texto' },
  24: { pergunta: 'problema_fratura', valor: 'sim' },
  25: { pergunta: 'problema_cardiaco', valor: 'sim' },
  26: { pergunta: 'problema_circulatorio', valor: 'sim' },
  27: { pergunta: 'problema_endocrino', valor: 'sim' },
  28: { pergunta: 'problema_ortopedico', valor: 'sim' },
  29: { pergunta: 'problema_respiratorio', valor: 'sim' },
  30: { pergunta: 'enxaqueca', valor: 'sim' },
  31: { pergunta: 'bronquite_asma', valor: 'sim' },
  71: { pergunta: 'problemas_descricao', valor: 'texto' },
  32: { pergunta: 'placa_pinos', valor: 'sim' },
  33: { pergunta: 'marca_passo', valor: 'sim' },
  34: { pergunta: 'filhos', valor: 'sim' }, 35: { pergunta: 'filhos', valor: 'nao' },
  36: { pergunta: 'filhos_quantos', valor: 'texto' },
};

const ALT_PARA_AVALIACAO = {
  37: { tipo: 'escolha', campo: 'perfil_morfologico', valor: 'Grande' },
  38: { tipo: 'escolha', campo: 'perfil_morfologico', valor: 'Média' },
  39: { tipo: 'escolha', campo: 'perfil_morfologico', valor: 'Delgada' },
  40: { tipo: 'num', campo: 'peso_kg' },
  41: { tipo: 'altura', campo: 'altura_cm' },
  42: { tipo: 'extra', chave: 'achado_edemas', valor: true },
  43: { tipo: 'extra', chave: 'achado_flacidez', valor: true },
  44: { tipo: 'extra', chave: 'achado_varizes', valor: true },
  45: { tipo: 'extra', chave: 'achado_dores', valor: true },
  46: { tipo: 'extra', chave: 'achado_estrias', valor: true },
  47: { tipo: 'extra', chave: 'achado_caimbras', valor: true },
  48: { tipo: 'texto', campo: 'objetivo' },
  49: { tipo: 'texto_append', campo: 'observacoes' },
  50: { tipo: 'num', campo: 'medida_cintura_cm' },
  51: { tipo: 'num', campo: 'medida_quadril_cm' },
  52: { tipo: 'num', campo: 'medida_coxa_cm' },
  53: { tipo: 'num', campo: 'medida_panturrilha_cm' },
  54: { tipo: 'num', campo: 'imc_atual' },
  55: { tipo: 'num', campo: 'imc_ideal' },
  70: { tipo: 'extra', chave: 'peso_proposto' },
  56: { tipo: 'extra', chave: 'massa_gorda_lean_imc' },
  63: { tipo: 'extra', chave: 'massa_gorda_lean_cintura' },
  64: { tipo: 'extra', chave: 'massa_gorda_kg' },
  66: { tipo: 'extra', chave: 'massa_gorda_classificacao', valor: 'Atleta' },
  67: { tipo: 'extra', chave: 'massa_gorda_classificacao', valor: 'Normal' },
  68: { tipo: 'extra', chave: 'massa_gorda_classificacao', valor: 'Elevado' },
  69: { tipo: 'extra', chave: 'massa_gorda_classificacao', valor: 'Muito elevado' },
  57: { tipo: 'num', campo: 'medida_braco_cm' },
  60: { tipo: 'extra', chave: 'massa_magra_percentual' },
  65: { tipo: 'num', campo: 'massa_magra_kg' },
  72: { tipo: 'extra', chave: 'massa_magra_obs' },
  93: { tipo: 'extra', chave: 'protocolo_dobras' },
  81: { tipo: 'extra', chave: 'massa_gorda_a' },
  89: { tipo: 'extra', chave: 'massa_gorda_a_classificacao', valor: 'Atleta' },
  90: { tipo: 'extra', chave: 'massa_gorda_a_classificacao', valor: 'Normal' },
  91: { tipo: 'extra', chave: 'massa_gorda_a_classificacao', valor: 'Elevado' },
  92: { tipo: 'extra', chave: 'massa_gorda_a_classificacao', valor: 'Muito elevado' },
  82: { tipo: 'extra', chave: 'dobra_triceps' },
  83: { tipo: 'extra', chave: 'dobra_subscapular' },
  84: { tipo: 'extra', chave: 'dobra_axilar_media' },
  85: { tipo: 'extra', chave: 'dobra_toracica' },
  86: { tipo: 'extra', chave: 'dobra_supra_iliaca' },
  87: { tipo: 'extra', chave: 'dobra_abdomen' },
  88: { tipo: 'extra', chave: 'dobra_reto_femoral' },
  94: { tipo: 'num', campo: 'iac' },
  95: { tipo: 'num', campo: 'medida_peito_cm' },
  96: { tipo: 'texto_append', campo: 'observacoes' },
  97: { tipo: 'extra', chave: 'idade_na_avaliacao' },
  59: { tipo: 'extra', chave: 'porcentagem_gordura_lean' },
};

// ---------------------------------------------------------------------------
// Execucao principal
// ---------------------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? '=== MODO DRY-RUN (nada sera gravado) ===' : '=== MIGRACAO V2 REAL (em lotes) ===');

  const relatorio = {
    alunosCriados: 0, alunosReaproveitados: 0,
    pessoasMarcadasParaRevisao: [],
    usuariosCriados: [],
    planosCriados: 0, planosReaproveitados: 0,
    matriculasCriadas: 0, matriculasReaproveitadas: 0,
    cobrancasCriadas: 0, cobrancasReaproveitadas: 0, cobrancasIgnoradasSemAluno: 0,
    pagamentosCriados: 0,
    anamnesesCriadas: 0, avaliacoesFisicasCriadas: 0, respostasAnamneseCriadas: 0,
    matriculasAdotaramCobrancaLegado: 0,
    matriculasSemCobrancaLegadoParaAdotar: [],
  };

  // --- 1. Perguntas de anamnese (catálogo fixo, id determinístico) ---
  const perguntaIdPorKey = {};
  let ordem = 1;
  for (const p of CATALOGO_PERGUNTAS) {
    const id = `pergunta:${p.key}`;
    perguntaIdPorKey[p.key] = id;
    enfileirar(
      'INSERT OR IGNORE INTO anamnese_perguntas (id, texto, tipo, ordem, ativo) VALUES (?, ?, ?, ?, 1)',
      [id, p.texto, p.tipo, ordem++]
    );
  }
  await flush('perguntas de anamnese');
  console.log(`[1/7] perguntas de anamnese: OK (${CATALOGO_PERGUNTAS.length})`);

  // --- 2. Pessoas -> alunos (idempotente via secullum_id = pessoas.id) ---
  const pessoas = lerCSV('pessoas');
  const alunoIdPorPessoa = {};
  const statusAlunoPorPessoa = {};

  const alunosExistentes = await db.execute(`SELECT id, secullum_id FROM alunos WHERE secullum_id IS NOT NULL`);
  const alunoIdPorSecullumId = {};
  alunosExistentes.rows.forEach((r) => { alunoIdPorSecullumId[r.secullum_id] = r.id; });

  let i = 0;
  for (const p of pessoas) {
    i++;
    const cls = p.classificacao_id;
    const naoEAlunoDeVerdade = cls && !CLASSIF_ALUNO.has(cls);
    if (naoEAlunoDeVerdade) {
      relatorio.pessoasMarcadasParaRevisao.push({ id: p.id, nome: p.nome, classificacao_id: cls, descricao: CLASSIF_DESCRICAO[cls] || cls });
    }

    const status = estadoParaStatusAluno(p.estado);
    statusAlunoPorPessoa[p.id] = status;

    if (alunoIdPorSecullumId[p.id]) {
      alunoIdPorPessoa[p.id] = alunoIdPorSecullumId[p.id];
      relatorio.alunosReaproveitados++;
      continue; // já migrado antes — não insere de novo, não sobrescreve edições manuais
    }

    const novoId = uuid();
    alunoIdPorPessoa[p.id] = novoId;

    const observacoes = [
      txt(p.obs),
      p.estado === '2' ? 'Livre (Secullum): acesso liberado independente de situação financeira.' : null,
      naoEAlunoDeVerdade ? `REVISAR: classificação original no Secullum era "${CLASSIF_DESCRICAO[cls] || cls}", não aluno.` : null,
    ].filter(Boolean).join(' | ') || null;

    enfileirar(
      `INSERT INTO alunos (id, nome, email, telefone, cpf, data_nascimento, status, observacoes, secullum_id, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        novoId, p.nome || '(sem nome)', txt(p.email), txt(p.celular) || txt(p.telefone), txt(p.cpf),
        dataBR(p.nascimento), status, observacoes, p.id, dataHoraBR(p.criacao_data) || new Date().toISOString(),
      ]
    );
    relatorio.alunosCriados++;

    if (i % 500 === 0) { await flush('alunos'); console.log(`  ... alunos: ${i}/${pessoas.length}`); }
  }
  await flush('alunos');
  console.log(`[2/7] alunos: OK (novos: ${relatorio.alunosCriados}, já existiam: ${relatorio.alunosReaproveitados})`);

  // --- 3. Usuarios (já idempotente via UNIQUE(usuario), sem mudanças) ---
  const usuariosSrc = lerCSV('usuarios');
  const usuariosUsados = new Set();
  for (const u of usuariosSrc) {
    if (u.nome === 'SYSTEM') continue;
    if (boolBR(u.desativado)) {
      relatorio.usuariosCriados.push({ nome: u.nome, ignorado: true, motivo: 'desativado no Secullum' });
      continue;
    }
    let login = slugify(u.nome) || `usuario${u.id}`;
    let sufixo = 1;
    while (usuariosUsados.has(login)) { login = `${slugify(u.nome)}${sufixo++}`; }
    usuariosUsados.add(login);

    const email = `${login}@legado.local`;
    const senhaHash = await bcrypt.hash(SENHA_TEMPORARIA, 10);
    const papel = boolBR(u.administrador) ? 'admin' : 'recepcao';

    enfileirar(
      `INSERT OR IGNORE INTO usuarios (id, nome, usuario, email, senha_hash, papel) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), u.nome, login, email, senhaHash, papel]
    );
    relatorio.usuariosCriados.push({ nome: u.nome, login, senhaTemporaria: SENHA_TEMPORARIA, papel });
  }
  await flush('usuarios');
  console.log(`[3/7] usuarios: OK (${relatorio.usuariosCriados.filter((u) => !u.ignorado).length})`);

  // --- 4. Servicos -> planos (idempotente via secullum_id = servicos.id) ---
  // Todos os 8 serviços cadastrados são planos de mensalidade de verdade
  // (confirmado com o cliente) — nenhum é forçado para "avulso".
  const servicos = lerCSV('servicos');
  const planoIdPorServico = {};

  const planosExistentes = await db.execute(`SELECT id, secullum_id FROM planos WHERE secullum_id IS NOT NULL`);
  const planoIdPorSecullumId = {};
  planosExistentes.rows.forEach((r) => { planoIdPorSecullumId[r.secullum_id] = r.id; });

  for (const s of servicos) {
    if (planoIdPorSecullumId[s.id]) {
      planoIdPorServico[s.id] = planoIdPorSecullumId[s.id];
      relatorio.planosReaproveitados++;
      continue;
    }
    const novoId = uuid();
    planoIdPorServico[s.id] = novoId;
    const intervalo = parseInt(s.intervalo, 10) || null;
    enfileirar(
      `INSERT INTO planos (id, nome, tipo, valor_centavos, duracao_dias, ativo, secullum_id) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [novoId, s.descricao || `Plano ${s.id}`, TIPO_SERVICO[s.tipo_servico_id] || 'mensal', moedaParaCentavos(s.valor) || 0, intervalo ? intervalo * 30 : null, s.id]
    );
    relatorio.planosCriados++;
  }
  await flush('planos');
  console.log(`[4/7] planos: OK (novos: ${relatorio.planosCriados}, já existiam: ${relatorio.planosReaproveitados})`);

  // --- 5. pessoas_servicos -> matriculas (idempotente via secullum_id) ---
  // pessoas_servicos.csv não tem coluna "id" própria — a chave de idempotência
  // é composta: pessoa_id + servico_id + data_inicio.
  const pessoasServicos = lerCSV('pessoas_servicos');
  const matriculaIdPorSecullumId = {};
  const matriculasExistentes = await db.execute(`SELECT id, secullum_id, aluno_id, plano_id FROM matriculas WHERE secullum_id IS NOT NULL`);
  matriculasExistentes.rows.forEach((r) => { matriculaIdPorSecullumId[r.secullum_id] = r; });

  // matriculaId -> { alunoId, servicoId } — usado no passo 6 (adoção de cobrança legado)
  const matriculasParaAdotar = [];

  let j = 0;
  for (const ps of pessoasServicos) {
    j++;
    const alunoId = alunoIdPorPessoa[ps.pessoa_id];
    const planoId = planoIdPorServico[ps.servico_id];
    if (!alunoId || !planoId) continue;

    const dataInicioSecullum = dataBR(ps.data_inicio) || new Date().toISOString().slice(0, 10);
    const chaveSecullum = `${ps.pessoa_id}:${ps.servico_id}:${dataInicioSecullum}`;
    const statusAluno = statusAlunoPorPessoa[ps.pessoa_id];

    if (matriculaIdPorSecullumId[chaveSecullum]) {
      relatorio.matriculasReaproveitadas++;
      matriculasParaAdotar.push({
        matriculaId: matriculaIdPorSecullumId[chaveSecullum].id,
        alunoId, pessoaId: ps.pessoa_id, servicoId: ps.servico_id,
      });
      continue;
    }

    const novoId = uuid();
    enfileirar(
      `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, status, renovacao_automatica, secullum_id)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [novoId, alunoId, planoId, dataInicioSecullum, statusAluno === 'inativo' ? 'expirada' : 'ativa', chaveSecullum]
    );
    relatorio.matriculasCriadas++;
    matriculasParaAdotar.push({ matriculaId: novoId, alunoId, pessoaId: ps.pessoa_id, servicoId: ps.servico_id });

    if (j % 500 === 0) await flush('matriculas');
  }
  await flush('matriculas');
  console.log(`[5/7] matriculas: OK (novas: ${relatorio.matriculasCriadas}, já existiam: ${relatorio.matriculasReaproveitadas})`);

  // --- 6. contas_receber -> cobrancas (idempotente via secullum_numero = contas_receber.id) ---
  const contasReceber = lerCSV('contas_receber');
  const pagamentos = lerCSV('contas_receber_pagtos');
  const pagamentosPorConta = {};
  for (const pg of pagamentos) { (pagamentosPorConta[pg.conta_receber_id] ||= []).push(pg); }

  const cobrancaIdPorConta = {};
  // Para o passo de adoção: por pessoa+servico, guarda a cobrança de MAIOR
  // vencimento (a mais recente) — essa é a que vira o "ponto de partida" da
  // matrícula pra rotina de recorrência continuar dali em diante.
  const cobrancaMaisRecentePorPessoaServico = {};

  const cobrancasExistentes = await db.execute(`SELECT id, secullum_numero, aluno_id, matricula_id, vencimento FROM cobrancas WHERE secullum_numero IS NOT NULL`);
  const cobrancaIdPorSecullumNumero = {};
  cobrancasExistentes.rows.forEach((r) => { cobrancaIdPorSecullumNumero[r.secullum_numero] = r; });

  const hoje = new Date().toISOString().slice(0, 10);
  let k = 0;
  for (const cr of contasReceber) {
    k++;
    const alunoId = alunoIdPorPessoa[cr.pessoa_id];
    if (!alunoId) { relatorio.cobrancasIgnoradasSemAluno++; continue; }

    const vencimento = dataBR(cr.vencimento);
    const chavePS = `${cr.pessoa_id}:${cr.servico_id}`;
    const atual = cobrancaMaisRecentePorPessoaServico[chavePS];
    if (!atual || (vencimento && vencimento > atual.vencimento)) {
      cobrancaMaisRecentePorPessoaServico[chavePS] = { vencimento, contaId: cr.id };
    }

    if (cobrancaIdPorSecullumNumero[cr.id]) {
      cobrancaIdPorConta[cr.id] = cobrancaIdPorSecullumNumero[cr.id].id;
      relatorio.cobrancasReaproveitadas++;
      continue; // já migrada antes, incluindo os pagamentos_cobranca dela — não repete
    }

    const quitado = boolBR(cr.quitado);
    let status = 'pendente';
    if (quitado) status = 'pago';
    else if (vencimento && vencimento < hoje) status = 'atrasado';

    const pagtosDaConta = pagamentosPorConta[cr.id] || [];
    let metodoPagamento = null;
    let pagoEm = null;
    if (pagtosDaConta.length) {
      const ultimo = pagtosDaConta.reduce((a, b) => (dataBR(b.pagto_data) > dataBR(a.pagto_data) ? b : a));
      metodoPagamento = PAGTO_TIPO[ultimo.pagto_tipo] || 'outro';
      pagoEm = dataHoraBR(ultimo.pagto_data);
    }

    const novoId = uuid();
    cobrancaIdPorConta[cr.id] = novoId;

    enfileirar(
      `INSERT INTO cobrancas (id, aluno_id, valor_centavos, status, provedor, metodo_pagamento, descricao, vencimento, pago_em, secullum_numero, criado_em)
       VALUES (?, ?, ?, ?, 'legado', ?, ?, ?, ?, ?, ?)`,
      [novoId, alunoId, moedaParaCentavos(cr.valor) || 0, status, metodoPagamento, txt(cr.observacao), vencimento, quitado ? pagoEm : null, cr.id, dataHoraBR(cr.alteracao_data) || new Date().toISOString()]
    );
    relatorio.cobrancasCriadas++;

    for (const pg of pagtosDaConta) {
      enfileirar(
        `INSERT OR IGNORE INTO pagamentos_cobranca (id, cobranca_id, data, valor_centavos, tipo, criado_em)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), novoId, dataBR(pg.pagto_data), moedaParaCentavos(pg.pagto_valor) || 0, PAGTO_TIPO[pg.pagto_tipo] || 'outro', dataHoraBR(pg.pagto_data) || new Date().toISOString()]
      );
      relatorio.pagamentosCriados++;
    }

    if (k % 500 === 0) { await flush('cobrancas/pagamentos'); console.log(`  ... cobrancas: ${k}/${contasReceber.length}`); }
  }
  await flush('cobrancas/pagamentos');
  console.log(`[6/7] cobrancas: OK (novas: ${relatorio.cobrancasCriadas}, já existiam: ${relatorio.cobrancasReaproveitadas}), pagamentos: OK (${relatorio.pagamentosCriados})`);

  // --- 6b. ADOÇÃO: liga a cobrança 'legado' mais recente de cada pessoa+serviço
  // à matrícula correspondente via matricula_id — NENHUMA cobrança nova é
  // criada aqui, só um UPDATE de vínculo. É isso que faz
  // gerarCobrancasRecorrentes (no boot do servidor) calcular o próximo
  // vencimento a partir do histórico real, em vez de inventar uma "primeira
  // cobrança" fantasma na data_inicio da matrícula. ---
  for (const m of matriculasParaAdotar) {
    const chavePS = `${m.pessoaId}:${m.servicoId}`;
    const maisRecente = cobrancaMaisRecentePorPessoaServico[chavePS];
    if (!maisRecente) {
      relatorio.matriculasSemCobrancaLegadoParaAdotar.push({ alunoId: m.alunoId, servicoId: m.servicoId });
      continue;
    }
    const cobrancaId = cobrancaIdPorConta[maisRecente.contaId];
    if (!cobrancaId) continue;
    enfileirar(
      `UPDATE cobrancas SET matricula_id = ? WHERE id = ? AND matricula_id IS NULL`,
      [m.matriculaId, cobrancaId]
    );
    relatorio.matriculasAdotaramCobrancaLegado++;
  }
  await flush('adoção de cobrança legado');
  console.log(`[6b/7] adoção: ${relatorio.matriculasAdotaramCobrancaLegado} matrícula(s) ligada(s) à cobrança legado mais recente (nenhuma cobrança nova criada)`);
  if (relatorio.matriculasSemCobrancaLegadoParaAdotar.length) {
    console.log(`  AVISO: ${relatorio.matriculasSemCobrancaLegadoParaAdotar.length} matrícula(s) sem nenhuma cobrança legado prévia pra adotar (aluno novo, sem histórico de cobrança nesse serviço) — quando a recorrência rodar, essas VÃO gerar uma primeira cobrança (comportamento correto pra matrícula genuinamente nova).`);
  }

  // --- 7. Anamnese: sessao + respostas + avaliacao fisica (sem mudanças de fundo) ---
  const anamneseSessoes = lerCSV('anamnese');
  const alternativas = lerCSV('anamnese_alternativas');
  const altPorId = {};
  alternativas.forEach((a) => { altPorId[a.id] = a; });
  const respostas = lerCSV('anamnese_respostas');
  const respostasPorAnamnese = {};
  for (const r of respostas) { (respostasPorAnamnese[r.anamnese_id] ||= []).push(r); }

  let m = 0;
  for (const sessao of anamneseSessoes) {
    m++;
    const alunoId = alunoIdPorPessoa[sessao.pessoa_id];
    if (!alunoId) continue;

    const dataSessao = dataHoraBR(sessao.data);
    const respostasSessao = respostasPorAnamnese[sessao.id] || [];
    const respostasAnamnese = [];
    const avaliacao = { extras: {} };

    for (const r of respostasSessao) {
      const altId = r.alternativa_id;
      const mapaPergunta = ALT_PARA_PERGUNTA[altId];
      const mapaAvaliacao = ALT_PARA_AVALIACAO[altId];
      if (mapaPergunta) {
        respostasAnamnese.push({ pergunta: mapaPergunta.pergunta, valor: mapaPergunta.valor, resposta: r.resposta });
      } else if (mapaAvaliacao) {
        switch (mapaAvaliacao.tipo) {
          case 'num': avaliacao[mapaAvaliacao.campo] = numeroFlexivel(r.resposta); break;
          case 'altura': avaliacao[mapaAvaliacao.campo] = alturaParaCm(r.resposta); break;
          case 'texto': avaliacao[mapaAvaliacao.campo] = txt(r.resposta); break;
          case 'texto_append': avaliacao[mapaAvaliacao.campo] = [avaliacao[mapaAvaliacao.campo], txt(r.resposta)].filter(Boolean).join(' | '); break;
          case 'escolha': avaliacao[mapaAvaliacao.campo] = mapaAvaliacao.valor; break;
          case 'extra': avaliacao.extras[mapaAvaliacao.chave] = mapaAvaliacao.valor !== undefined ? mapaAvaliacao.valor : txt(r.resposta); break;
        }
      }
    }

    const anamneseId = uuid();
    enfileirar(`INSERT OR IGNORE INTO anamneses (id, aluno_id, criado_em) VALUES (?, ?, ?)`, [anamneseId, alunoId, dataSessao || new Date().toISOString()]);
    relatorio.anamnesesCriadas++;

    for (const ra of respostasAnamnese) {
      const perguntaId = perguntaIdPorKey[ra.pergunta];
      if (!perguntaId) continue;
      const isTexto = ra.valor === 'texto';
      enfileirar(
        `INSERT OR IGNORE INTO anamnese_respostas (id, anamnese_id, pergunta_id, resposta_sim_nao, resposta_texto) VALUES (?, ?, ?, ?, ?)`,
        [uuid(), anamneseId, perguntaId, isTexto ? null : (ra.valor === 'sim' ? 1 : 0), isTexto ? txt(ra.resposta) : null]
      );
      relatorio.respostasAnamneseCriadas++;
    }

    const temMedida = Object.keys(avaliacao).some((k2) => k2 !== 'extras' && avaliacao[k2] !== null && avaliacao[k2] !== undefined);
    if (temMedida) {
      enfileirar(
        `INSERT OR IGNORE INTO avaliacoes_fisicas
           (id, aluno_id, data_avaliacao, peso_kg, altura_cm, percentual_gordura, medida_cintura_cm, medida_quadril_cm,
            medida_peito_cm, medida_braco_cm, medida_coxa_cm, medida_panturrilha_cm, imc_atual, imc_ideal, iac,
            massa_magra_kg, perfil_morfologico, dados_extras, objetivo, observacoes, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(), alunoId, dataBR(sessao.data) || new Date().toISOString().slice(0, 10),
          avaliacao.peso_kg ?? null, avaliacao.altura_cm ?? null,
          avaliacao.extras.porcentagem_gordura_lean ? numeroFlexivel(avaliacao.extras.porcentagem_gordura_lean) : null,
          avaliacao.medida_cintura_cm ?? null, avaliacao.medida_quadril_cm ?? null, avaliacao.medida_peito_cm ?? null,
          avaliacao.medida_braco_cm ?? null, avaliacao.medida_coxa_cm ?? null, avaliacao.medida_panturrilha_cm ?? null,
          avaliacao.imc_atual ?? null, avaliacao.imc_ideal ?? null, avaliacao.iac ?? null, avaliacao.massa_magra_kg ?? null,
          avaliacao.perfil_morfologico ?? null, JSON.stringify(avaliacao.extras), avaliacao.objetivo ?? null,
          avaliacao.observacoes ?? null, dataSessao || new Date().toISOString(),
        ]
      );
      relatorio.avaliacoesFisicasCriadas++;
    }

    if (m % 500 === 0) await flush('anamneses');
  }
  await flush('anamneses');
  console.log(`[7/7] anamneses: OK (${relatorio.anamnesesCriadas}), respostas: OK (${relatorio.respostasAnamneseCriadas}), avaliacoes: OK (${relatorio.avaliacoesFisicasCriadas})`);

  console.log('\n=== RELATORIO DE MIGRACAO V2 ===');
  console.log(JSON.stringify(relatorio, null, 2));

  fs.writeFileSync(path.join(EXPORT_DIR, 'relatorio-migracao-v2.json'), JSON.stringify(relatorio, null, 2), 'utf8');
  console.log(`\nRelatorio completo salvo em: ${path.join(EXPORT_DIR, 'relatorio-migracao-v2.json')}`);
  console.log('\nIMPORTANTE: NÃO suba o servidor (npm start / npm run dev) antes de revisar este relatório.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro na migracao:', err);
    console.error('Rode de novo: como agora é idempotente, retomar após uma falha não duplica nada já gravado.');
    process.exit(1);
  });
