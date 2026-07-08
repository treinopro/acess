// Reconciliação do incidente de duplicação pós-migração v2 em produção
// (08/07/2026): a migração v2 rodou contra produção sem saber que já
// existia lá um lote de ~1381 alunos (e matrículas/cobranças/anamneses
// relacionadas) de uma tentativa de migração ANTERIOR (v1, semanas atrás),
// nunca limpo - esse lote não tinha secullum_id (a coluna só foi criada
// nesta sessão), então a checagem de idempotência da v2 não o reconheceu e
// inseriu um segundo conjunto completo por cima, duplicando quase tudo.
//
// Confirmado com o usuário: o site publicado não teve uso operacional real
// (recepção/alunos) antes de hoje - só testes pontuais dele mesmo. Por isso
// o lote ANTIGO (sem secullum_id) pode ser tratado como puro artefato de
// migração duplicada... EXCETO por um punhado de registros com atividade
// real (pagamento pelo totem, checkin, acesso de catraca) encontrados nesse
// diagnóstico - ver scripts/diagnosticar-duplicacao-pos-v2.js. Esses são
// preservados (reatribuídos ao aluno correto, novo) em vez de apagados.
//
// O QUE ESTE SCRIPT FAZ, por par (aluno antigo -> aluno novo/correto):
//   1. Identifica o par: por CPF normalizado (só dígitos) quando ambos têm
//      CPF e há exatamente 1 candidato; senão por nome normalizado, só se
//      exatamente 1 candidato em cada lado (ambíguo = NÃO mexe, fica pra
//      revisão manual, nunca adivinha).
//   2. REATRIBUI (nunca apaga) pro aluno novo: checkins, acessos_catraca,
//      pagamentos_totem, agendamentos, e cobranças que NÃO são 'legado'
//      (ou seja, recorrencia/manual/mercadopago - atividade real do app,
//      não vinda do CSV do Secullum). Nessas cobranças reatribuídas,
//      matricula_id é zerado (a matrícula antiga será apagada; a matrícula
//      correta já existe do lado novo, criada pela migração v2).
//   3. APAGA o aluno antigo - o ON DELETE CASCADE do schema cuida sozinho
//      de apagar as matrículas antigas, as cobranças 'legado' antigas
//      (puro duplicado do que a v2 já trouxe certo), anamneses,
//      avaliações físicas e respostas de anamnese ligadas a ele.
//   4. Alunos antigos SEM match confiável: NÃO são tocados, aparecem na
//      lista "sem correspondência" pra decisão manual depois.
//
// NÃO mexe em planos duplicados (fora de escopo deste script - ver aviso no
// relatório final; matrículas órfãs de plano antigo somem junto com o
// aluno antigo no passo 3, mas o plano em si pode continuar existindo como
// linha duplicada não usada, avaliar separadamente).
//
// Como rodar contra o local.db (não deveria ter nada pra reconciliar lá):
//   node scripts/reconciliar-migracao-v1-v2-producao.js --dry-run
//
// Como rodar contra PRODUCAO:
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/reconciliar-migracao-v1-v2-producao.js --dry-run --confirmar-producao"
//   (revisar o relatório com calma, sobretudo a seção de atividade real
//   preservada e a lista de "sem correspondência", só então rodar de novo
//   sem --dry-run)

const { createClient } = require('@libsql/client');
require('dotenv').config();

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

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Fila de UPDATEs/DELETEs + envio em lotes (db.batch), com retry por lote —
// mesmo padrão usado em migrar-secullum-v2.js, pra não travar contra a rede
// (Turso remoto) fazendo uma query por vez.
// ---------------------------------------------------------------------------
const ERROS_TRANSITORIOS = /ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|fetch failed|EAI_AGAIN|socket hang up/i;
const MAX_TENTATIVAS = 6;
const TAMANHO_LOTE = 200;

let fila = [];
function enfileirar(sql, args) { fila.push({ sql, args: args || [] }); }

async function despejarLote(lote, contexto) {
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
  while (fila.length) {
    const lote = fila.splice(0, TAMANHO_LOTE);
    await despejarLote(lote, contexto);
  }
}

function normalizarCpf(cpf) {
  if (!cpf) return '';
  return String(cpf).replace(/\D/g, '');
}

function normalizarNome(nome) {
  if (!nome) return '';
  return String(nome)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

async function main() {
  console.log(DRY_RUN ? '=== MODO DRY-RUN (nada sera gravado) ===\n' : '=== RECONCILIACAO REAL ===\n');

  const novos = (await db.execute(`SELECT id, nome, cpf FROM alunos WHERE secullum_id IS NOT NULL`)).rows;
  const antigos = (await db.execute(`SELECT id, nome, cpf, status, criado_em FROM alunos WHERE secullum_id IS NULL`)).rows;

  console.log(`Alunos novos (migração v2, corretos): ${novos.length}`);
  console.log(`Alunos antigos (candidatos a duplicata): ${antigos.length}\n`);

  // Mapas de lookup entre os "novos" - só usa quando o mapa aponta pra
  // exatamente 1 candidato (ambiguidade = não usa esse critério).
  const porCpf = new Map();
  const porNome = new Map();
  for (const n of novos) {
    const cpfN = normalizarCpf(n.cpf);
    if (cpfN) {
      if (!porCpf.has(cpfN)) porCpf.set(cpfN, []);
      porCpf.get(cpfN).push(n);
    }
    const nomeN = normalizarNome(n.nome);
    if (!porNome.has(nomeN)) porNome.set(nomeN, []);
    porNome.get(nomeN).push(n);
  }

  const pares = []; // { antigo, novo, criterio }
  const semCorrespondencia = [];

  for (const a of antigos) {
    const cpfA = normalizarCpf(a.cpf);
    let candidato = null;
    let criterio = null;

    if (cpfA && porCpf.get(cpfA)?.length === 1) {
      candidato = porCpf.get(cpfA)[0];
      criterio = 'cpf';
    } else {
      const nomeA = normalizarNome(a.nome);
      if (porNome.get(nomeA)?.length === 1) {
        candidato = porNome.get(nomeA)[0];
        criterio = 'nome';
      }
    }

    if (candidato) {
      pares.push({ antigo: a, novo: candidato, criterio });
    } else {
      semCorrespondencia.push(a);
    }
  }

  console.log(`Pares encontrados: ${pares.length} (${pares.filter((p) => p.criterio === 'cpf').length} por CPF, ${pares.filter((p) => p.criterio === 'nome').length} por nome)`);
  console.log(`Sem correspondência confiável (NÃO tocados): ${semCorrespondencia.length}\n`);

  // --- Atividade real ligada aos antigos que serão apagados ---
  // Em vez de 1 consulta por par (lento contra o Turso pela rede - milhares
  // de idas-e-voltas), faz 1 consulta agregada por tabela (GROUP BY
  // aluno_id) e cruza com os pares em memória.
  const TABELAS_REATRIBUIR = ['checkins', 'acessos_catraca', 'pagamentos_totem', 'agendamentos'];
  const tabelasExistentes = {};
  for (const t of [...TABELAS_REATRIBUIR, 'cobrancas']) {
    const r = await db.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, args: [t] });
    tabelasExistentes[t] = r.rows.length > 0;
  }

  const contagemPorTabela = {}; // tabela -> Map(aluno_id -> n)
  for (const t of TABELAS_REATRIBUIR) {
    contagemPorTabela[t] = new Map();
    if (!tabelasExistentes[t]) continue;
    const r = await db.execute(`
      SELECT aluno_id, COUNT(*) AS n FROM ${t}
      WHERE aluno_id IN (SELECT id FROM alunos WHERE secullum_id IS NULL)
      GROUP BY aluno_id
    `);
    r.rows.forEach((row) => contagemPorTabela[t].set(row.aluno_id, Number(row.n)));
  }
  const cobrancasOrganicasPorAluno = new Map();
  if (tabelasExistentes.cobrancas) {
    const r = await db.execute(`
      SELECT aluno_id, COUNT(*) AS n FROM cobrancas
      WHERE provedor != 'legado' AND aluno_id IN (SELECT id FROM alunos WHERE secullum_id IS NULL)
      GROUP BY aluno_id
    `);
    r.rows.forEach((row) => cobrancasOrganicasPorAluno.set(row.aluno_id, Number(row.n)));
  }

  let totalReatribuidos = { checkins: 0, acessos_catraca: 0, pagamentos_totem: 0, agendamentos: 0, cobrancas_organicas: 0 };
  const paresComAtividadeReal = [];

  for (const { antigo, novo } of pares) {
    let atividadeReal = 0;
    for (const t of TABELAS_REATRIBUIR) {
      const n = contagemPorTabela[t].get(antigo.id) || 0;
      if (n > 0) { totalReatribuidos[t] += n; atividadeReal += n; }
    }
    const nCob = cobrancasOrganicasPorAluno.get(antigo.id) || 0;
    if (nCob > 0) { totalReatribuidos.cobrancas_organicas += nCob; atividadeReal += nCob; }

    if (atividadeReal > 0) paresComAtividadeReal.push({ antigo, novo, atividadeReal });
  }

  console.log('=== Atividade real que será PRESERVADA (reatribuída ao aluno correto) ===');
  console.log(`  checkins: ${totalReatribuidos.checkins}`);
  console.log(`  acessos_catraca: ${totalReatribuidos.acessos_catraca}`);
  console.log(`  pagamentos_totem: ${totalReatribuidos.pagamentos_totem}`);
  console.log(`  agendamentos: ${totalReatribuidos.agendamentos}`);
  console.log(`  cobranças não-legado (recorrencia/manual/mercadopago): ${totalReatribuidos.cobrancas_organicas}`);
  if (paresComAtividadeReal.length > 0) {
    console.log(`\n  Alunos específicos com atividade real (${paresComAtividadeReal.length}):`);
    paresComAtividadeReal.forEach((p) => console.log(`    "${p.antigo.nome}" (antigo=${p.antigo.id} -> novo=${p.novo.id}): ${p.atividadeReal} registro(s)`));
  }

  if (semCorrespondencia.length > 0) {
    console.log(`\n=== SEM CORRESPONDÊNCIA (${semCorrespondencia.length}) - revisar manualmente, nada será feito com eles ===`);
    semCorrespondencia.slice(0, 30).forEach((a) => console.log(`  "${a.nome}" | cpf=${a.cpf || '(vazio)'} | status=${a.status} | id=${a.id}`));
    if (semCorrespondencia.length > 30) console.log(`  ... e mais ${semCorrespondencia.length - 30}`);
  }

  if (!DRY_RUN) {
    console.log('\n=== APLICANDO ===');

    // 1) Reatribui atividade real - só pros pares que TÊM alguma coisa pra
    //    preservar (poucos, ~dezenas), em vez de emitir 4-5 UPDATEs (a
    //    maioria sem efeito nenhum) pra cada um dos 1358 pares. Isso já
    //    corta a maior parte do volume de statements.
    for (const { antigo, novo } of paresComAtividadeReal) {
      for (const t of TABELAS_REATRIBUIR) {
        if (!tabelasExistentes[t]) continue;
        enfileirar(`UPDATE ${t} SET aluno_id = ? WHERE aluno_id = ?`, [novo.id, antigo.id]);
      }
      if (tabelasExistentes.cobrancas) {
        enfileirar(
          `UPDATE cobrancas SET aluno_id = ?, matricula_id = NULL WHERE aluno_id = ? AND provedor != 'legado'`,
          [novo.id, antigo.id],
        );
      }
    }
    await flush('reatribuição de atividade real');
    console.log(`  Atividade real reatribuída para ${paresComAtividadeReal.length} aluno(s) com histórico.`);

    // 2) Apaga os antigos duplicados em blocos (1 DELETE por bloco de até
    //    300 ids, via IN (...), em vez de 1 DELETE por aluno) - bem menos
    //    idas-e-voltas de rede, e o cascade do schema cuida de matrículas,
    //    cobranças legado, anamneses/respostas e avaliações de uma vez só
    //    por bloco. Com os índices que faltavam já criados
    //    (scripts/otimizar-indices-cascata.js), cada bloco deve ser rápido.
    const idsParaExcluir = pares.map((p) => p.antigo.id);
    const TAMANHO_BLOCO_DELETE = 300;
    for (let i = 0; i < idsParaExcluir.length; i += TAMANHO_BLOCO_DELETE) {
      const bloco = idsParaExcluir.slice(i, i + TAMANHO_BLOCO_DELETE);
      const placeholders = bloco.map(() => '?').join(',');
      enfileirar(`DELETE FROM alunos WHERE id IN (${placeholders})`, bloco);
    }
    await flush('exclusão em massa dos antigos duplicados');
    console.log(`\n=== FIM (${idsParaExcluir.length} alunos antigos reconciliados e removidos, em ${Math.ceil(idsParaExcluir.length / TAMANHO_BLOCO_DELETE)} bloco(s) de exclusão) ===`);
  } else {
    console.log('\n=== FIM (dry-run — nada foi alterado) ===');
    console.log('Se o plano acima fizer sentido, rode de novo sem --dry-run pra aplicar de verdade.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro na reconciliação:', err);
    process.exit(1);
  });
