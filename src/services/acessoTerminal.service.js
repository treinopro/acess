/**
 * Lógica compartilhada do totem/terminal de auto atendimento: identificação do
 * aluno (CPF, código/QR, reconhecimento facial, biometria da própria catraca),
 * checagem de status e acionamento da catraca Henry via catracaGateway.service
 * (que decide sozinho entre TCP direto e o agente local — ver esse arquivo).
 */

const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db/client');
const dbOffline = require('../db/clientOffline');
const catracaGateway = require('./catracaGateway.service');
const agenteGateway = require('./agenteGateway.service');
const dbResiliente = require('./dbResiliente.service');
const filaAcessosOffline = require('./filaAcessosOffline.service');

// 2026-07-21: baixado de 0.6 pra 0.5 depois de um relato real do dono do
// sistema — aluno SEM rosto cadastrado liberava a catraca, confundido com
// outro aluno que TEM rosto cadastrado. 0.6 é o valor que a própria
// documentação do face-api.js sugere pra "mesma pessoa", mas isso já assume
// fotos de boa qualidade — numa câmera de tablet, com a resolução/luz de
// academia, a distância entre pessoas DIFERENTES cai com mais frequência
// dentro de um limiar tão largo. Um valor menor é mais rígido (nega um
// aluno de vez em quando, que resolve com CPF/QR) só pra evitar liberar a
// pessoa errada. Ver também MARGEM_MINIMA_SEGUNDO_MELHOR abaixo, que ataca a
// mesma causa por outro ângulo. Pode ser sobrescrito por FACE_MATCH_THRESHOLD
// no .env — se a produção (Northflank) já tem essa variável configurada
// explicitamente, PRECISA ser atualizada lá também; mudar só aqui/no .env
// local não muda o valor em produção.
const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.5);

// Não basta a MENOR distância bater dentro do limiar — se duas pessoas
// cadastradas ficam quase igualmente próximas do rosto capturado (comum com
// poucos alunos cadastrados, ou fotos parecidas), escolher só a menor ainda
// arrisca escolher a pessoa errada. Exige que a melhor distância seja
// nitidamente menor que a segunda melhor; se ficarem "empatadas" dentro
// dessa margem, o sistema recusa em vez de arriscar (a pessoa tenta de novo
// ou usa CPF/QR). Configurável via FACE_MATCH_MARGEM_MINIMA no .env.
const MARGEM_MINIMA_SEGUNDO_MELHOR = Number(process.env.FACE_MATCH_MARGEM_MINIMA || 0.07);

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

// Maior código conhecido do "cartão" da catraca Henry em 2026-07 (ver
// scripts/importar-biometria-catraca.js) — piso de segurança pra nunca gerar
// um código sequencial menor que isso, mesmo que o banco ainda não tenha
// nenhum biometria_id numérico salvo (ex.: banco de testes zerado).
const MENOR_CODIGO_ALUNO_BASE = 1538;

/**
 * Calcula (sem reservar/salvar) o próximo código sequencial disponível, no
 * mesmo padrão do "cartão" da catraca Henry — olha o maior biometria_id
 * numérico já em uso e soma 1. Usado tanto pela senha do portal (ver
 * atribuirCodigoAluno) quanto, futuramente, pelo cadastro automático de
 * cartão na catraca (ver conversa 2026-07-12 — ainda não implementado).
 */
async function calcularProximoCodigoAluno() {
  const result = await db.execute(
    "SELECT biometria_id FROM alunos WHERE biometria_id IS NOT NULL AND biometria_id GLOB '[0-9]*'",
  );
  let maior = MENOR_CODIGO_ALUNO_BASE;
  for (const row of result.rows) {
    const n = Number(row.biometria_id);
    if (Number.isFinite(n) && n > maior) maior = n;
  }
  return String(maior + 1);
}

/**
 * Gera e salva um novo código sequencial pro aluno (ver
 * calcularProximoCodigoAluno) — usado como senha do portal remoto (ver
 * portal.routes.js). Nunca sobrescreve um biometria_id já existente (ex.:
 * aluno que já tinha sido enrolado fisicamente na catraca antes desse
 * recurso existir — nesse caso o código dele já é esse, só reaproveita).
 * Tenta de novo (recalculando o próximo número) se colidir com outro
 * cadastro simultâneo — biometria_id tem índice único parcial no schema.
 */
async function atribuirCodigoAluno(alunoId, tentativasRestantes = 5) {
  const atual = await db.execute({ sql: 'SELECT biometria_id FROM alunos WHERE id = ?', args: [alunoId] });
  if (!atual.rows[0]) throw Object.assign(new Error('Aluno não encontrado.'), { status: 404 });
  if (atual.rows[0].biometria_id) return atual.rows[0].biometria_id;

  const codigo = await calcularProximoCodigoAluno();
  try {
    await db.execute({
      sql: 'UPDATE alunos SET biometria_id = ? WHERE id = ? AND biometria_id IS NULL',
      args: [codigo, alunoId],
    });
    return codigo;
  } catch (err) {
    if (tentativasRestantes > 0) return atribuirCodigoAluno(alunoId, tentativasRestantes - 1);
    throw err;
  }
}

async function buscarAlunoPorCpfEm(cliente, cpf) {
  const result = await cliente.execute({ sql: 'SELECT * FROM alunos WHERE cpf = ?', args: [cpf] });
  return result.rows[0] || null;
}

async function buscarAlunoPorCodigoAcessoEm(cliente, codigo) {
  const result = await cliente.execute({ sql: 'SELECT * FROM alunos WHERE codigo_acesso = ?', args: [codigo] });
  return result.rows[0] || null;
}

async function buscarAlunoPorBiometriaId(biometriaId) {
  const result = await db.execute({ sql: 'SELECT * FROM alunos WHERE biometria_id = ?', args: [biometriaId] });
  return result.rows[0] || null;
}

/**
 * Variantes usadas SÓ pelo fluxo de ACESSO do totem (/api/terminal/acesso/cpf
 * e /acesso/codigo — ver terminal.routes.js), nunca por cadastro/vinculação:
 * tentam o Turso e caem pro local.db (modo totem offline-resiliente, ver
 * dbResiliente.service.js) só quando MODO_TOTEM_OFFLINE=true e o Turso não
 * responder. As versões acima (buscarAlunoPorCpf/buscarAlunoPorCodigoAcesso)
 * continuam SEM fallback de propósito — cadastro/vinculação (rosto, código
 * de acesso) sempre exige o Turso disponível, decisão confirmada com o dono
 * do sistema (2026-07): não faz sentido cadastrar contra um cache
 * desatualizado.
 */
async function buscarAlunoPorCpfParaAcesso(cpf) {
  return dbResiliente.comFallback(
    'buscarAlunoPorCpf',
    () => buscarAlunoPorCpfEm(db, cpf),
    () => buscarAlunoPorCpfEm(dbOffline, cpf),
  );
}

async function buscarAlunoPorCodigoAcessoParaAcesso(codigo) {
  return dbResiliente.comFallback(
    'buscarAlunoPorCodigoAcesso',
    () => buscarAlunoPorCodigoAcessoEm(db, codigo),
    () => buscarAlunoPorCodigoAcessoEm(dbOffline, codigo),
  );
}

async function buscarAlunoPorCpf(cpf) {
  return buscarAlunoPorCpfEm(db, cpf);
}

async function buscarAlunoPorCodigoAcesso(codigo) {
  return buscarAlunoPorCodigoAcessoEm(db, codigo);
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
async function encontrarMelhorMatchFacialEm(cliente, descriptorRecebido) {
  const result = await cliente.execute("SELECT * FROM alunos WHERE face_descriptor IS NOT NULL");
  let melhor = null;
  let menorDistancia = Infinity;
  let segundaMenorDistancia = Infinity; // 2o colocado — ver MARGEM_MINIMA_SEGUNDO_MELHOR
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
      segundaMenorDistancia = menorDistancia;
      menorDistancia = distancia;
      melhor = aluno;
    } else if (distancia < segundaMenorDistancia) {
      segundaMenorDistancia = distancia;
    }
  }

  // 2026-07-21: não basta a MENOR distância bater dentro do limiar — se duas
  // pessoas cadastradas ficam quase igualmente próximas do rosto capturado
  // (ex.: poucos alunos cadastrados ainda, ou fotos parecidas), escolher só
  // a menor arrisca escolher a pessoa errada (foi exatamente o bug
  // relatado: aluno sem rosto cadastrado liberando como se fosse outro
  // aluno). Só considera "dentro do limite" quando, além de bater o
  // FACE_MATCH_THRESHOLD, a melhor distância é nitidamente menor que a
  // segunda melhor — com um único candidato cadastrado (segundaMenorDistancia
  // continua Infinity), essa exigência não se aplica.
  const margemSuficiente = !Number.isFinite(segundaMenorDistancia)
    || (segundaMenorDistancia - menorDistancia) >= MARGEM_MINIMA_SEGUNDO_MELHOR;
  // Sempre devolve o melhor candidato e a distância, mesmo fora do limiar —
  // útil para diagnosticar/ajustar FACE_MATCH_THRESHOLD durante os testes.
  const dentroDoLimite = Boolean(melhor) && menorDistancia <= FACE_MATCH_THRESHOLD && margemSuficiente;
  return {
    aluno: melhor,
    distancia: Number.isFinite(menorDistancia) ? menorDistancia : null,
    distanciaSegundoMelhor: Number.isFinite(segundaMenorDistancia) ? segundaMenorDistancia : null,
    dentroDoLimite,
    candidatosComparados,
    limite: FACE_MATCH_THRESHOLD,
  };
}

async function encontrarMelhorMatchFacial(descriptorRecebido) {
  return encontrarMelhorMatchFacialEm(db, descriptorRecebido);
}

/**
 * Variante usada SÓ pelo fluxo de acesso (/api/terminal/acesso/facial) —
 * tenta o Turso e cai pro local.db (modo totem offline-resiliente) só se
 * MODO_TOTEM_OFFLINE=true e o Turso não responder. Ver comentário em
 * buscarAlunoPorCpfParaAcesso acima — o cadastro/vínculo de rosto
 * (/vincular/facial) NUNCA usa esta variante, sempre exige o Turso.
 */
async function encontrarMelhorMatchFacialParaAcesso(descriptorRecebido) {
  return dbResiliente.comFallback(
    'encontrarMelhorMatchFacial',
    () => encontrarMelhorMatchFacialEm(db, descriptorRecebido),
    () => encontrarMelhorMatchFacialEm(dbOffline, descriptorRecebido),
  );
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
async function possuiCobrancaEmAtrasoEm(cliente, alunoId) {
  const result = await cliente.execute({
    sql: `SELECT COUNT(*) as total FROM cobrancas
          WHERE aluno_id = ? AND matricula_id IS NOT NULL AND (
            status = 'atrasado'
            OR (status = 'pendente' AND vencimento IS NOT NULL AND vencimento < date('now'))
          )`,
    args: [alunoId],
  });
  return Number(result.rows[0].total) > 0;
}

async function possuiCobrancaEmAtraso(alunoId) {
  return possuiCobrancaEmAtrasoEm(db, alunoId);
}

/**
 * Concessão de acesso especial/gratuito (2026-07, feature de recuperação de
 * clientes — ver src/routes/recuperacao.routes.js e tabela
 * concessoes_acesso): permite liberar a catraca temporariamente pra um aluno
 * inadimplente, sem tocar em nenhuma cobrança de verdade (ex.: "5 dias
 * grátis pra retomar aos treinos" mandado por e-mail/WhatsApp). Só é
 * consultada quando o bloqueio seria por INADIMPLÊNCIA — ver
 * verificarAutorizacaoAluno logo abaixo.
 */
async function possuiConcessaoAcessoAtivaEm(cliente, alunoId) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  const result = await cliente.execute({
    sql: 'SELECT COUNT(*) as total FROM concessoes_acesso WHERE aluno_id = ? AND valido_ate >= ?',
    args: [alunoId, hojeISO],
  });
  return Number(result.rows[0].total) > 0;
}

async function possuiConcessaoAcessoAtiva(alunoId) {
  return possuiConcessaoAcessoAtivaEm(db, alunoId);
}

/**
 * Categorias de pessoa com acesso livre (2026-07 — sistema de modalidades e
 * visitantes, ver comentário em schema.sql junto de alunos.categoria):
 * colaborador e bolsista nunca são bloqueados por mensalidade em atraso —
 * eles simplesmente não têm mensalidade. Cadastro trancado/inativo (decisão
 * manual do admin) continua bloqueando igual a qualquer outra categoria —
 * ver verificarAutorizacaoAluno, esta checagem só entra DEPOIS da checagem de
 * status.
 */
const CATEGORIA_ACESSO_LIVRE = new Set(['colaborador', 'bolsista']);

// 2026-07-19: o período gratuito do visitante passou a ser contado em DIAS
// CORRIDOS a partir da primeira liberação (visitante_liberado_em, ver
// schema.sql), não mais por número de acessos — um visitante limitado a "1
// acesso" não conseguia nem sair e voltar a entrar no mesmo dia (ex.: foi
// buscar algo no carro). Ver visitanteDentroDoPeriodo abaixo.
const LIMITE_DIAS_VISITANTE_PADRAO = 1;

/** Lê o limite de dias de acesso gratuito por visitante (Configurações > Visitantes). */
async function limiteDiasVisitanteEm(cliente) {
  const result = await cliente.execute("SELECT valor FROM configuracoes WHERE chave = 'visitante_limite_dias'");
  const n = Number(result.rows[0]?.valor);
  return Number.isFinite(n) && n >= 0 ? n : LIMITE_DIAS_VISITANTE_PADRAO;
}

/**
 * Decide se um visitante ainda está dentro do período de acesso gratuito.
 * Antes da primeira liberação (visitanteLiberadoEm null/vazio) ele SEMPRE
 * está dentro — ainda não começou a contar nada. A partir da primeira
 * liberação, vale por `dias` dias corridos (24h * dias) a contar da data
 * (não do horário exato) dessa primeira liberação, então o visitante sempre
 * ganha o dia inteiro da liberação + os dias seguintes completos, em vez de
 * expirar no meio do dia seguinte por causa do horário exato em que entrou.
 */
function visitanteDentroDoPeriodo(visitanteLiberadoEm, dias, agora = new Date()) {
  if (!visitanteLiberadoEm) return true;
  const dataBase = new Date(`${String(visitanteLiberadoEm).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(dataBase.getTime())) return true; // dado corrompido: nao bloqueia por causa disso
  const limite = new Date(dataBase.getTime() + dias * 86400000);
  return agora < limite;
}

const LIMITE_INDICACOES_PADRAO = 2;

/** Lê o limite de indicações de visitante por mês, por aluno (Configurações > Visitantes). */
async function limiteIndicacoesMensalEm(cliente) {
  const result = await cliente.execute("SELECT valor FROM configuracoes WHERE chave = 'indicacao_limite_mensal'");
  const n = Number(result.rows[0]?.valor);
  return Number.isFinite(n) && n >= 0 ? n : LIMITE_INDICACOES_PADRAO;
}

/**
 * Conta quantos visitantes um aluno já indicou (cadastrou como amigo) desde o
 * início do mês corrente (UTC — mesma convenção usada em cobrancas.service.js
 * pra "mês"). Usado tanto pra aplicar o limite mensal na hora de cadastrar um
 * novo visitante (terminal.routes.js) quanto pro relatório de indicações.
 */
async function contarIndicacoesNoMesEm(cliente, alunoIndicadorId) {
  const inicioMes = new Date();
  inicioMes.setUTCDate(1);
  const inicioMesISO = inicioMes.toISOString().slice(0, 10);
  const result = await cliente.execute({
    sql: "SELECT COUNT(*) as total FROM alunos WHERE indicado_por_aluno_id = ? AND substr(criado_em, 1, 10) >= ?",
    args: [alunoIndicadorId, inicioMesISO],
  });
  return Number(result.rows[0].total);
}

async function contarIndicacoesNoMes(alunoIndicadorId) {
  return contarIndicacoesNoMesEm(db, alunoIndicadorId);
}

/**
 * Aviso de vencimento mostrado no totem/catraca a cada check-in (2026-07):
 * busca a mensalidade em aberto (pendente ou atrasada, vinculada a matrícula)
 * com o vencimento mais próximo, e monta a mensagem "faltam N dias" (ainda no
 * prazo) ou "vencido há N dias" (a partir do dia seguinte ao vencimento — o
 * front pinta essa em vermelho). Puramente informativo: mesmo quando o acesso
 * já foi liberado, o aluno pode estar a poucos dias do vencimento e a ideia é
 * avisar com antecedência, não só bloquear depois que já venceu.
 */
async function buscarProximaMensalidadeEmAbertoEm(cliente, alunoId) {
  const result = await cliente.execute({
    sql: `SELECT vencimento FROM cobrancas
          WHERE aluno_id = ? AND matricula_id IS NOT NULL AND status IN ('pendente', 'atrasado') AND vencimento IS NOT NULL
          ORDER BY vencimento ASC LIMIT 1`,
    args: [alunoId],
  });
  return result.rows[0] ? result.rows[0].vencimento : null;
}

function diasEntreDatas(dataInicioISO, dataFimISO) {
  const a = new Date(`${dataInicioISO}T00:00:00Z`);
  const b = new Date(`${dataFimISO}T00:00:00Z`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function montarAvisoVencimento(vencimentoISO) {
  if (!vencimentoISO) return null;
  const hojeISO = new Date().toISOString().slice(0, 10);
  const dias = diasEntreDatas(hojeISO, vencimentoISO);

  if (dias > 0) {
    return { vencimento: vencimentoISO, dias, vencido: false, mensagem: `Faltam ${dias} dia${dias === 1 ? '' : 's'} para o vencimento da mensalidade.` };
  }
  if (dias === 0) {
    return { vencimento: vencimentoISO, dias: 0, vencido: false, mensagem: 'Sua mensalidade vence hoje.' };
  }
  const diasVencido = Math.abs(dias);
  return { vencimento: vencimentoISO, dias, vencido: true, mensagem: `Mensalidade vencida há ${diasVencido} dia${diasVencido === 1 ? '' : 's'}.` };
}

// Mesmo padrão fallback-aware das outras checagens usadas no fluxo de acesso
// (ver buscarAlunoPorCpfParaAcesso e verificarAutorizacaoAluno acima): tenta o
// Turso e cai pro local.db só quando MODO_TOTEM_OFFLINE=true e o Turso não
// responder. Nunca deve travar a liberação de acesso por causa de si mesma —
// por isso quem chama (tentarLiberar) sempre envolve isto num best-effort.
async function buscarAvisoVencimento(alunoId) {
  const vencimento = await dbResiliente.comFallback(
    'buscarProximaMensalidadeEmAberto',
    () => buscarProximaMensalidadeEmAbertoEm(db, alunoId),
    () => buscarProximaMensalidadeEmAbertoEm(dbOffline, alunoId),
  );
  return montarAvisoVencimento(vencimento);
}

async function buscarAvisoVencimentoSeguro(alunoId) {
  try {
    return await buscarAvisoVencimento(alunoId);
  } catch {
    // Best-effort de propósito (ver comentário acima) — nunca deve impedir a
    // liberação/negação normal de acesso.
    return null;
  }
}

/**
 * "Primeiro acesso do dia" (2026-07) — usado pelo aviso sonoro do totem
 * (ver terminal.js/config.routes.js, chave "som_totem"): toca "Bom treino!"
 * (ou o que o admin configurar) só no 1º acesso liberado do dia de cada
 * aluno; os seguintes tocam o aviso normal de "acesso liberado".
 *
 * IMPORTANTE: precisa ser chamado ANTES de `registrarAcesso` gravar o acesso
 * de agora — senão o próprio acesso atual já contaria como "já teve acesso
 * hoje" e a saudação de primeiro acesso nunca tocaria.
 *
 * acessos_catraca.criado_em é gravado como "AAAA-MM-DD HH:MM:SS" em UTC (ver
 * comentário de formatarDataOuDataHora em app.js) — comparamos só os 10
 * primeiros caracteres (a data) contra o dia de hoje em UTC, mesma convenção
 * já usada em cobrancas.service.js. Isso pode discordar por algumas horas do
 * "dia" na hora local da academia perto da virada da meia-noite UTC — efeito
 * colateral aceitável aqui (só decide qual frase toca, nunca bloqueia acesso).
 */
async function jaTeveAcessoLiberadoHojeEm(cliente, alunoId) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  const result = await cliente.execute({
    sql: `SELECT COUNT(*) as total FROM acessos_catraca
          WHERE aluno_id = ? AND resultado = 'liberado' AND substr(criado_em, 1, 10) = ?`,
    args: [alunoId, hojeISO],
  });
  return Number(result.rows[0].total) > 0;
}

async function verificarPrimeiroAcessoHojeSeguro(alunoId) {
  try {
    const jaTeve = await dbResiliente.comFallback(
      'jaTeveAcessoLiberadoHoje',
      () => jaTeveAcessoLiberadoHojeEm(db, alunoId),
      () => jaTeveAcessoLiberadoHojeEm(dbOffline, alunoId),
    );
    return !jaTeve;
  } catch {
    // Best-effort: na dúvida, não trata como "primeiro acesso" — evita tocar
    // a saudação de "bom treino" repetidamente se essa checagem falhar.
    return false;
  }
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
/**
 * A checagem de cobrança em atraso é sempre feita com fallback pro local.db
 * (modo totem offline-resiliente) quando MODO_TOTEM_OFFLINE=true e o Turso
 * não responder — diferente das leituras de cadastro, esta é uma decisão de
 * ACESSO (o aluno já foi identificado antes de chegar aqui), então cai no
 * mesmo caso de "risco aceito" combinado com o dono do sistema. Fora do modo
 * totem offline-resiliente, comFallback() chama o Turso direto, sem nenhuma
 * mudança de comportamento.
 */
async function verificarAutorizacaoAluno(aluno) {
  const motivoStatus = motivoBloqueioPorStatus(aluno);

  // Cadastro trancado/inativo/outro status manual: bloqueia sempre, concessão
  // especial NÃO reativa (é uma decisão do admin não relacionada a
  // pagamento). Só o caso "inadimplente" é potencialmente contornável por uma
  // concessão de acesso especial.
  if (motivoStatus && motivoStatus !== 'Existem mensalidades em atraso.') {
    return { autorizado: false, motivo: motivoStatus };
  }

  const categoria = aluno.categoria || 'aluno';

  // Colaborador/bolsista: acesso livre, nunca depende de mensalidade (2026-07)
  // — mas o status trancado/inativo checado acima continua valendo igual.
  if (CATEGORIA_ACESSO_LIVRE.has(categoria)) {
    return { autorizado: true, motivo: null };
  }

  // Visitante: não tem mensalidade pra checar — em vez disso, um período de
  // dias corridos de acesso gratuito a partir da primeira liberação
  // (configurável em Configurações > Visitantes, padrão 1 dia — ver
  // visitanteDentroDoPeriodo). Depois que o período acaba, precisa virar
  // aluno pagante (matrícula de verdade) pra continuar acessando.
  if (categoria === 'visitante') {
    const dias = await dbResiliente.comFallback('limiteDiasVisitante', () => limiteDiasVisitanteEm(db), () => limiteDiasVisitanteEm(dbOffline));
    if (!visitanteDentroDoPeriodo(aluno.visitante_liberado_em, dias)) {
      return {
        autorizado: false,
        motivo: `Período de ${dias} dia${dias === 1 ? '' : 's'} de acesso gratuito como visitante encerrado. Procure a recepção para se matricular.`,
      };
    }
    return { autorizado: true, motivo: null };
  }

  const emAtraso = motivoStatus
    ? true // status já diz 'inadimplente' — trata como em atraso sem precisar consultar cobrancas de novo
    : await dbResiliente.comFallback(
      'possuiCobrancaEmAtraso',
      () => possuiCobrancaEmAtrasoEm(db, aluno.id),
      () => possuiCobrancaEmAtrasoEm(dbOffline, aluno.id),
    );

  if (!emAtraso) return { autorizado: true, motivo: null };

  const concessaoAtiva = await dbResiliente.comFallback(
    'possuiConcessaoAcessoAtiva',
    () => possuiConcessaoAcessoAtivaEm(db, aluno.id),
    () => possuiConcessaoAcessoAtivaEm(dbOffline, aluno.id),
  );
  if (concessaoAtiva) return { autorizado: true, motivo: null };

  return { autorizado: false, motivo: 'Existem mensalidades em atraso.' };
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
  const hojeISO = new Date().toISOString().slice(0, 10);
  const [resultAlunos, resultAtraso, resultConcessoes, diasVisitante] = await Promise.all([
    db.execute("SELECT id, nome, status, biometria_id, categoria, visitante_liberado_em FROM alunos WHERE biometria_id IS NOT NULL AND biometria_id != ''"),
    db.execute(`SELECT DISTINCT aluno_id FROM cobrancas
                WHERE matricula_id IS NOT NULL AND (
                  status = 'atrasado'
                  OR (status = 'pendente' AND vencimento IS NOT NULL AND vencimento < date('now'))
                )`),
    db.execute({ sql: 'SELECT DISTINCT aluno_id FROM concessoes_acesso WHERE valido_ate >= ?', args: [hojeISO] }),
    limiteDiasVisitanteEm(db),
  ]);

  const idsEmAtraso = new Set(resultAtraso.rows.map((linha) => linha.aluno_id));
  const idsComConcessao = new Set(resultConcessoes.rows.map((linha) => linha.aluno_id));

  return resultAlunos.rows.map((aluno) => {
    const motivoStatus = motivoBloqueioPorStatus(aluno);
    // Mesma regra de verificarAutorizacaoAluno: concessão só contorna
    // inadimplência (status ou cobrança em atraso), nunca trancamento/inatividade.
    if (motivoStatus && motivoStatus !== 'Existem mensalidades em atraso.') {
      return { biometria_id: aluno.biometria_id, autorizado: false, aluno_nome: aluno.nome, motivo: motivoStatus };
    }

    const categoria = aluno.categoria || 'aluno';
    if (CATEGORIA_ACESSO_LIVRE.has(categoria)) {
      return { biometria_id: aluno.biometria_id, autorizado: true, aluno_nome: aluno.nome, motivo: null };
    }
    if (categoria === 'visitante') {
      if (!visitanteDentroDoPeriodo(aluno.visitante_liberado_em, diasVisitante)) {
        return {
          biometria_id: aluno.biometria_id,
          autorizado: false,
          aluno_nome: aluno.nome,
          motivo: `Período de ${diasVisitante} dia${diasVisitante === 1 ? '' : 's'} de acesso gratuito como visitante encerrado. Procure a recepção para se matricular.`,
        };
      }
      return { biometria_id: aluno.biometria_id, autorizado: true, aluno_nome: aluno.nome, motivo: null };
    }

    const emAtraso = motivoStatus ? true : idsEmAtraso.has(aluno.id);
    if (emAtraso && !idsComConcessao.has(aluno.id)) {
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
    const result = await db.execute({ sql: 'SELECT id, nome, status, biometria_id, categoria, visitante_liberado_em FROM alunos WHERE id = ?', args: [alunoId] });
    const aluno = result.rows[0];
    if (!aluno || !aluno.biometria_id) return;

    const { autorizado, motivo } = await verificarAutorizacaoAluno(aluno);
    const item = { biometria_id: aluno.biometria_id, autorizado, aluno_nome: aluno.nome, motivo };

    await agenteGateway.enviarComando('atualizar_cache', { itens: [item], substituir_tudo: false });
  } catch {
    // Best-effort de propósito: falha aqui (aluno sem biometria, agente
    // desconectado, timeout etc.) nunca deve derrubar quem chamou esta
    // função — o próximo pull periódico do agente cobre a atualização.
  }
}

/**
 * Registra um acesso (log de "Últimos acessos"). Fora do modo totem
 * offline-resiliente (MODO_TOTEM_OFFLINE não definido — cobre a produção
 * normal na nuvem hoje), o comportamento é EXATAMENTE o de antes desta
 * mudança: grava direto, deixa erro propagar.
 *
 * Com MODO_TOTEM_OFFLINE=true, tenta gravar direto no Turso; se falhar
 * (internet caiu), o evento entra na fila local (ver
 * filaAcessosOffline.service.js) em vez de se perder, e é reenviado sozinho
 * assim que o Turso voltar a responder. Por isso esta função NUNCA lança
 * nesse modo — quem chama não precisa (nem deve) tratar erro daqui.
 */
async function registrarAcesso({ alunoId, metodo, resultado, mensagem }) {
  if (!dbResiliente.MODO_TOTEM_OFFLINE) {
    await db.execute({
      sql: 'INSERT INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem) VALUES (?, ?, ?, ?, ?)',
      args: [uuid(), alunoId || null, metodo, resultado, mensagem || null],
    });
    return;
  }

  const evento = {
    id: uuid(),
    alunoId: alunoId || null,
    metodo,
    resultado,
    mensagem: mensagem || null,
    criadoEm: new Date().toISOString(),
  };
  try {
    await dbResiliente.comTimeout(
      registrarAcessoIdempotenteEm(db, evento),
      dbResiliente.timeoutAtual(),
    );
    dbResiliente.registrarRecuperacaoSeNecessario();
  } catch (err) {
    dbResiliente.logAlertaOffline('registrarAcesso', err);
    filaAcessosOffline.registrar(evento);
  }
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
async function registrarAcessoIdempotenteEm(cliente, { id, alunoId, metodo, resultado, mensagem, criadoEm }) {
  if (criadoEm) {
    await cliente.execute({
      sql: 'INSERT OR IGNORE INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem, criado_em) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, alunoId || null, metodo, resultado, mensagem || null, criadoEm],
    });
  } else {
    await cliente.execute({
      sql: 'INSERT OR IGNORE INTO acessos_catraca (id, aluno_id, metodo, resultado, mensagem) VALUES (?, ?, ?, ?, ?)',
      args: [id, alunoId || null, metodo, resultado, mensagem || null],
    });
  }
}

async function registrarAcessoIdempotente(dados) {
  return registrarAcessoIdempotenteEm(db, dados);
}

/**
 * Ponto único de acionamento físico da catraca. catracaGateway decide sozinho
 * se fala TCP direto (deploy local, mesma rede da catraca) ou se repassa o
 * comando para o agente local via WebSocket (deploy na nuvem). O timeout de
 * giro (quanto tempo a catraca fica liberada esperando a pessoa girar, antes
 * de travar sozinha de novo) é configurado no lado do protocolo Henry — ver
 * RELEASE_TIME_DECIMOS em henryCatraca.service.js.
 */
async function liberarNaCatraca(mensagem) {
  const ip = process.env.HENRY_CATRACA_IP;
  const port = Number(process.env.HENRY_CATRACA_PORT || 3000);
  if (!ip) throw new Error('HENRY_CATRACA_IP não configurado no servidor.');
  await catracaGateway.liberarAcesso({ ip, port, mensagem });
}

// 2026-07-19: intervalo mínimo entre DUAS liberações por reconhecimento
// facial (qualquer aluno) — evita que um aluno reconhecido "seguidas vezes"
// pelo scanner contínuo do totem (ver terminal.js) acabe liberando a catraca
// de novo rápido demais pra deixar outra pessoa passar atrás dele. Estado em
// memória do processo (não persiste em banco) — é só uma trava de UX/anti-
// -carona, não um controle de segurança forte; reinicia com o servidor.
// Configurável via COOLDOWN_LIBERACAO_FACIAL_MS pra ajustar sem redeploy de
// código, caso o valor padrão fique curto/longo demais na prática.
const COOLDOWN_LIBERACAO_FACIAL_MS = Number(process.env.COOLDOWN_LIBERACAO_FACIAL_MS || 6000);
let ultimaLiberacaoFacialEm = 0;

/**
 * Fluxo completo: checa status, tenta abrir a catraca se autorizado, registra
 * o log de acesso e retorna o resultado para a tela do totem.
 */
async function tentarLiberar({ aluno, metodo }) {
  const { autorizado, motivo } = await verificarAutorizacaoAluno(aluno);
  // Aviso de vencimento (2026-07): calculado sempre, liberado ou negado — ver
  // buscarAvisoVencimentoSeguro acima. Nunca lança, então nunca atrasa/impede
  // a decisão de acesso em si.
  const avisoVencimento = aluno ? await buscarAvisoVencimentoSeguro(aluno.id) : null;

  if (!autorizado) {
    await registrarAcesso({ alunoId: aluno ? aluno.id : null, metodo, resultado: 'negado', mensagem: motivo });
    // cpf/aluno_id vão junto mesmo no negado — a tela do totem usa isso pra
    // oferecer "Pagar contas em atraso" já com o CPF preenchido, sem o aluno
    // precisar digitar de novo (só faz sentido quando o motivo é financeiro,
    // mas não custa nada mandar sempre; o front decide quando mostrar o botão).
    return { autorizado: false, motivo, aluno_nome: aluno ? aluno.nome : null, aluno_id: aluno ? aluno.id : null, cpf: aluno ? aluno.cpf : null, aviso_vencimento: avisoVencimento };
  }

  // Cooldown entre liberações por face (2026-07-19, ver COOLDOWN_LIBERACAO_FACIAL_MS
  // acima) — só entra DEPOIS de confirmar que a pessoa está autorizada (não
  // queremos "gastar" o cooldown numa tentativa que já seria negada de
  // qualquer jeito), e só bloqueia quem está tentando entrar por
  // reconhecimento facial — CPF, QR e biometria da própria catraca não usam
  // este cooldown, porque cada um já exige uma ação física distinta (digitar,
  // mostrar QR, encostar o dedo) que naturalmente não se presta a "passar a
  // liberação pra trás" do mesmo jeito que o scanner contínuo de rosto.
  if (metodo === 'facial') {
    const agoraMs = Date.now();
    const faltam = COOLDOWN_LIBERACAO_FACIAL_MS - (agoraMs - ultimaLiberacaoFacialEm);
    if (faltam > 0) {
      const motivoCooldown = 'Aguarde alguns segundos antes da próxima liberação por reconhecimento facial.';
      await registrarAcesso({ alunoId: aluno.id, metodo, resultado: 'negado', mensagem: motivoCooldown });
      return { autorizado: false, motivo: motivoCooldown, aluno_nome: aluno.nome, aluno_id: aluno.id, cpf: aluno.cpf, aviso_vencimento: avisoVencimento };
    }
  }

  // Precisa ser calculado ANTES de registrarAcesso gravar o acesso de agora
  // (ver comentário de verificarPrimeiroAcessoHojeSeguro acima).
  const primeiroAcessoHoje = await verificarPrimeiroAcessoHojeSeguro(aluno.id);

  try {
    await liberarNaCatraca(`Bem-vindo(a) ${aluno.nome}`);
  } catch (err) {
    const motivoFalha = `Falha ao comunicar com a catraca: ${err.message}`;
    await registrarAcesso({ alunoId: aluno.id, metodo, resultado: 'negado', mensagem: motivoFalha });
    return { autorizado: false, motivo: motivoFalha, aluno_nome: aluno.nome, aluno_id: aluno.id, cpf: aluno.cpf, aviso_vencimento: avisoVencimento };
  }

  if (metodo === 'facial') ultimaLiberacaoFacialEm = Date.now();

  // Primeira liberação de um visitante (2026-07-19): grava quando começou a
  // contar o período de dias grátis (ver visitanteDentroDoPeriodo acima).
  // Best-effort — se essa gravação falhar, não desfaz a liberação que já
  // aconteceu de verdade; só significa que o período recomeça a contar na
  // próxima liberação bem-sucedida.
  if ((aluno.categoria || 'aluno') === 'visitante' && !aluno.visitante_liberado_em) {
    db.execute({
      sql: "UPDATE alunos SET visitante_liberado_em = datetime('now') WHERE id = ? AND visitante_liberado_em IS NULL",
      args: [aluno.id],
    }).catch(() => {});
  }

  await registrarAcesso({ alunoId: aluno.id, metodo, resultado: 'liberado', mensagem: null });
  return { autorizado: true, motivo: null, aluno_nome: aluno.nome, aluno_id: aluno.id, cpf: aluno.cpf, aviso_vencimento: avisoVencimento, primeiro_acesso_hoje: primeiroAcessoHoje };
}

module.exports = {
  gerarCodigoAcesso,
  garantirCodigoAcesso,
  calcularProximoCodigoAluno,
  atribuirCodigoAluno,
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
  possuiConcessaoAcessoAtiva,
  // Categorias/visitantes (2026-07) — reaproveitados pelo relatório de
  // visitantes e pelas rotas de cadastro (terminal.routes.js/alunos.routes.js).
  CATEGORIA_ACESSO_LIVRE,
  limiteDiasVisitanteEm,
  visitanteDentroDoPeriodo,
  limiteIndicacoesMensalEm,
  contarIndicacoesNoMes,
  buscarAvisoVencimento,
  buscarAvisoVencimentoSeguro,
  registrarAcesso,
  registrarAcessoIdempotente,
  tentarLiberar,
  // Variantes fallback-aware (modo totem offline-resiliente, 2026-07) —
  // usadas SÓ pelas rotas de acesso (CPF/QR/facial), nunca por
  // cadastro/vinculação. Ver comentários junto das definições acima.
  buscarAlunoPorCpfParaAcesso,
  buscarAlunoPorCodigoAcessoParaAcesso,
  encontrarMelhorMatchFacialParaAcesso,
};
