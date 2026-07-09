/**
 * Lógica compartilhada do totem/terminal de auto atendimento: identificação do
 * aluno (CPF, código/QR, reconhecimento facial, biometria da própria catraca),
 * checagem de status e acionamento da catraca Henry via catracaGateway.service
 * (que decide sozinho entre TCP direto e o agente local — ver esse arquivo).
 */

const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db/client');
const catracaGateway = require('./catracaGateway.service');
const agenteGateway = require('./agenteGateway.service');

const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.6);

function gerarCodigoAcesso() {
  // 24 caracteres em base hexadecimal — não sequencial, não adivinhável
  return crypto.randomBytes(12).toString('hex');
}

/** Garante que o aluno tenha um codigo_acesso; gera e salva se ainda não tiver. */
async function garantirCodigoAcesso(alunoId) {
  const result = await db.execute({ sql: 'SELECT codigo_acesso FROM alunos WHERE id = ?', args: [alunoId] });
  if (!result.rows[0]) throw Object.assign(new Error('Aluno não encontrado.'), { status: 404 });
  if (result.rows[0].codigo_acesso) return result.rows[0].codigo_acesso;

  const codigo = gerarCodigoAcesso();
  await db.execute({ sql: 'UPDATE alunos SET codigo_acesso = ? WHERE id = ?', args: [codigo, alunoId] });
  return codigo;
}

async function buscarAlunoPorCpf(cpf) {
  const result = await db.execute({ sql: 'SELECT * FROM alunos WHERE cpf = ?', args: [cpf] });
  return result.rows[0] || null;
}

async function buscarAlunoPorCodigoAcesso(codigo) {
  const result = await db.execute({ sql: 'SELECT * FROM alunos WHERE codigo_acesso = ?', args: [codigo] });
  return result.rows[0] || null;
}

async function buscarAlunoPorBiometriaId(biometriaId) {
  const result = await db.execute({ sql: 'SELECT * FROM alunos WHERE biometria_id = ?', args: [biometriaId] });
  return result.rows[0] || null;
}

function distanciaEuclidiana(a, b) {
  let soma = 0;
  for (let i = 0; i < a.length; i++) soma += (a[i] - b[i]) ** 2;
  return Math.sqrt(soma);
}

/**
 * Compara o descritor facial recebido do totem contra todos os alunos que já
 * têm face_descriptor cadastrado, e retorna o de menor distância dentro do
 * limiar aceito (ou null se ninguém bateu).
 */
async function encontrarMelhorMatchFacial(descriptorRecebido) {
  const result = await db.execute("SELECT * FROM alunos WHERE face_descriptor IS NOT NULL");
  let melhor = null;
  let menorDistancia = Infinity;
  let candidatosComparados = 0;

  for (const aluno of result.rows) {
    let descritorSalvo;
    try {
      descritorSalvo = JSON.parse(aluno.face_descriptor);
    } catch {
      continue;
    }
    if (!Array.isArray(descritorSalvo) || descritorSalvo.length !== descriptorRecebido.length) continue;

    candidatosComparados += 1;
    const distancia = distanciaEuclidiana(descriptorRecebido, descritorSalvo);
    if (distancia < menorDistancia) {
      menorDistancia = distancia;
      melhor = aluno;
    }
  }

  // Sempre devolve o melhor candidato e a distância, mesmo fora do limiar —
  // útil para diagnosticar/ajustar FACE_MATCH_THRESHOLD durante os testes.
  const dentroDoLimite = Boolean(melhor) && menorDistancia <= FACE_MATCH_THRESHOLD;
  return {
    aluno: melhor,
    distancia: Number.isFinite(menorDistancia) ? menorDistancia : null,
    dentroDoLimite,
    candidatosComparados,
    limite: FACE_MATCH_THRESHOLD,
  };
}

/** Salva/atualiza o descritor facial de um aluno (cadastro ou re-cadastro). */
async function salvarFaceDescriptor(alunoId, descriptor) {
  await db.execute({
    sql: 'UPDATE alunos SET face_descriptor = ? WHERE id = ?',
    args: [JSON.stringify(descriptor), alunoId],
  });
}

/** Verifica se o aluno tem ao menos uma matrícula com status 'ativa'. */
async function temMatriculaAtiva(alunoId) {
  const result = await db.execute({
    sql: `SELECT COUNT(*) as total FROM matriculas
          WHERE aluno_id = ? AND status = 'ativa' AND (data_fim IS NULL OR data_fim >= date('now'))`,
    args: [alunoId],
  });
  return Number(result.rows[0].total) > 0;
}

/**
 * Verifica se o aluno tem MENSALIDADE em aberto de verdade — ou seja, cobrança
 * vinculada a uma matrícula de plano (matricula_id preenchido), pendente e
 * vencida, ou já marcada como atrasada — independente do campo alunos.status
 * (que é só um rótulo manual e pode estar desatualizado).
 *
 * Só cobrança de mensalidade bloqueia o acesso. Uma conta avulsa (produto,
 * avaliação, taxa) criada manualmente sem vínculo de matrícula — mesmo vencida
 * — NÃO bloqueia: o aluno pode dever por um produto e continuar treinando.
 *
 * status = 'atrasado' sempre bloqueia, mesmo sem vencimento preenchido (o
 * campo é opcional). status = 'pendente' só bloqueia se o vencimento já
 * passou (uma cobrança pendente com vencimento futuro ainda não está em
 * atraso).
 */
async function possuiCobrancaEmAtraso(alunoId) {
  const result = await db.execute({
    sql: `SELECT COUNT(*) as total FROM cobrancas
          WHERE aluno_id = ? AND matricula_id IS NOT NULL AND (
            status = 'atrasado'
            OR (status = 'pendente' AND vencimento IS NOT NULL AND vencimento < date('now'))
          )`,
    args: [alunoId],
  });
  return Number(result.rows[0].total) > 0;
}

/**
 * Só a parte da decisão que NÃO depende de consulta ao banco (status do
 * cadastro). Extraída à parte pra ser reaproveitada tanto por
 * `verificarAutorizacaoAluno` (uma consulta por vez, no totem) quanto por
 * `listarAutorizacoesBiometricas` (todos de uma vez, sem N+1, pro cache do
 * agente da catraca) — assim as duas nunca correm o risco de divergir.
 * Retorna o motivo do bloqueio, ou `null` se o status por si só não bloqueia
 * (ainda falta checar cobrança em atraso nesse caso).
 */
function motivoBloqueioPorStatus(aluno) {
  if (!aluno) return 'Aluno não encontrado.';
  if (aluno.status === 'inadimplente') return 'Existem mensalidades em atraso.';
  if (aluno.status === 'trancado') return 'Cadastro trancado.';
  if (aluno.status === 'inativo') return 'Cadastro inativo.';
  if (aluno.status !== 'ativo') return `Status "${aluno.status}" não permite acesso.`;
  return null;
}

/**
 * Decide se o aluno pode entrar agora, com o motivo em caso negativo.
 * Regra: o que bloqueia de verdade é o status do cadastro e a existência de
 * cobrança em atraso — NÃO a falta de matrícula ativa. Um aluno sem nenhuma
 * matrícula (ex.: ainda não vendeu plano, ou plano expirou) mas sem nenhuma
 * conta em aberto continua liberado; só cancelar/trancar o cadastro ou ter
 * mensalidade vencida é que bloqueia.
 */
async function verificarAutorizacaoAluno(aluno) {
  const motivoStatus = motivoBloqueioPorStatus(aluno);
  if (motivoStatus) return { autorizado: false, motivo: motivoStatus };

  const emAtraso = await possuiCobrancaEmAtraso(aluno.id);
  if (emAtraso) return { autorizado: false, motivo: 'Existem mensalidades em atraso.' };

  return { autorizado: true, motivo: null };
}

/**
 * Autorização de TODOS os alunos com biometria vinculada, numa única passada
 * (duas queries no total — nunca N+1) — usado para alimentar o cache local
 * do agente da catraca (Fase 1 do modo offline/resiliente), permitindo que a
 * leitura de digital direto na catraca seja liberada sem round-trip de rede
 * a cada toque. Aplica exatamente a mesma regra de `verificarAutorizacaoAluno`,
 * só que em lote.
 */
async function listarAutorizacoesBiometricas() {
  const [resultAlunos, resultAtraso] = await Promise.all([
    db.execute("SELECT id, nome, status, biometria_id FROM alunos WHERE biometria_id IS NOT NULL AND biometria_id != ''"),
    db.execute(`SELECT DISTINCT aluno_id FROM cobrancas
                WHERE matricula_id IS NOT NULL AND (
                  status = 'atrasado'
                  OR (status = 'pendente' AND vencimento IS NOT NULL AND vencimento < date('now'))
                )`),
  ]);

  const idsEmAtraso = new Set(resultAtraso.rows.map((linha) => linha.aluno_id));

  return resultAlunos.rows.map((aluno) => {
    const motivoStatus = motivoBloqueioPorStatus(aluno);
    if (motivoStatus) {
      return { biometria_id: aluno.biometria_id, autorizado: false, aluno_nome: aluno.nome, motivo: motivoStatus };
    }
    if (idsEmAtraso.has(aluno.id)) {
      return { biometria_id: aluno.biometria_id, autorizado: false, aluno_nome: aluno.nome, motivo: 'Existem mensalidades em atraso.' };
    }
    return { biometria_id: aluno.biometria_id, autorizado: true, aluno_nome: aluno.nome, motivo: null };
  });
}

/**
 * Notifica o agente local (best-effort — nunca lança, nunca atrasa o
 * fluxo que chamou) que a autorização de UM aluno específico pode ter
 * mudado, pra atualizar o cache dele (Fase 1 do modo offline/resiliente)
 * sem esperar até 15 minutos do próximo pull periódico. Chamar nos pontos
 * onde status, biometria_id ou pagamento de mensalidade mudam (ver
 * alunos.routes.js, pagamentos.routes.js, terminal.routes.js).
 *
 * Não faz nada (silenciosamente) se o aluno não tiver biometria_id
 * vinculada, ou se não houver agente conectado agora — nesses casos o
 * próximo pull periódico do agente resolve de qualquer forma.
 */
async function notificarAgenteAtualizacaoAluno(alunoId) {
  try {
    const result = await db.execute({ sql: 'SELECT id, nome, status, biometria_id FROM alunos WHERE id = ?', args: [alunoId] });
    const aluno = result.rows[0];
    if (!aluno || !aluno.biometria_id) return;

    const motivoStatus = motivoBloqueioPorStatus(aluno);
    let item;
    if (motivoStatus) {
      item = { biometria_id: aluno.biometria_id, autorizado: false, aluno_nome: aluno.nome, motivo: motivoStatus };
    } else {
      const emAtraso = await possuiCobrancaEmAtraso(aluno.id);
      item = emAtraso
        ? { biometria_id: aluno.biometria_id, autorizado: false, aluno_nome: aluno.nome, motivo: 'Existem mensalidades em atraso.' }
        : { biometria_id: aluno.biometria_id, autorizado: true, aluno_nome: aluno.nome, motivo: null };
    }

    await agenteGateway.enviarComando('atualizar_cache', { itens: [item], substituir_tudo: false });
  } catch {
    // Best-effort de propósito: falha aqui (aluno sem biometria, agente
    // desconectado, timeout etc.) nunca deve derrubar quem chamou esta
    // função — o próximo pull periódico do agente cobre a atualização.
  }
}

async function registrarAcesso({ alunoId, metodo, resultado, mensagem }) {
  await db.execute({
    sql: 'INSERT INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem) VALUES (?, ?, ?, ?, ?)',
    args: [uuid(), alunoId || null, metodo, resultado, mensagem || null],
  });
}

/**
 * Variante de `registrarAcesso` usada pelo lote de reenvio da fila offline do
 * agente (Fase 2 do modo offline/resiliente — ver agente-local/filaAcessos.js
 * e a rota POST /api/terminal/acessos/lote). Duas diferenças da versão normal:
 *
 *  - `id` vem PRONTO de quem chama (gerado no agente, no momento da leitura
 *    da digital) em vez de gerado aqui, e o INSERT é "OR IGNORE": isso torna
 *    a operação idempotente — se o mesmo lote for reenviado (ex.: o agente
 *    reiniciou antes de receber a confirmação do servidor), o registro já
 *    existente é silenciosamente ignorado em vez de duplicado.
 *  - `criadoEm`, quando informado, é o horário em que o evento realmente
 *    aconteceu na catraca (capturado pelo agente), não o horário em que o
 *    lote chegou no servidor — importante porque, numa queda de internet, o
 *    reenvio pode acontecer bem depois do toque de verdade, e "Últimos
 *    acessos" deve mostrar quando o aluno passou, não quando a fila foi
 *    esvaziada.
 */
async function registrarAcessoIdempotente({ id, alunoId, metodo, resultado, mensagem, criadoEm }) {
  if (criadoEm) {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem, criado_em) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, alunoId || null, metodo, resultado, mensagem || null, criadoEm],
    });
  } else {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem) VALUES (?, ?, ?, ?, ?)',
      args: [id, alunoId || null, metodo, resultado, mensagem || null],
    });
  }
}

/**
 * Ponto único de acionamento físico da catraca. catracaGateway decide sozinho
 * se fala TCP direto (deploy local, mesma rede da catraca) ou se repassa o
 * comando para o agente local via WebSocket (deploy na nuvem).
 */
async function liberarNaCatraca(mensagem) {
  const ip = process.env.HENRY_CATRACA_IP;
  const port = Number(process.env.HENRY_CATRACA_PORT || 3000);
  if (!ip) throw new Error('HENRY_CATRACA_IP não configurado no servidor.');
  await catracaGateway.liberarAcesso({ ip, port, mensagem });
}

/**
 * Fluxo completo: checa status, tenta abrir a catraca se autorizado, registra
 * o log de acesso e retorna o resultado para a tela do totem.
 */
async function tentarLiberar({ aluno, metodo }) {
  const { autorizado, motivo } = await verificarAutorizacaoAluno(aluno);

  if (!autorizado) {
    await registrarAcesso({ alunoId: aluno ? aluno.id : null, metodo, resultado: 'negado', mensagem: motivo });
    // cpf/aluno_id vão junto mesmo no negado — a tela do totem usa isso pra
    // oferecer "Pagar contas em atraso" já com o CPF preenchido, sem o aluno
    // precisar digitar de novo (só faz sentido quando o motivo é financeiro,
    // mas não custa nada mandar sempre; o front decide quando mostrar o botão).
    return { autorizado: false, motivo, aluno_nome: aluno ? aluno.nome : null, aluno_id: aluno ? aluno.id : null, cpf: aluno ? aluno.cpf : null };
  }

  try {
    await liberarNaCatraca(`Bem-vindo(a) ${aluno.nome}`);
  } catch (err) {
    const motivoFalha = `Falha ao comunicar com a catraca: ${err.message}`;
    await registrarAcesso({ alunoId: aluno.id, metodo, resultado: 'negado', mensagem: motivoFalha });
    return { autorizado: false, motivo: motivoFalha, aluno_nome: aluno.nome, aluno_id: aluno.id, cpf: aluno.cpf };
  }

  await registrarAcesso({ alunoId: aluno.id, metodo, resultado: 'liberado', mensagem: null });
  return { autorizado: true, motivo: null, aluno_nome: aluno.nome, aluno_id: aluno.id, cpf: aluno.cpf };
}

module.exports = {
  gerarCodigoAcesso,
  garantirCodigoAcesso,
  buscarAlunoPorCpf,
  buscarAlunoPorCodigoAcesso,
  buscarAlunoPorBiometriaId,
  encontrarMelhorMatchFacial,
  salvarFaceDescriptor,
  verificarAutorizacaoAluno,
  listarAutorizacoesBiometricas,
  notificarAgenteAtualizacaoAluno,
  temMatriculaAtiva,
  possuiCobrancaEmAtraso,
  registrarAcesso,
  registrarAcessoIdempotente,
  tentarLiberar,
};
