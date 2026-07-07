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
 * Decide se o aluno pode entrar agora, com o motivo em caso negativo.
 * Regra: o que bloqueia de verdade é o status do cadastro e a existência de
 * cobrança em atraso — NÃO a falta de matrícula ativa. Um aluno sem nenhuma
 * matrícula (ex.: ainda não vendeu plano, ou plano expirou) mas sem nenhuma
 * conta em aberto continua liberado; só cancelar/trancar o cadastro ou ter
 * mensalidade vencida é que bloqueia.
 */
async function verificarAutorizacaoAluno(aluno) {
  if (!aluno) return { autorizado: false, motivo: 'Aluno não encontrado.' };
  if (aluno.status === 'inadimplente') return { autorizado: false, motivo: 'Existem mensalidades em atraso.' };
  if (aluno.status === 'trancado') return { autorizado: false, motivo: 'Cadastro trancado.' };
  if (aluno.status === 'inativo') return { autorizado: false, motivo: 'Cadastro inativo.' };
  if (aluno.status !== 'ativo') return { autorizado: false, motivo: `Status "${aluno.status}" não permite acesso.` };

  const emAtraso = await possuiCobrancaEmAtraso(aluno.id);
  if (emAtraso) return { autorizado: false, motivo: 'Existem mensalidades em atraso.' };

  return { autorizado: true, motivo: null };
}

async function registrarAcesso({ alunoId, metodo, resultado, mensagem }) {
  await db.execute({
    sql: 'INSERT INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem) VALUES (?, ?, ?, ?, ?)',
    args: [uuid(), alunoId || null, metodo, resultado, mensagem || null],
  });
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
    return { autorizado: false, motivo, aluno_nome: aluno ? aluno.nome : null };
  }

  try {
    await liberarNaCatraca(`Bem-vindo(a) ${aluno.nome}`);
  } catch (err) {
    const motivoFalha = `Falha ao comunicar com a catraca: ${err.message}`;
    await registrarAcesso({ alunoId: aluno.id, metodo, resultado: 'negado', mensagem: motivoFalha });
    return { autorizado: false, motivo: motivoFalha, aluno_nome: aluno.nome };
  }

  await registrarAcesso({ alunoId: aluno.id, metodo, resultado: 'liberado', mensagem: null });
  return { autorizado: true, motivo: null, aluno_nome: aluno.nome };
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
  temMatriculaAtiva,
  possuiCobrancaEmAtraso,
  registrarAcesso,
  tentarLiberar,
};
