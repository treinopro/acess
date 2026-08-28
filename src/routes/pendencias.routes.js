/**
 * Pendências (2026-08-14) — um só lugar pro professor ver tudo que precisa
 * de atenção: serviços vencidos (ver produtosServicos.routes.js), avaliações
 * físicas (renovação vencida, ou etapa do passo a passo ainda não
 * concluída), e ajuste de carga (2026-08-27 — ver treino_exercicios.
 * precisa_ajuste_carga em schema.sql). Nunca bloqueia acesso do aluno — é só
 * uma lista de lembretes internos pro staff.
 */
const express = require('express');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar } = require('../middleware/auth');
const { listarPendenciasServicosVencidos } = require('./produtosServicos.routes');

const router = express.Router();
router.use(autenticar);

// Mesma cadência usada no portal (public/portal.js, CADENCIA_AVALIACAO_DIAS)
// — mantida em sincronia manualmente de propósito (são só duas ocorrências,
// não vale a complexidade de expor isso como configuração ainda).
const CADENCIA_AVALIACAO_DIAS = 90;

// Teste de força (2026-08-19): só vira pendência a partir de N dias depois
// de "prescrever treino" — antes disso o pipeline fica esperando, sem
// aparecer pro professor (mesmo espírito do lembrete de aniversariante: só
// aparece quando chega a hora).
const TESTE_FORCA_DIAS_ESPERA = 20;

const ETAPAS_AVALIACAO = ['realizada', 'prescrever_treino', 'teste_forca', 'treino_ok'];
const PROXIMA_ETAPA_LABEL = {
  realizada: 'Confirmar que a avaliação foi realizada',
  prescrever_treino: 'Prescrever treino',
  teste_forca: 'Fazer o teste de força e marcar concluído',
  treino_ok: 'Confirmar treino aplicado',
};

function diasDesde(dataHoraSql) {
  // Colunas etapa_*_em são gravadas com datetime('now') (SQLite, UTC, sem
  // timezone no texto) — new Date() do Node interpreta "YYYY-MM-DD HH:MM:SS"
  // como horário local, então normaliza pra formato ISO com "Z" antes de
  // parsear, senão o cálculo de dias fica errado dependendo do TZ do processo.
  const iso = dataHoraSql.includes('T') ? dataHoraSql : `${dataHoraSql.replace(' ', 'T')}Z`;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

/** A avaliação MAIS RECENTE de cada aluno (por data_avaliacao) — só essa entra em qualquer pendência. */
async function listarPipelinesMaisRecentes() {
  const result = await db.execute(`
    WITH ranked AS (
      SELECT ap.*, a.nome as aluno_nome,
        ROW_NUMBER() OVER (PARTITION BY ap.aluno_id ORDER BY ap.data_avaliacao DESC, ap.criado_em DESC) as rn
      FROM avaliacao_pipeline ap
      JOIN alunos a ON a.id = ap.aluno_id
    )
    SELECT * FROM ranked WHERE rn = 1
  `);
  return result.rows;
}

function proximaEtapaPendente(pipeline) {
  if (!pipeline.etapa_realizada_em) return 'realizada';
  if (!pipeline.etapa_prescrever_treino_em) return 'prescrever_treino';
  if (!pipeline.etapa_teste_forca_em) return 'teste_forca';
  if (!pipeline.etapa_treino_ok_em) return 'treino_ok';
  return null; // pipeline completo
}

// Exercícios que o aluno reportou mais de 13 repetições no portal (ver
// LIMITE_REPETICOES_SEM_AJUSTE em portal.routes.js) — sinal de que a carga
// prescrita ficou fácil demais. Some sozinho da lista quando o professor
// atualiza o campo "carga" desse exercício (ver PUT /exercicios/:id em
// treinos.routes.js, que zera precisa_ajuste_carga nesse momento).
async function listarPendenciasAjusteCarga() {
  const result = await db.execute(`
    SELECT te.id, te.exercicio, te.ultimo_peso_usado, te.ultimo_repeticoes_max, te.concluido_em,
           t.aluno_id, a.nome as aluno_nome
    FROM treino_exercicios te
    JOIN treinos t ON t.id = te.treino_id
    JOIN alunos a ON a.id = t.aluno_id
    WHERE te.precisa_ajuste_carga = 1
  `);
  return result.rows;
}

// GET /api/pendencias — junta serviços vencidos + avaliações (renovação
// vencida OU etapa do passo a passo pendente) + ajuste de carga, mais
// recentes primeiro.
router.get('/', async (req, res, next) => {
  try {
    const [servicos, pipelinesRecentes, ajustesCarga] = await Promise.all([
      listarPendenciasServicosVencidos(),
      listarPipelinesMaisRecentes(),
      listarPendenciasAjusteCarga(),
    ]);

    const pendenciasAjusteCarga = ajustesCarga.map((e) => ({
      tipo: 'ajuste_carga',
      id: e.id,
      aluno_id: e.aluno_id,
      aluno_nome: e.aluno_nome,
      detalhe: `${e.exercicio}: aluno fez ${e.ultimo_repeticoes_max} repetições${e.ultimo_peso_usado ? ` com ${e.ultimo_peso_usado}` : ''} — considere aumentar a carga.`,
      data_referencia: (e.concluido_em || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    }));

    const pendenciasServicos = servicos.map((s) => ({
      tipo: 'servico_vencido',
      id: s.id,
      aluno_id: s.aluno_id,
      aluno_nome: s.aluno_nome,
      detalhe: `${s.nome_produto_servico} venceu em ${s.data_vencimento}`,
      data_referencia: s.data_vencimento,
    }));

    const pendenciasAvaliacao = [];
    for (const p of pipelinesRecentes) {
      const diasDesdeAvaliacao = Math.floor((Date.now() - new Date(`${p.data_avaliacao}T12:00:00Z`).getTime()) / 86400000);
      if (diasDesdeAvaliacao > CADENCIA_AVALIACAO_DIAS) {
        pendenciasAvaliacao.push({
          tipo: 'renovacao_avaliacao',
          id: p.id,
          aluno_id: p.aluno_id,
          aluno_nome: p.aluno_nome,
          detalhe: `Avaliação de ${p.data_avaliacao} venceu há ${diasDesdeAvaliacao - CADENCIA_AVALIACAO_DIAS} dia(s) — hora de renovar.`,
          data_referencia: p.data_avaliacao,
        });
        continue; // renovação vencida já cobre o caso — não empilha "etapa pendente" da mesma avaliação velha
      }
      const proxima = proximaEtapaPendente(p);
      // Teste de força só incomoda o professor a partir de
      // TESTE_FORCA_DIAS_ESPERA dias depois de prescrever o treino — antes
      // disso o pipeline fica "esperando" sem gerar pendência nenhuma.
      if (proxima === 'teste_forca' && diasDesde(p.etapa_prescrever_treino_em) < TESTE_FORCA_DIAS_ESPERA) continue;
      if (proxima) {
        pendenciasAvaliacao.push({
          tipo: 'etapa_avaliacao',
          id: p.id,
          aluno_id: p.aluno_id,
          aluno_nome: p.aluno_nome,
          etapa: proxima,
          detalhe: `Avaliação de ${p.data_avaliacao} — próxima etapa: ${PROXIMA_ETAPA_LABEL[proxima]}.`,
          data_referencia: p.data_avaliacao,
        });
      }
    }

    const pendencias = [...pendenciasServicos, ...pendenciasAvaliacao, ...pendenciasAjusteCarga]
      .sort((a, b) => (a.data_referencia < b.data_referencia ? -1 : 1));

    res.json({ pendencias });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/pendencias/avaliacao/:pipelineId/etapa { etapa: 'realizada'|'prescrever_treino'|'teste_forca'|'treino_ok' }
router.patch('/avaliacao/:pipelineId/etapa', async (req, res, next) => {
  try {
    const { etapa } = z.object({ etapa: z.enum(ETAPAS_AVALIACAO) }).parse(req.body);
    const coluna = `etapa_${etapa}_em`;
    const result = await db.execute({
      sql: `UPDATE avaliacao_pipeline SET ${coluna} = datetime('now') WHERE id = ?`,
      args: [req.params.pipelineId],
    });
    if (result.rowsAffected === 0) return res.status(404).json({ erro: 'Avaliação não encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
