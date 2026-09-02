/**
 * Conquistas/gamificação do aluno (2026-09-02, port do TreinoPro —
 * `D:\Meus documentos\Downloads\treinopro\server.js`, BADGE_CATALOG/
 * checkAchievements/getGamificationSummary). Streak (semanas seguidas
 * treinando) e total de treinos são calculados em tempo real a partir de
 * treino_execucoes — nunca gravados aqui; a tabela aluno_conquistas (ver
 * schema.sql) só guarda QUAL badge já foi desbloqueada e QUANDO.
 */
const { v4: uuid } = require('uuid');
const db = require('../db/client');

const BADGE_CATALOG = [
  { key: 'primeiro_treino', icon: '🎯', nome: 'Primeiro treino', descricao: 'Registrou o primeiro treino.', teste: (m) => m.totalTreinos >= 1 },
  { key: 'primeira_semana', icon: '✅', nome: 'Primeira semana', descricao: 'Completou uma semana planejada.', teste: (m) => m.streakSemanas >= 1 },
  { key: 'streak_4_semanas', icon: '🔥', nome: '4 semanas seguidas', descricao: '4 semanas cumprindo o plano.', teste: (m) => m.streakSemanas >= 4 },
  { key: 'streak_12_semanas', icon: '🏆', nome: '12 semanas seguidas', descricao: 'Um trimestre de constância.', teste: (m) => m.streakSemanas >= 12 },
  { key: 'treinos_10', icon: '💪', nome: '10 treinos', descricao: 'Chegou a 10 treinos registrados.', teste: (m) => m.totalTreinos >= 10 },
  { key: 'treinos_50', icon: '⚡', nome: '50 treinos', descricao: 'Chegou a 50 treinos registrados.', teste: (m) => m.totalTreinos >= 50 },
  { key: 'treinos_100', icon: '🌟', nome: '100 treinos', descricao: 'Cem treinos — nível veterano.', teste: (m) => m.totalTreinos >= 100 },
  { key: 'primeira_avaliacao', icon: '📏', nome: 'Primeira avaliação', descricao: 'Fez a primeira avaliação física.', teste: (m) => m.totalAvaliacoes >= 1 },
];

// Chave "AAAA-Www" (segunda como início da semana ISO) a partir de 'YYYY-MM-DD'.
function chaveSemanaIso(dataStr) {
  const d = new Date(`${dataStr}T00:00:00Z`);
  const dia = (d.getUTCDay() + 6) % 7; // 0 = segunda
  d.setUTCDate(d.getUTCDate() - dia + 3); // quinta da mesma semana ISO
  const primeiraQuinta = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const semana = 1 + Math.round(((d - primeiraQuinta) / 86400000 - 3 + ((primeiraQuinta.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}
function semanaIsoAnterior(chave) {
  const [ano, semana] = chave.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(ano, 0, 4));
  const base = new Date(jan4);
  base.setUTCDate(jan4.getUTCDate() + (semana - 1) * 7 - 7);
  return chaveSemanaIso(base.toISOString().slice(0, 10));
}

// datasTreino: array de 'YYYY-MM-DD' (dias com pelo menos 1 execução).
// diasPlanejadosPorSemana: quantos dias/semana o aluno tem treino
// cadastrado (união dos dias_semana de todos os treinos ativos dele).
function calcularMetricasStreak(datasTreino, diasPlanejadosPorSemana, hojeStr) {
  const porSemana = {};
  const diasDistintos = new Set();
  for (const d of datasTreino) {
    if (!d) continue;
    diasDistintos.add(d);
    const chave = chaveSemanaIso(d);
    porSemana[chave] = porSemana[chave] || new Set();
    porSemana[chave].add(d);
  }
  const necessario = Math.max(1, diasPlanejadosPorSemana || 1);
  const totalTreinos = diasDistintos.size;
  const semanaAtual = chaveSemanaIso(hojeStr);
  let cursor = semanaAtual;
  let streak = 0;
  let primeira = true;
  // Semana atual e anteriores, em ordem decrescente; conta consecutivas que
  // bateram a meta. Tolera a semana atual ainda incompleta (não zera o
  // streak se ela ainda não bateu a meta — só encerra a partir da primeira
  // semana ANTERIOR que falhou).
  for (let i = 0; i < 260; i += 1) { // limite de segurança: 5 anos
    const bateu = (porSemana[cursor]?.size || 0) >= necessario;
    if (bateu) streak += 1;
    else if (!primeira) break;
    primeira = false;
    cursor = semanaIsoAnterior(cursor);
  }
  return { totalTreinos, streakSemanas: streak };
}

async function metricasDoAluno(alunoId) {
  const [logs, treinosRow, avaliacoesRow, hojeRow] = await Promise.all([
    db.execute({ sql: `SELECT DISTINCT date(criado_em) AS data FROM treino_execucoes WHERE aluno_id = ?`, args: [alunoId] }),
    db.execute({ sql: `SELECT dias_semana FROM treinos WHERE aluno_id = ? AND ativo = 1`, args: [alunoId] }),
    db.execute({ sql: `SELECT COUNT(*) AS n FROM avaliacoes_fisicas WHERE aluno_id = ?`, args: [alunoId] }),
    db.execute({ sql: `SELECT date('now') AS hoje`, args: [] }),
  ]);

  // Dias/semana planejados: união dos dias_semana de todos os treinos ativos
  // do aluno (ex.: Treino A na seg/qua/sex + Treino B na ter = 4 dias).
  // Nenhum treino com dias definidos (todos "Sem dias definidos") cai no
  // mesmo fallback do TreinoPro (3x/semana), já que nesse caso não dá pra
  // saber a meta real do aluno.
  const diasUniao = new Set();
  for (const row of treinosRow.rows) {
    try {
      const dias = row.dias_semana ? JSON.parse(row.dias_semana) : [];
      dias.forEach((d) => diasUniao.add(d));
    } catch { /* dias_semana malformado — ignora esta linha, não quebra a conta */ }
  }
  const diasPlanejados = diasUniao.size || 3;

  const metricas = calcularMetricasStreak(logs.rows.map((r) => r.data), diasPlanejados, hojeRow.rows[0].hoje);
  metricas.totalAvaliacoes = Number(avaliacoesRow.rows[0]?.n || 0);
  return metricas;
}

// Verifica e persiste badges recém-desbloqueadas. Chamado no momento em que
// o aluno registra um treino (marcar exercício ou "Concluir treino") — sem
// cron. Devolve só as badges NOVAS desta chamada, pra tela comemorar.
async function verificarConquistas(alunoId) {
  try {
    const metricas = await metricasDoAluno(alunoId);
    const jaTem = new Set(
      (await db.execute({ sql: `SELECT badge_key FROM aluno_conquistas WHERE aluno_id = ?`, args: [alunoId] })).rows.map((r) => r.badge_key),
    );
    const novas = [];
    for (const badge of BADGE_CATALOG) {
      if (jaTem.has(badge.key)) continue;
      if (!badge.teste(metricas)) continue;
      await db.execute({
        sql: `INSERT INTO aluno_conquistas (id, aluno_id, badge_key) VALUES (?, ?, ?) ON CONFLICT(aluno_id, badge_key) DO NOTHING`,
        args: [uuid(), alunoId, badge.key],
      });
      novas.push({ chave: badge.key, icone: badge.icon, nome: badge.nome, descricao: badge.descricao });
    }
    return novas;
  } catch {
    // Gamificação nunca pode derrubar o fluxo real de concluir um exercício
    // — se der erro aqui (ex.: aluno_conquistas ainda não migrada em algum
    // ambiente), o aluno continua marcando o treino normalmente.
    return [];
  }
}

// Resumo pra tela do aluno (streak, total de treinos, badges com estado
// desbloqueada/bloqueada).
async function obterResumoGamificacao(alunoId) {
  const metricas = await metricasDoAluno(alunoId);
  const desbloqueadas = await db.execute({ sql: `SELECT badge_key, desbloqueada_em FROM aluno_conquistas WHERE aluno_id = ? ORDER BY desbloqueada_em`, args: [alunoId] });
  const mapaDesbloqueadas = {};
  desbloqueadas.rows.forEach((r) => { mapaDesbloqueadas[r.badge_key] = r.desbloqueada_em; });
  const badges = BADGE_CATALOG.map((b) => ({
    chave: b.key, icone: b.icon, nome: b.nome, descricao: b.descricao,
    desbloqueada: b.key in mapaDesbloqueadas, desbloqueadaEm: mapaDesbloqueadas[b.key] || null,
  }));
  return {
    streakSemanas: metricas.streakSemanas,
    totalTreinos: metricas.totalTreinos,
    totalDesbloqueadas: desbloqueadas.rows.length,
    totalBadges: BADGE_CATALOG.length,
    badges,
  };
}

module.exports = { verificarConquistas, obterResumoGamificacao };
