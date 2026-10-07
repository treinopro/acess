const { v4: uuid } = require('uuid');
const db = require('../db/client');

// Galeria de rostos por aluno (2026-10-07, pedido do dono: o sistema ir
// "aprendendo" com os acessos faciais).
//
// Cada aluno tem o rosto do CADASTRO (alunos.face_descriptor — a âncora, nunca
// é trocada por aprendizado) e até MAX_AMOSTRAS_APRENDIDAS amostras extras
// aprendidas de reconhecimentos reais. O reconhecimento compara contra todas e
// usa a mais parecida de cada aluno — quem mudou barba/óculos/boné/luz deixa
// de falhar. Amostras ficam numa tabela à parte (face_amostras), não em
// colunas de `alunos`, porque o espelho offline do totem (syncOfflineCache.js)
// copia `alunos` coluna a coluna pro local.db: uma coluna nova só no Turso
// quebraria a sincronização.
//
// A galeria inteira fica em memória (recarregada a cada CACHE_TTL_MS ou quando
// algo muda aqui): antes cada tentativa de reconhecimento lia todos os rostos
// do banco (uma linha por aluno com rosto), e o histórico do projeto já tem
// uma cota do Turso estourada por leitura repetida (ver STATUS-PROJETO.md).

const MAX_AMOSTRAS_APRENDIDAS = Number(process.env.FACE_APRENDIZADO_MAX_AMOSTRAS || 4);
const SIM_MINIMA_APRENDER = Number(process.env.FACE_APRENDIZADO_SIM_MIN || 0.45); // acerto bem confiante (limiar de aceite é 0.363)
const SIM_MAXIMA_APRENDER = Number(process.env.FACE_APRENDIZADO_SIM_MAX || 0.85); // acima disso é quase igual ao que já tem: nada novo pra aprender
const INTERVALO_MINIMO_APRENDER_MS = Number(process.env.FACE_APRENDIZADO_INTERVALO_HORAS || 24) * 60 * 60 * 1000;
const CACHE_TTL_MS = 30 * 1000;

function aprendizadoAtivo() {
  return String(process.env.FACE_APRENDIZADO_ATIVO || 'true').toLowerCase() !== 'false';
}

// ---------------- Tabela (criada pelo servidor ao subir) ----------------
let tabelaOk = false;
let tabelaPromise = null;

function garantirTabela() {
  if (!tabelaPromise) {
    tabelaPromise = (async () => {
      try {
        await db.execute(`CREATE TABLE IF NOT EXISTS face_amostras (
          id TEXT PRIMARY KEY,
          aluno_id TEXT NOT NULL,
          descriptor TEXT NOT NULL,
          similaridade REAL,
          criado_em TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        await db.execute('CREATE INDEX IF NOT EXISTS idx_face_amostras_aluno ON face_amostras(aluno_id)');
        tabelaOk = true;
      } catch (err) {
        tabelaPromise = null; // tenta de novo na próxima chamada
        console.error('[faceGaleria] não foi possível garantir a tabela face_amostras — aprendizado desativado por enquanto:', err.message);
      }
    })();
  }
  return tabelaPromise;
}

// ---------------- Matemática ----------------
function similaridadeCosseno(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// ---------------- Cache da galeria ----------------
// porAluno: alunoId -> { ancora: number[], extras: [{ id, vetor, criadoEm }] }
let galeria = null;
let galeriaCarregadaEm = 0;
let carregando = null;

function invalidar() {
  galeriaCarregadaEm = 0;
}

function idadeDoCacheMs() {
  return galeria ? Date.now() - galeriaCarregadaEm : Infinity;
}

async function carregarGaleria() {
  if (galeria && Date.now() - galeriaCarregadaEm < CACHE_TTL_MS) return galeria;
  if (carregando) return carregando;
  carregando = (async () => {
    try {
      await garantirTabela();
      const alunos = await db.execute('SELECT id, face_descriptor FROM alunos WHERE face_descriptor IS NOT NULL');
      const porAluno = new Map();
      for (const linha of alunos.rows) {
        try {
          const vetor = JSON.parse(linha.face_descriptor);
          if (Array.isArray(vetor) && vetor.length) porAluno.set(linha.id, { ancora: vetor, extras: [] });
        } catch { /* descritor corrompido: ignora, como antes */ }
      }
      if (tabelaOk) {
        const extras = await db.execute('SELECT id, aluno_id, descriptor, criado_em FROM face_amostras ORDER BY criado_em');
        for (const e of extras.rows) {
          const entrada = porAluno.get(e.aluno_id);
          if (!entrada) continue; // aluno sem âncora (rosto removido): amostra órfã não vale
          try {
            const vetor = JSON.parse(e.descriptor);
            if (Array.isArray(vetor) && vetor.length === entrada.ancora.length) entrada.extras.push({ id: e.id, vetor, criadoEm: e.criado_em });
          } catch { /* ignora */ }
        }
      }
      galeria = porAluno;
      galeriaCarregadaEm = Date.now();
      return galeria;
    } finally {
      carregando = null;
    }
  })();
  return carregando;
}

/**
 * Melhor aluno para o descritor recebido: a similaridade de cada aluno é a MAIOR
 * entre o rosto do cadastro e as amostras aprendidas dele; o 2º colocado é o
 * melhor de OUTRO aluno (mesma regra de margem de antes).
 */
async function melhorMatch(descriptorRecebido) {
  const mapa = await carregarGaleria();
  let melhorId = null;
  let maior = -Infinity;
  let segunda = -Infinity;
  let candidatos = 0;

  for (const [alunoId, entrada] of mapa) {
    if (entrada.ancora.length !== descriptorRecebido.length) continue;
    candidatos += 1;
    let simAluno = similaridadeCosseno(descriptorRecebido, entrada.ancora);
    for (const extra of entrada.extras) {
      const s = similaridadeCosseno(descriptorRecebido, extra.vetor);
      if (s > simAluno) simAluno = s;
    }
    if (simAluno > maior) {
      segunda = maior;
      maior = simAluno;
      melhorId = alunoId;
    } else if (simAluno > segunda) {
      segunda = simAluno;
    }
  }
  return {
    alunoId: melhorId,
    similaridade: Number.isFinite(maior) ? maior : null,
    similaridadeSegundoMelhor: Number.isFinite(segunda) ? segunda : null,
    candidatosComparados: candidatos,
  };
}

// ---------------- Aprendizado ----------------
const aprendendoAgora = new Set();

/**
 * Chamada depois de um reconhecimento facial BEM-SUCEDIDO. Só guarda o rosto
 * como amostra nova quando é seguro: acerto bem confiante, ninguém mais
 * parecido, não é cópia do que já existe e não aprendeu nada desse aluno nas
 * últimas 24h. Nunca lança erro — aprender é um extra e não pode atrapalhar o
 * acesso.
 */
async function aprender({ alunoId, descriptor, similaridade, similaridadeSegundoMelhor, limiarAceite }) {
  if (!aprendizadoAtivo()) return { aprendeu: false, motivo: 'desativado' };
  if (aprendendoAgora.has(alunoId)) return { aprendeu: false, motivo: 'em_andamento' };
  aprendendoAgora.add(alunoId);
  try {
    await garantirTabela();
    if (!tabelaOk) return { aprendeu: false, motivo: 'sem_tabela' };
    if (!Array.isArray(descriptor) || descriptor.some((n) => !Number.isFinite(n))) return { aprendeu: false, motivo: 'descritor_invalido' };
    if (similaridade < SIM_MINIMA_APRENDER) return { aprendeu: false, motivo: 'confianca_baixa' };
    if (similaridade >= SIM_MAXIMA_APRENDER) return { aprendeu: false, motivo: 'ja_conhecido' };
    // Ninguém mais pode ter sequer chegado perto de ser aceito.
    if (similaridadeSegundoMelhor != null && similaridadeSegundoMelhor >= limiarAceite) return { aprendeu: false, motivo: 'concorrente_proximo' };

    const mapa = await carregarGaleria();
    const entrada = mapa.get(alunoId);
    if (!entrada || entrada.ancora.length !== descriptor.length) return { aprendeu: false, motivo: 'sem_ancora' };

    const maisRecente = entrada.extras.reduce((acc, e) => {
      const t = Date.parse(`${String(e.criadoEm).replace(' ', 'T')}Z`);
      return Number.isFinite(t) && t > acc ? t : acc;
    }, 0);
    if (maisRecente && Date.now() - maisRecente < INTERVALO_MINIMO_APRENDER_MS) return { aprendeu: false, motivo: 'intervalo_minimo' };

    const vetor = descriptor.map((n) => Number(n.toFixed(6)));
    const stmts = [];
    let removido = null;
    if (entrada.extras.length >= MAX_AMOSTRAS_APRENDIDAS) {
      // Cheio: troca a amostra mais parecida com a nova (a mais redundante); empate -> a mais antiga.
      removido = entrada.extras
        .map((e) => ({ e, s: similaridadeCosseno(vetor, e.vetor) }))
        .sort((x, y) => y.s - x.s)[0].e;
      stmts.push({ sql: 'DELETE FROM face_amostras WHERE id = ?', args: [removido.id] });
    }
    const id = uuid();
    stmts.push({
      sql: 'INSERT INTO face_amostras (id, aluno_id, descriptor, similaridade) VALUES (?, ?, ?, ?)',
      args: [id, alunoId, JSON.stringify(vetor), similaridade],
    });
    await db.batch(stmts, 'write');

    if (removido) entrada.extras = entrada.extras.filter((e) => e.id !== removido.id);
    entrada.extras.push({ id, vetor, criadoEm: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    return { aprendeu: true, motivo: 'ok', totalAmostras: entrada.extras.length };
  } catch (err) {
    console.error('[faceGaleria] falha ao aprender amostra (ignorada):', err.message);
    return { aprendeu: false, motivo: 'erro' };
  } finally {
    aprendendoAgora.delete(alunoId);
  }
}

// ---------------- Administração ----------------
/** Apaga as amostras aprendidas do aluno (novo cadastro de rosto, rosto removido, exclusão do aluno, ou botão do painel). */
async function limparAmostras(alunoId) {
  try {
    await garantirTabela();
    if (tabelaOk) await db.execute({ sql: 'DELETE FROM face_amostras WHERE aluno_id = ?', args: [alunoId] });
  } catch (err) {
    console.error('[faceGaleria] falha ao limpar amostras (ignorada):', err.message);
  } finally {
    invalidar();
  }
}

async function contarAmostras(alunoId) {
  await garantirTabela();
  if (!tabelaOk) return 0;
  const r = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM face_amostras WHERE aluno_id = ?', args: [alunoId] });
  return Number(r.rows[0].n) || 0;
}

module.exports = {
  garantirTabela,
  melhorMatch,
  aprender,
  limparAmostras,
  contarAmostras,
  invalidar,
  idadeDoCacheMs,
  aprendizadoAtivo,
  MAX_AMOSTRAS_APRENDIDAS,
};
