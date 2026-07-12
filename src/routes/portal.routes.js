// ---------------------------------------------------------------------------
// Portal remoto do aluno — praticamente o mesmo conjunto de funções do totem
// (cadastro novo, cadastro facial, pagamento de matrícula/contas via CPF,
// consulta de treino), só que acessado de fora da academia (celular/PC do
// aluno em casa) e, por isso, com uma diferença fundamental: NUNCA aciona a
// catraca, de forma nenhuma. Mesmo depois de confirmar um pagamento que
// zeraria o motivo de bloqueio, quem libera a entrada de verdade é o totem
// físico (ou a recepção), não este portal.
//
// IMPORTANTE sobre autenticação: diferente do totem — cujo TERMINAL_TOKEN fica
// só num dispositivo fisicamente controlado pela academia — este portal é uma
// página pública na internet, então não dá pra proteger com um segredo fixo
// embutido no HTML/JS (qualquer um veria o código-fonte).
//
// 2026-07: a prova de identidade deixou de ser só o CPF. No 1o acesso de cada
// aluno, o CPF sozinho ainda basta (mesmo espírito do totem físico) — mas
// nesse momento o portal gera (ou reaproveita, se ele já tiver sido enrolado
// na catraca) um código sequencial e o entrega como "senha", pedindo pro
// aluno guardar. A partir daí, CPF sozinho não abre mais nada — todo acesso
// exige CPF + essa senha (ver autenticarAlunoPortal() logo abaixo). Ideia do
// dono do sistema: reaproveitar um identificador que o aluno já tem/recebe
// fisicamente (o mesmo biometria_id da catraca Henry), sem custo de SMS/
// WhatsApp. Ainda assim, como esse código é sequencial (fácil de tentar por
// força bruta), o rate limit por IP abaixo continua valendo como camada
// adicional — e /vincular/facial tem um limite ainda mais apertado por CPF.
// ---------------------------------------------------------------------------

const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const acessoTerminal = require('../services/acessoTerminal.service');
const pagamentoContas = require('../services/pagamentoContas.service');
const mercadopago = require('../services/payment/mercadopago.service');
const { criarLimitador } = require('../middleware/rateLimit');

const router = express.Router();

// Portal é público e sem login (prova de identidade é só o CPF — ver
// comentário no topo do arquivo), então é o alvo mais fácil pra automação de
// CPFs vazados/sequenciais. Limite geral pra todas as rotas do portal, mais
// restrito ainda em /vincular/facial (ver abaixo) por ser a rota mais sensível.
router.use(criarLimitador({
  janelaMs: 15 * 60 * 1000,
  maximo: 30,
  mensagem: 'Muitas requisições ao portal a partir deste endereço. Aguarde alguns minutos.',
}));

// GET /api/portal/planos — planos ativos, para os seletores de cadastro/upgrade.
router.get('/planos', async (req, res, next) => {
  try {
    const result = await db.execute(
      'SELECT id, nome, tipo, valor_centavos, duracao_dias FROM planos WHERE ativo = 1 ORDER BY valor_centavos',
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------------- Senha do portal (2026-07) ----------------
// A partir do 1o acesso de cada aluno ao portal, CPF sozinho deixa de bastar
// — passa a exigir também a "senha", que é o mesmo código sequencial usado
// como biometria_id na catraca (ideia do dono do sistema: reaproveitar um
// código que o aluno já recebe/conhece fisicamente, sem custo de SMS/
// WhatsApp). Ver GET /aluno abaixo pro fluxo de "revelar" a senha na
// primeira vez, e autenticarAlunoPortal() pra exigi-la depois disso.
//
// Só GET /aluno tem a lógica de "revelar" — todas as outras rotas abaixo
// (treino, contas, upgrade, vincular facial) já assumem que o front-end tem
// a senha em mãos (revelada nessa primeira tela, ou digitada pelo aluno) e
// só validam normalmente.
// Limite por CPF (além do limite geral por IP lá em cima) pras rotas que
// validam senha: o código é sequencial (baixa entropia — 4 dígitos), então
// alguém trocando de IP/rede ainda conseguiria ficar tentando várias senhas
// contra o MESMO CPF sem isso. Generoso o bastante pro uso normal (aluno
// errando a senha uma ou duas vezes).
const limitadorSenhaPortal = criarLimitador({
  janelaMs: 15 * 60 * 1000,
  maximo: 8,
  mensagem: 'Muitas tentativas de acesso para este CPF. Aguarde alguns minutos ou procure a recepção.',
  chavePor: (req) => `senha-portal:${req.body?.cpf || req.query?.cpf || ''}`,
});

async function autenticarAlunoPortal(cpf, senha) {
  const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
  if (!aluno) return { status: 404, erro: 'CPF não encontrado. Use "Quero me cadastrar" se ainda não tem cadastro.' };
  if (!aluno.biometria_id || senha !== aluno.biometria_id) {
    return { status: 401, erro: 'CPF ou senha incorretos.' };
  }
  return { aluno };
}

// GET /api/portal/aluno?cpf=...&senha=... — tela "hub" depois de identificar
// o CPF: nome, modo de treino (pra decidir se mostra a lista nativa ou o
// link do app externo) e o plano atual (pra tela de upgrade saber o que já
// tem).
//
// Único ponto de entrada com a lógica de 1o acesso: se este aluno ainda
// nunca "viu" a senha do portal (portal_senha_revelada = 0), este endpoint
// libera com CPF sozinho, gera o código se ele ainda não tiver um (aluno
// nunca enrolado na catraca) e devolve a senha na resposta pra tela mostrar
// e o aluno guardar — só essa vez. Nos acessos seguintes, exige `senha`
// batendo com o biometria_id, senão 401.
router.get('/aluno', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().trim().optional() }).parse(req.query);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado. Use "Quero me cadastrar" se ainda não tem cadastro.' });

    let primeiroAcesso = false;
    let senhaGerada = null;

    if (!aluno.portal_senha_revelada) {
      senhaGerada = aluno.biometria_id || await acessoTerminal.atribuirCodigoAluno(aluno.id);
      await db.execute({ sql: 'UPDATE alunos SET portal_senha_revelada = 1 WHERE id = ?', args: [aluno.id] });
      primeiroAcesso = true;
    } else if (!senha) {
      return res.status(401).json({ erro: 'Informe também sua senha de acesso.', precisa_senha: true });
    } else if (senha !== aluno.biometria_id) {
      return res.status(401).json({ erro: 'CPF ou senha incorretos.' });
    }

    const matricula = await db.execute({
      sql: `SELECT m.id, m.plano_id, p.nome as plano_nome, p.valor_centavos FROM matriculas m
            JOIN planos p ON p.id = m.plano_id
            WHERE m.aluno_id = ? AND m.status = 'ativa' ORDER BY m.data_inicio DESC LIMIT 1`,
      args: [aluno.id],
    });

    res.json({
      aluno_nome: aluno.nome,
      treino_modo: aluno.treino_modo || 'nativo',
      tem_rosto_cadastrado: Boolean(aluno.face_descriptor),
      plano_atual: matricula.rows[0] || null,
      primeiro_acesso: primeiroAcesso,
      senha_gerada: senhaGerada,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/treino?cpf=...&senha=... — só usada quando treino_modo =
// 'nativo' (o link do app externo já vem em GET /api/config, campo treino_app_url).
router.get('/treino', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().min(1) }).parse(req.query);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    const treinos = await db.execute({
      sql: `SELECT * FROM treinos WHERE aluno_id = ? AND ativo = 1 ORDER BY ordem, criado_em`,
      args: [aluno.id],
    });

    const resultado = [];
    for (const t of treinos.rows) {
      let dias = [];
      try { dias = t.dias_semana ? JSON.parse(t.dias_semana) : []; } catch { dias = []; }
      const exercicios = await db.execute({
        sql: `SELECT exercicio, series, carga, intervalo, observacao FROM treino_exercicios WHERE treino_id = ? ORDER BY ordem, criado_em`,
        args: [t.id],
      });
      resultado.push({ nome: t.nome, dias_semana: dias, exercicios: exercicios.rows });
    }
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// Limite dedicado e mais apertado pra /vincular/facial (além do limite geral
// do portal acima): é a rota mais sensível — quem souber o CPF de outra
// pessoa pode tentar vincular o PRÓPRIO rosto ao cadastro dela (ver análise de
// segurança, item 5). Não impede um ataque direcionado isolado, mas
// inviabiliza automação em massa contra vários CPFs.
const limitadorVincularFacial = criarLimitador({
  janelaMs: 60 * 60 * 1000,
  maximo: 5,
  mensagem: 'Muitas tentativas de cadastro facial para este CPF. Procure a recepção se o problema persistir.',
  chavePor: (req) => `${req.ip}:${req.body?.cpf || ''}`,
});

// POST /api/portal/vincular/facial { cpf, descriptor } — cadastra o rosto do
// aluno remotamente (com a câmera do próprio celular/PC), pra reconhecimento
// facial já funcionar na próxima vez que ele chegar ao totem físico.
//
// IMPORTANTE (ver análise de segurança, item 5): como a única prova de
// identidade aqui é o CPF, esta rota conseguia SOBRESCREVER um rosto já
// cadastrado sem confirmar que era a mesma pessoa — alguém que soubesse o CPF
// de um aluno podia vincular o próprio rosto ao cadastro dele. Decisão do
// dono do sistema (2026-07-07): bloquear por completo a sobrescrita remota.
// Se o aluno já tem um rosto cadastrado, esta rota recusa (409) — trocar o
// rosto cadastrado passa a exigir a recepção (painel -> perfil do aluno ->
// aba "Biometria & acesso" -> remover e recadastrar pela câmera do PC).
router.post('/vincular/facial', limitadorVincularFacial, async (req, res, next) => {
  try {
    const { cpf, senha, descriptor } = z.object({
      cpf: z.string().min(1),
      senha: z.string().min(1),
      descriptor: z.array(z.number()).min(16),
    }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    if (aluno.face_descriptor) {
      await acessoTerminal.registrarAcesso({
        alunoId: aluno.id,
        metodo: 'vincular_facial_portal',
        resultado: 'negado',
        mensagem: 'Tentativa de sobrescrever reconhecimento facial já cadastrado, pelo portal (CPF) — bloqueada.',
      });
      return res.status(409).json({
        erro: 'Este cadastro já tem um reconhecimento facial vinculado. Para trocar, procure a recepção.',
      });
    }

    await acessoTerminal.salvarFaceDescriptor(aluno.id, descriptor);
    await acessoTerminal.registrarAcesso({
      alunoId: aluno.id,
      metodo: 'vincular_facial_portal',
      resultado: 'liberado',
      mensagem: 'Primeiro cadastro de reconhecimento facial pelo portal (CPF).',
    });

    res.json({ ok: true, aluno_nome: aluno.nome });
  } catch (err) {
    next(err);
  }
});

// ---------------- Pagamento de contas em atraso (mesmo serviço do totem) ----------------
// Única diferença: liberarAcesso é SEMPRE false aqui — o valor vindo do corpo
// da requisição (se houver) é ignorado de propósito, por segurança.

router.post('/contas/consultar', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().min(1) }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });

    const resultado = await pagamentoContas.consultarContasAbertas(cpf);
    if (!resultado) return res.status(404).json({ erro: 'CPF não encontrado.' });
    res.json({ aluno_id: resultado.aluno.id, aluno_nome: resultado.aluno.nome, contas: resultado.contas });
  } catch (err) {
    next(err);
  }
});

router.post('/contas/pagar', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = z.object({
      cpf: z.string().min(1),
      senha: z.string().min(1),
      cobranca_ids: z.array(z.string()).min(1),
    }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });

    const resultado = await pagamentoContas.criarPagamentoAgregado({
      cpf: dados.cpf,
      cobrancaIds: dados.cobranca_ids,
      liberarAcesso: false, // portal remoto NUNCA aciona a catraca
    });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});

router.get('/contas/status/:pagamentoId', async (req, res, next) => {
  try {
    const resultado = await pagamentoContas.consultarStatusPagamento(req.params.pagamentoId);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ---------------- Cadastro novo (dados + plano -> Pix -> ativa matrícula) ----------------
// Mesmo fluxo do totem (ver terminal.routes.js /auto-cadastro), mas o status
// de confirmação aqui NUNCA chama acessoTerminal.tentarLiberar (sem catraca).

const cadastroSchema = z.object({
  nome: z.string().min(2),
  cpf: z.string().min(1),
  telefone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  data_nascimento: z.string().optional().nullable(),
  plano_id: z.string().min(1),
});

router.post('/cadastro', async (req, res, next) => {
  try {
    const dados = cadastroSchema.parse(req.body);

    const existente = await acessoTerminal.buscarAlunoPorCpf(dados.cpf);
    if (existente) {
      return res.status(409).json({ erro: 'Este CPF já tem cadastro. Use "Já sou aluno" para consultar suas contas e treino.' });
    }

    const plano = await db.execute({ sql: 'SELECT * FROM planos WHERE id = ? AND ativo = 1', args: [dados.plano_id] });
    const p = plano.rows[0];
    if (!p) return res.status(404).json({ erro: 'Plano não encontrado ou inativo.' });

    const cobrancaId = uuid();
    const descricao = `Matrícula - ${p.nome}`;

    const emailTeste = process.env.MERCADOPAGO_TEST_PAYER_EMAIL;
    const emailPagador = emailTeste || dados.email || `aluno-${dados.cpf.replace(/\D/g, '')}@academia-gestao.com`;
    const firstNamePagador = emailTeste ? 'APRO' : undefined;

    const order = await mercadopago.criarOrderPix({
      descricao,
      valorCentavos: p.valor_centavos,
      referenciaExterna: cobrancaId,
      email: emailPagador,
      firstName: firstNamePagador,
    });
    const metodoPix = order.transactions?.payments?.[0]?.payment_method || {};

    const alunoId = uuid();
    await db.execute({
      sql: `INSERT INTO alunos (id, nome, email, telefone, cpf, data_nascimento, status)
            VALUES (?, ?, ?, ?, ?, ?, 'ativo')`,
      args: [alunoId, dados.nome, dados.email || null, dados.telefone || null, dados.cpf, dados.data_nascimento || null],
    });

    const hoje = new Date().toISOString().slice(0, 10);
    const dataFim = p.duracao_dias ? new Date(Date.now() + p.duracao_dias * 86400000).toISOString().slice(0, 10) : null;

    const matriculaId = uuid();
    await db.execute({
      sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, data_fim, status, renovacao_automatica)
            VALUES (?, ?, ?, ?, ?, 'pendente', 1)`,
      args: [matriculaId, alunoId, p.id, hoje, dataFim],
    });

    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, provedor, provedor_referencia, descricao, vencimento)
            VALUES (?, ?, ?, ?, 'mercadopago', ?, ?, ?)`,
      args: [cobrancaId, alunoId, matriculaId, p.valor_centavos, String(order.id), descricao, hoje],
    });

    // Senha do portal (2026-07): já gera o código sequencial de uma vez
    // (mesmo padrão do "cartão" da catraca, ver acessoTerminal.service.js) e
    // marca como revelada — o aluno já sai do cadastro sabendo sua senha,
    // sem precisar de um "primeiro acesso" separado depois.
    const senhaAcesso = await acessoTerminal.atribuirCodigoAluno(alunoId);
    await db.execute({ sql: 'UPDATE alunos SET portal_senha_revelada = 1 WHERE id = ?', args: [alunoId] });

    res.status(201).json({
      cobranca_id: cobrancaId,
      qr_code_pix: metodoPix.qr_code || null,
      qr_code_pix_imagem: metodoPix.qr_code_base64 || null,
      valor_centavos: p.valor_centavos,
      aluno_nome: dados.nome,
      senha_acesso: senhaAcesso,
    });
  } catch (err) {
    next(err);
  }
});

// Ativa a matrícula ligada a uma cobrança quando o pagamento é confirmado —
// versão sem catraca, reaproveitada pelo /cadastro/status e pelo /upgrade/status.
async function confirmarPagamentoEAtivarMatricula(cobrancaId) {
  const cobrancaResult = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [cobrancaId] });
  let c = cobrancaResult.rows[0];
  if (!c) throw Object.assign(new Error('Cobrança não encontrada.'), { status: 404 });

  if (c.status !== 'pago' && c.provedor === 'mercadopago' && c.provedor_referencia) {
    try {
      const order = await mercadopago.consultarOrder(c.provedor_referencia);
      const pagamentoOrder = order.transactions?.payments?.[0] || {};
      const aprovado = order.status === 'processed' || pagamentoOrder.status === 'approved';
      if (aprovado) {
        await db.execute({
          sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = 'pix', pago_em = datetime('now') WHERE id = ?`,
          args: [c.id],
        });
        c = { ...c, status: 'pago' };
      }
    } catch (err) {
      // falha pontual na consulta — quem chamou tenta de novo no próximo poll
    }
  }

  if (c.status !== 'pago') return { pago: false };

  if (c.matricula_id) {
    await db.execute({ sql: `UPDATE matriculas SET status = 'ativa' WHERE id = ? AND status = 'pendente'`, args: [c.matricula_id] });
  }

  const alunoResult = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [c.aluno_id] });
  const aluno = alunoResult.rows[0];
  if (!aluno) throw Object.assign(new Error('Aluno não encontrado.'), { status: 404 });

  return { pago: true, aluno_nome: aluno.nome };
}

// GET /api/portal/cadastro/status/:cobrancaId — o portal faz polling aqui
// enquanto espera o Pix. Sem catraca: só confirma o pagamento e ativa a
// matrícula (a entrada física continua dependendo do totem/recepção).
router.get('/cadastro/status/:cobrancaId', async (req, res, next) => {
  try {
    const resultado = await confirmarPagamentoEAtivarMatricula(req.params.cobrancaId);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ---------------- Upgrade/troca de plano (aluno já cadastrado) ----------------
// "Assinar" um novo plano direto de casa: cria uma matrícula nova (pendente
// até o Pix confirmar) — não mexe na matrícula atual, então a equipe decide
// depois se cancela a antiga (evita encerrar um plano em dia sem querer).

router.post('/upgrade', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = z.object({
      cpf: z.string().min(1),
      senha: z.string().min(1),
      plano_id: z.string().min(1),
    }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    const plano = await db.execute({ sql: 'SELECT * FROM planos WHERE id = ? AND ativo = 1', args: [dados.plano_id] });
    const p = plano.rows[0];
    if (!p) return res.status(404).json({ erro: 'Plano não encontrado ou inativo.' });

    const existente = await db.execute({
      sql: `SELECT id FROM matriculas WHERE aluno_id = ? AND plano_id = ? AND status IN ('ativa', 'pendente')`,
      args: [aluno.id, dados.plano_id],
    });
    if (existente.rows[0]) {
      return res.status(409).json({ erro: 'Você já tem uma matrícula ativa ou pendente neste plano.' });
    }

    const cobrancaId = uuid();
    const descricao = `Matrícula - ${p.nome}`;

    const emailTeste = process.env.MERCADOPAGO_TEST_PAYER_EMAIL;
    const emailPagador = emailTeste || aluno.email || `aluno-${String(aluno.cpf).replace(/\D/g, '')}@academia-gestao.com`;
    const firstNamePagador = emailTeste ? 'APRO' : undefined;

    const order = await mercadopago.criarOrderPix({
      descricao,
      valorCentavos: p.valor_centavos,
      referenciaExterna: cobrancaId,
      email: emailPagador,
      firstName: firstNamePagador,
    });
    const metodoPix = order.transactions?.payments?.[0]?.payment_method || {};

    const hoje = new Date().toISOString().slice(0, 10);
    const dataFim = p.duracao_dias ? new Date(Date.now() + p.duracao_dias * 86400000).toISOString().slice(0, 10) : null;

    const matriculaId = uuid();
    await db.execute({
      sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, data_fim, status, renovacao_automatica)
            VALUES (?, ?, ?, ?, ?, 'pendente', 1)`,
      args: [matriculaId, aluno.id, p.id, hoje, dataFim],
    });

    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, provedor, provedor_referencia, descricao, vencimento)
            VALUES (?, ?, ?, ?, 'mercadopago', ?, ?, ?)`,
      args: [cobrancaId, aluno.id, matriculaId, p.valor_centavos, String(order.id), descricao, hoje],
    });

    res.status(201).json({
      cobranca_id: cobrancaId,
      qr_code_pix: metodoPix.qr_code || null,
      qr_code_pix_imagem: metodoPix.qr_code_base64 || null,
      valor_centavos: p.valor_centavos,
      aluno_nome: aluno.nome,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/upgrade/status/:cobrancaId', async (req, res, next) => {
  try {
    const resultado = await confirmarPagamentoEAtivarMatricula(req.params.cobrancaId);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
