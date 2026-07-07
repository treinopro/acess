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
// embutido no HTML/JS (qualquer um veria o código-fonte). A "prova de
// identidade" aqui é o próprio CPF, no mesmo espírito do totem físico (onde
// digitar o CPF já libera a consulta). Isso significa que quem souber o CPF
// de outra pessoa consegue ver as contas em aberto e o treino dela — uma
// limitação aceita conscientemente pelo escopo pedido; se precisar de mais
// privacidade no futuro, um segundo fator (ex: confirmação por WhatsApp/SMS)
// pode ser adicionado aqui sem mudar o resto do sistema.
// ---------------------------------------------------------------------------

const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const acessoTerminal = require('../services/acessoTerminal.service');
const pagamentoContas = require('../services/pagamentoContas.service');
const mercadopago = require('../services/payment/mercadopago.service');

const router = express.Router();

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

// GET /api/portal/aluno?cpf=... — tela "hub" depois de identificar o CPF:
// nome, modo de treino (pra decidir se mostra a lista nativa ou o link do
// app externo) e o plano atual (pra tela de upgrade saber o que já tem).
router.get('/aluno', async (req, res, next) => {
  try {
    const { cpf } = z.object({ cpf: z.string().min(1) }).parse(req.query);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado. Use "Quero me cadastrar" se ainda não tem cadastro.' });

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
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/treino?cpf=... — só usada quando treino_modo = 'nativo'
// (o link do app externo já vem em GET /api/config, campo treino_app_url).
router.get('/treino', async (req, res, next) => {
  try {
    const { cpf } = z.object({ cpf: z.string().min(1) }).parse(req.query);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado.' });

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

// POST /api/portal/vincular/facial { cpf, descriptor } — cadastra o rosto do
// aluno remotamente (com a câmera do próprio celular/PC), pra reconhecimento
// facial já funcionar na próxima vez que ele chegar ao totem físico.
router.post('/vincular/facial', async (req, res, next) => {
  try {
    const { cpf, descriptor } = z.object({ cpf: z.string().min(1), descriptor: z.array(z.number()).min(16) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado.' });
    await acessoTerminal.salvarFaceDescriptor(aluno.id, descriptor);
    res.json({ ok: true, aluno_nome: aluno.nome });
  } catch (err) {
    next(err);
  }
});

// ---------------- Pagamento de contas em atraso (mesmo serviço do totem) ----------------
// Única diferença: liberarAcesso é SEMPRE false aqui — o valor vindo do corpo
// da requisição (se houver) é ignorado de propósito, por segurança.

router.post('/contas/consultar', async (req, res, next) => {
  try {
    const { cpf } = z.object({ cpf: z.string().min(1) }).parse(req.body);
    const resultado = await pagamentoContas.consultarContasAbertas(cpf);
    if (!resultado) return res.status(404).json({ erro: 'CPF não encontrado.' });
    res.json({ aluno_id: resultado.aluno.id, aluno_nome: resultado.aluno.nome, contas: resultado.contas });
  } catch (err) {
    next(err);
  }
});

router.post('/contas/pagar', async (req, res, next) => {
  try {
    const dados = z.object({ cpf: z.string().min(1), cobranca_ids: z.array(z.string()).min(1) }).parse(req.body);
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

    res.status(201).json({
      cobranca_id: cobrancaId,
      qr_code_pix: metodoPix.qr_code || null,
      qr_code_pix_imagem: metodoPix.qr_code_base64 || null,
      valor_centavos: p.valor_centavos,
      aluno_nome: dados.nome,
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

router.post('/upgrade', async (req, res, next) => {
  try {
    const dados = z.object({ cpf: z.string().min(1), plano_id: z.string().min(1) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(dados.cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado.' });

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
