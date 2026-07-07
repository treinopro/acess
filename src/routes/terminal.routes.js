const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const { autenticar, apenasAdmin, autenticarTerminal } = require('../middleware/auth');
const catracaGateway = require('../services/catracaGateway.service');
const acessoTerminal = require('../services/acessoTerminal.service');
const mercadopago = require('../services/payment/mercadopago.service');
const infinitepay = require('../services/payment/infinitepay.service');
const db = require('../db/client');

const router = express.Router();

// ---------------------------------------------------------------------------
// Rota pública: página "meu acesso" (QR pessoal / cartão de embarque do aluno)
// Sem autenticação de propósito — a própria posse do código já é a prova de
// identidade (como um link de embarque). Só expõe o primeiro nome.
// ---------------------------------------------------------------------------
router.get('/meu-acesso/:codigo', async (req, res, next) => {
  try {
    const aluno = await acessoTerminal.buscarAlunoPorCodigoAcesso(req.params.codigo);
    if (!aluno) return res.status(404).json({ erro: 'Código de acesso inválido.' });
    const primeiroNome = (aluno.nome || '').split(' ')[0];
    res.json({ nome: primeiroNome, codigo_acesso: aluno.codigo_acesso });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Rotas do totem (autenticadas por segredo compartilhado TERMINAL_TOKEN, já
// que o aluno não tem login). Cobrem: identificação por CPF, por código/QR
// pessoal, por reconhecimento facial, e vinculação inicial de método de
// acesso para alunos que já existiam antes do totem.
// ---------------------------------------------------------------------------
const terminal = express.Router();
// autenticarTerminal é aplicado rota a rota (e não via terminal.use()) de
// propósito: um router.use() sem path intercepta QUALQUER requisição que
// passe por este sub-router antes mesmo dele tentar casar a rota — inclusive
// as que não têm handler aqui e deveriam "cair" para o router "admin" logo
// abaixo (ex.: /catraca/testar). Com o middleware por rota, uma requisição
// para um caminho que não existe neste router simplesmente não bate em nada
// aqui e segue adiante normalmente.

// POST /api/terminal/acesso/cpf { cpf }
terminal.post('/acesso/cpf', autenticarTerminal, async (req, res, next) => {
  try {
    const { cpf } = z.object({ cpf: z.string().min(1) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) {
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'cpf', resultado: 'negado', mensagem: 'CPF não encontrado.' });
      return res.json({ autorizado: false, motivo: 'CPF não encontrado.' });
    }
    const resultado = await acessoTerminal.tentarLiberar({ aluno, metodo: 'cpf' });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/acesso/codigo { codigo_acesso } — leitura do QR pessoal do celular
terminal.post('/acesso/codigo', autenticarTerminal, async (req, res, next) => {
  try {
    const { codigo_acesso } = z.object({ codigo_acesso: z.string().min(1) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorCodigoAcesso(codigo_acesso);
    if (!aluno) {
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'qrcode', resultado: 'negado', mensagem: 'Código de acesso inválido.' });
      return res.json({ autorizado: false, motivo: 'Código de acesso inválido.' });
    }
    const resultado = await acessoTerminal.tentarLiberar({ aluno, metodo: 'qrcode' });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/acesso/facial { descriptor: number[128] } — reconhecimento facial recorrente
terminal.post('/acesso/facial', autenticarTerminal, async (req, res, next) => {
  try {
    const { descriptor } = z.object({ descriptor: z.array(z.number()).min(16) }).parse(req.body);
    const match = await acessoTerminal.encontrarMelhorMatchFacial(descriptor);

    if (!match.aluno) {
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'facial', resultado: 'negado', mensagem: 'Nenhum aluno com rosto cadastrado.' });
      return res.json({ autorizado: false, motivo: 'Nenhum aluno com rosto cadastrado no sistema ainda.' });
    }

    if (!match.dentroDoLimite) {
      // Diagnóstico temporário durante os testes: mostra a distância e o
      // candidato mais próximo, mesmo tendo sido recusado, para ajudar a
      // calibrar FACE_MATCH_THRESHOLD no .env. Considere remover/ocultar
      // esse nível de detalhe quando for para produção.
      const motivo = `Rosto não reconhecido (mais próximo: distância ${match.distancia.toFixed(3)}, limite ${match.limite}).`;
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'facial', resultado: 'negado', mensagem: motivo });
      return res.json({ autorizado: false, motivo, distancia: match.distancia, limite: match.limite });
    }

    const resultado = await acessoTerminal.tentarLiberar({ aluno: match.aluno, metodo: 'facial' });
    res.json({ ...resultado, distancia: match.distancia });
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/validar-biometria-catraca { biometria_id }
// Usada pelo agente local quando a PRÓPRIA catraca lê a digital (evento via
// escutar()). Aqui só validamos e devolvemos autorizado/negado — quem manda
// permitir_entrada/impedir_entrada de volta pra catraca é o agente, pois é
// ele quem tem o "index" da mensagem original.
terminal.post('/validar-biometria-catraca', autenticarTerminal, async (req, res, next) => {
  try {
    const { biometria_id } = z.object({ biometria_id: z.string().min(1) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorBiometriaId(biometria_id);
    if (!aluno) {
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'biometria_catraca', resultado: 'negado', mensagem: 'Biometria não vinculada a nenhum aluno.' });
      return res.json({ autorizado: false, motivo: 'Biometria não vinculada a nenhum aluno.' });
    }
    const { autorizado, motivo } = await acessoTerminal.verificarAutorizacaoAluno(aluno);
    await acessoTerminal.registrarAcesso({
      alunoId: aluno.id,
      metodo: 'biometria_catraca',
      resultado: autorizado ? 'liberado' : 'negado',
      mensagem: motivo,
    });
    res.json({ autorizado, motivo, aluno_nome: aluno.nome });
  } catch (err) {
    next(err);
  }
});

// ---- Vinculação de método de acesso para alunos já cadastrados ----

// GET /api/terminal/vincular/codigo?cpf=... — gera (ou recupera) o código de
// acesso estável do aluno, para gerar o QR/link "meu acesso" pessoal dele.
terminal.get('/vincular/codigo', autenticarTerminal, async (req, res, next) => {
  try {
    const { cpf } = z.object({ cpf: z.string().min(1) }).parse(req.query);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado.' });
    const codigo = await acessoTerminal.garantirCodigoAcesso(aluno.id);
    res.json({ aluno_nome: aluno.nome, codigo_acesso: codigo });
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/vincular/facial { cpf, descriptor } — cadastra o rosto do
// aluno para reconhecimento facial recorrente (autoatendimento no totem).
terminal.post('/vincular/facial', autenticarTerminal, async (req, res, next) => {
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

// ---------------------------------------------------------------------------
// Auto cadastro + pagamento (alunos novos, sem passar pela recepção). O aluno
// preenche os dados no totem, escolhe um plano, e recebe um QR de pagamento
// (link do gateway) para escanear com o próprio celular. A matrícula nasce com
// status 'pendente' (não conta como ativa em verificarAutorizacaoAluno) e só
// vira 'ativa' — liberando a entrada — quando o pagamento é confirmado, via
// polling em /auto-cadastro/status/:cobrancaId. Sem isso, um cadastro sem
// pagamento nunca abriria a catraca, mesmo com status do aluno = 'ativo'.
// ---------------------------------------------------------------------------

const autoCadastroSchema = z.object({
  nome: z.string().min(2),
  cpf: z.string().min(1),
  telefone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  data_nascimento: z.string().optional().nullable(),
  plano_id: z.string().min(1),
});

// GET /api/terminal/planos — planos ativos, para o totem montar o seletor de plano
terminal.get('/planos', autenticarTerminal, async (req, res, next) => {
  try {
    const result = await db.execute(
      'SELECT id, nome, tipo, valor_centavos, duracao_dias FROM planos WHERE ativo = 1 ORDER BY valor_centavos',
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/auto-cadastro { nome, cpf, telefone?, email?, data_nascimento?, plano_id }
terminal.post('/auto-cadastro', autenticarTerminal, async (req, res, next) => {
  try {
    const dados = autoCadastroSchema.parse(req.body);

    const existente = await acessoTerminal.buscarAlunoPorCpf(dados.cpf);
    if (existente) {
      return res.status(409).json({
        erro: 'Este CPF já tem cadastro. Use "Primeira vez no totem" para vincular seu acesso, ou procure a recepção.',
      });
    }

    const plano = await db.execute({ sql: 'SELECT * FROM planos WHERE id = ? AND ativo = 1', args: [dados.plano_id] });
    const p = plano.rows[0];
    if (!p) return res.status(404).json({ erro: 'Plano não encontrado ou inativo.' });

    const cobrancaId = uuid();
    const descricao = `Matrícula - ${p.nome}`;
    const provedor = process.env.PAYMENT_PROVIDER || 'mercadopago';

    // Gera o pagamento ANTES de escrever qualquer coisa no banco — se o
    // gateway falhar, a requisição falha inteira e nenhum registro órfão fica
    // para trás (mesmo padrão usado em POST /api/pagamentos/cobrar).
    let linkPagamento = null;
    let qrCodePix = null; // copia-e-cola (texto)
    let qrCodePixImagem = null; // base64 (imagem pronta do Mercado Pago)
    // provedorReferencia: no Mercado Pago guardamos o ID do pagamento (não o
    // cobrancaId) para poder consultar o status diretamente na API como
    // reforço ao webhook — webhook sozinho depende de estar bem configurado
    // no painel do Mercado Pago e de o servidor estar publicamente acessível,
    // então o polling do totem confere os dois.
    let provedorReferencia = cobrancaId;
    if (provedor === 'mercadopago') {
      // Pix direto via API de Orders (Checkout Transparente) — sem
      // redirecionar pra nenhuma tela externa, o QR já sai pronto pra
      // mostrar no totem. A API exige um e-mail do pagador; como o totem não
      // pede e-mail, usamos um sintético baseado no CPF quando o aluno não
      // informou um de verdade.
      //
      // A API de Orders SEMPRE exige o Access Token de PRODUÇÃO
      // ("APP_USR-..."), mesmo pra simular — ela não aceita token "TEST-...".
      // O "modo teste" é ativado pelo PAGADOR: se MERCADOPAGO_TEST_PAYER_EMAIL
      // estiver configurado, usamos esse e-mail de teste + o valor mágico
      // "APRO" em first_name, que faz o Mercado Pago simular a aprovação
      // automaticamente, sem mexer em dinheiro de verdade. Remova essa
      // variável (ou apague-a) quando o totem for pra produção de verdade, e
      // o pagamento passa a valer o dinheiro real dos alunos.
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
      qrCodePix = metodoPix.qr_code || null;
      qrCodePixImagem = metodoPix.qr_code_base64 || null;
      provedorReferencia = String(order.id);
    } else {
      // Repassa os dados que o aluno já digitou no totem (nome/telefone/email)
      // para o checkout da InfinitePay pré-preencher esses campos e pular essa
      // etapa manual na tela de pagamento.
      const customer = {
        name: dados.nome,
        ...(dados.email ? { email: dados.email } : {}),
        ...(dados.telefone ? { phone_number: dados.telefone } : {}),
      };
      const link = await infinitepay.criarLinkPagamento({
        descricao,
        valorCentavos: p.valor_centavos,
        orderNsu: cobrancaId,
        redirectUrl: process.env.APP_URL || 'http://localhost:3000',
        customer,
      });
      linkPagamento = link.url || link.checkout_url;
    }

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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [cobrancaId, alunoId, matriculaId, p.valor_centavos, provedor, provedorReferencia, descricao, hoje],
    });

    res.status(201).json({
      cobranca_id: cobrancaId,
      link_pagamento: linkPagamento,
      qr_code_pix: qrCodePix,
      qr_code_pix_imagem: qrCodePixImagem,
      valor_centavos: p.valor_centavos,
      aluno_nome: dados.nome,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/auto-cadastro/status/:cobrancaId — o totem faz polling
// aqui enquanto espera o pagamento. Quando a cobrança está paga, ativa a
// matrícula (só na primeira vez — updates seguintes do WHERE status='pendente'
// não afetam nada, evitando reabrir a catraca a cada poll) e libera o acesso.
terminal.get('/auto-cadastro/status/:cobrancaId', autenticarTerminal, async (req, res, next) => {
  try {
    const cobranca = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [req.params.cobrancaId] });
    let c = cobranca.rows[0];
    if (!c) return res.status(404).json({ erro: 'Cobrança não encontrada.' });

    // Reforço ao webhook: se ainda não chegou confirmação (webhook não
    // configurado no painel do Mercado Pago, atraso de entrega, etc.),
    // consulta o status direto na API a cada poll do totem. Assim o totem
    // não depende só do webhook pra saber que o Pix foi pago.
    if (c.status !== 'pago' && c.provedor === 'mercadopago' && c.provedor_referencia) {
      try {
        const order = await mercadopago.consultarOrder(c.provedor_referencia);
        const pagamentoOrder = order.transactions?.payments?.[0] || {};
        const aprovado = order.status === 'processed' || pagamentoOrder.status === 'approved';
        if (aprovado) {
          await db.execute({
            sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = ?, pago_em = datetime('now') WHERE id = ?`,
            args: ['pix', c.id],
          });
          c = { ...c, status: 'pago' };
        }
      } catch (err) {
        // Não interrompe o polling por causa de uma falha pontual na consulta
        // — o totem simplesmente tenta de novo no próximo tick.
      }
    }

    if (c.status !== 'pago') {
      return res.json({ pago: false });
    }

    let jaAtivadaAntes = false;
    if (c.matricula_id) {
      const upd = await db.execute({
        sql: `UPDATE matriculas SET status = 'ativa' WHERE id = ? AND status = 'pendente'`,
        args: [c.matricula_id],
      });
      jaAtivadaAntes = upd.rowsAffected === 0;
    }

    const alunoResult = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [c.aluno_id] });
    const aluno = alunoResult.rows[0];
    if (!aluno) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    const codigoAcesso = await acessoTerminal.garantirCodigoAcesso(aluno.id);

    if (jaAtivadaAntes) {
      return res.json({ pago: true, autorizado: true, motivo: null, aluno_nome: aluno.nome, cpf: aluno.cpf, codigo_acesso: codigoAcesso });
    }

    const resultado = await acessoTerminal.tentarLiberar({ aluno, metodo: 'cadastro' });
    res.json({ pago: true, ...resultado, cpf: aluno.cpf, codigo_acesso: codigoAcesso });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Pagamento de contas em atraso pelo totem (consulta por CPF). Diferente do
// auto-cadastro (uma cobrança = um pagamento), aqui o aluno pode ter VÁRIAS
// contas vencidas e pagar tudo de uma vez com um único Pix — por isso o
// "pagamento agregado" fica registrado em pagamentos_totem (cobranca_ids como
// array JSON) em vez de usar cobrancas.provedor_referencia diretamente.
//
// liberar_acesso: true no totem físico da academia (some com a cobrança E
// libera a catraca, já que essa é a mesma dose de responsabilidade de estar
// fisicamente na academia). Um futuro portal remoto (fora da academia, sem
// controle de quem está com o celular) deve chamar com liberar_acesso=false —
// só quita a conta, nunca aciona a catraca remotamente.
// ---------------------------------------------------------------------------

// POST /api/terminal/contas/consultar { cpf } — lista as contas em aberto
// (pendente/atrasado) do aluno, pra montar a tela de seleção no totem.
terminal.post('/contas/consultar', autenticarTerminal, async (req, res, next) => {
  try {
    const { cpf } = z.object({ cpf: z.string().min(1) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado.' });

    const result = await db.execute({
      sql: `SELECT id, descricao, valor_centavos, vencimento, status FROM cobrancas
            WHERE aluno_id = ? AND status IN ('pendente', 'atrasado')
            ORDER BY vencimento ASC`,
      args: [aluno.id],
    });

    res.json({ aluno_id: aluno.id, aluno_nome: aluno.nome, contas: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/contas/pagar { cpf, cobranca_ids: [...], liberar_acesso? }
// Gera UM pagamento Pix agregado cobrindo todas as cobrancas selecionadas.
terminal.post('/contas/pagar', autenticarTerminal, async (req, res, next) => {
  try {
    const schema = z.object({
      cpf: z.string().min(1),
      cobranca_ids: z.array(z.string()).min(1),
      liberar_acesso: z.boolean().optional(),
    });
    const dados = schema.parse(req.body);

    const aluno = await acessoTerminal.buscarAlunoPorCpf(dados.cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado.' });

    const placeholders = dados.cobranca_ids.map(() => '?').join(', ');
    const contas = await db.execute({
      sql: `SELECT * FROM cobrancas WHERE aluno_id = ? AND id IN (${placeholders}) AND status IN ('pendente', 'atrasado')`,
      args: [aluno.id, ...dados.cobranca_ids],
    });
    if (contas.rows.length === 0) {
      return res.status(404).json({ erro: 'Nenhuma das contas informadas está em aberto para este CPF.' });
    }
    if (contas.rows.length !== dados.cobranca_ids.length) {
      return res.status(409).json({ erro: 'Uma ou mais contas selecionadas já não estão mais em aberto. Atualize a lista e tente de novo.' });
    }

    const valorTotalCentavos = contas.rows.reduce((soma, c) => soma + Number(c.valor_centavos), 0);
    const pagamentoId = uuid();
    const descricao = contas.rows.length === 1
      ? contas.rows[0].descricao || 'Conta em atraso'
      : `${contas.rows.length} contas em atraso`;

    const emailTeste = process.env.MERCADOPAGO_TEST_PAYER_EMAIL;
    const emailPagador = emailTeste || aluno.email || `aluno-${String(aluno.cpf).replace(/\D/g, '')}@academia-gestao.com`;
    const firstNamePagador = emailTeste ? 'APRO' : undefined;

    const order = await mercadopago.criarOrderPix({
      descricao,
      valorCentavos: valorTotalCentavos,
      referenciaExterna: pagamentoId,
      email: emailPagador,
      firstName: firstNamePagador,
    });
    const metodoPix = order.transactions?.payments?.[0]?.payment_method || {};

    await db.execute({
      sql: `INSERT INTO pagamentos_totem (id, aluno_id, cobranca_ids, valor_centavos, provedor, provedor_referencia, liberar_acesso)
            VALUES (?, ?, ?, ?, 'mercadopago', ?, ?)`,
      args: [pagamentoId, aluno.id, JSON.stringify(dados.cobranca_ids), valorTotalCentavos, String(order.id), dados.liberar_acesso === false ? 0 : 1],
    });

    res.status(201).json({
      pagamento_id: pagamentoId,
      qr_code_pix: metodoPix.qr_code || null,
      qr_code_pix_imagem: metodoPix.qr_code_base64 || null,
      valor_centavos: valorTotalCentavos,
      aluno_nome: aluno.nome,
      contas: contas.rows.map((c) => ({ id: c.id, descricao: c.descricao, valor_centavos: c.valor_centavos, vencimento: c.vencimento })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/contas/status/:pagamentoId — polling do totem enquanto
// aguarda o Pix. Quando confirmado, quita todas as cobrancas cobertas (com
// registro em pagamentos_cobranca, pro histórico/relatórios ficarem
// consistentes com um pagamento lançado manualmente) e, se liberar_acesso
// estiver ligado, tenta liberar a catraca também.
terminal.get('/contas/status/:pagamentoId', autenticarTerminal, async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM pagamentos_totem WHERE id = ?', args: [req.params.pagamentoId] });
    let p = result.rows[0];
    if (!p) return res.status(404).json({ erro: 'Pagamento não encontrado.' });

    if (p.status !== 'pago') {
      try {
        const order = await mercadopago.consultarOrder(p.provedor_referencia);
        const pagamentoOrder = order.transactions?.payments?.[0] || {};
        const aprovado = order.status === 'processed' || pagamentoOrder.status === 'approved';
        if (aprovado) {
          await db.execute({ sql: `UPDATE pagamentos_totem SET status = 'pago' WHERE id = ?`, args: [p.id] });
          p = { ...p, status: 'pago' };
        }
      } catch (err) {
        // Falha pontual na consulta não interrompe o polling — o totem tenta de novo.
      }
    }

    if (p.status !== 'pago') return res.json({ pago: false });

    const cobrancaIds = JSON.parse(p.cobranca_ids);
    const hoje = new Date().toISOString().slice(0, 10);

    // Idempotente: só lança pagamentos_cobranca pra quem ainda estiver em
    // aberto — se o totem repetir o poll depois de já ter quitado (corrida
    // entre webhook e polling), não duplica o lançamento.
    const itens = [];
    for (const cobrancaId of cobrancaIds) {
      const cobrancaResult = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [cobrancaId] });
      const cobranca = cobrancaResult.rows[0];
      if (!cobranca) continue;
      itens.push({ id: cobranca.id, descricao: cobranca.descricao, valor_centavos: cobranca.valor_centavos });
      if (cobranca.status === 'pago') continue;

      await db.execute({
        sql: `INSERT INTO pagamentos_cobranca (id, cobranca_id, data, valor_centavos, tipo, conta_corrente)
              VALUES (?, ?, ?, ?, 'pix', NULL)`,
        args: [uuid(), cobranca.id, hoje, cobranca.valor_centavos],
      });
      await db.execute({
        sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = 'pix', pago_em = datetime('now') WHERE id = ?`,
        args: [cobranca.id],
      });
    }

    const alunoResult = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [p.aluno_id] });
    const aluno = alunoResult.rows[0];
    if (!aluno) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    let autorizado = null;
    let motivo = null;
    if (p.liberar_acesso) {
      const resultadoLiberacao = await acessoTerminal.tentarLiberar({ aluno, metodo: 'pagamento_contas' });
      autorizado = resultadoLiberacao.autorizado;
      motivo = resultadoLiberacao.motivo;
    }

    res.json({
      pago: true,
      autorizado,
      motivo,
      aluno_nome: aluno.nome,
      valor_centavos: p.valor_centavos,
      itens,
      pago_em: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.use(terminal);

// ---------------------------------------------------------------------------
// Rotas administrativas (login de staff) — testes de campo da integração TCP
// com a catraca, sem passar pelo fluxo de identificação do aluno.
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use(autenticar, apenasAdmin);

function configCatraca(body = {}) {
  const ip = body.ip || process.env.HENRY_CATRACA_IP;
  const port = Number(body.port || process.env.HENRY_CATRACA_PORT || 3000);
  if (!ip) throw Object.assign(new Error('IP da catraca não configurado (HENRY_CATRACA_IP no .env ou "ip" no body).'), { status: 400 });
  return { ip, port };
}

// ---------------------------------------------------------------------------
// "Liberação de pânico": mantém a catraca liberada continuamente, chamando
// liberarAcesso em loop (o protocolo Henry só libera por tempo fixo por
// comando — RELEASE_TIME em henryCatraca.service.js — não existe um comando
// nativo de "travar aberto"). ATENÇÃO: isso é um mecanismo por software, que
// depende do servidor e da rede estarem no ar; não é um substituto de uma
// trava mecânica de emergência exigida por norma de segurança contra
// incêndio/saída de emergência. Use com essa ressalva em mente.
// ---------------------------------------------------------------------------
let panicoInterval = null;
let panicoConfig = null;

const PANICO_INTERVALO_MS = 3000; // menor que os 4s de liberação por comando, pra não deixar brecha

// POST /api/terminal/catraca/panico/ativar { ip?, port? }
admin.post('/catraca/panico/ativar', async (req, res, next) => {
  try {
    const { ip, port } = configCatraca(req.body || {});
    if (panicoInterval) return res.json({ ok: true, ativo: true, ja_estava_ativo: true });

    panicoConfig = { ip, port };
    await catracaGateway.liberarAcesso({ ip, port, mensagem: 'PANICO - LIBERACAO DE EMERGENCIA' });
    panicoInterval = setInterval(() => {
      catracaGateway.liberarAcesso({ ip, port, mensagem: 'PANICO - LIBERACAO DE EMERGENCIA' }).catch(() => {});
    }, PANICO_INTERVALO_MS);

    await acessoTerminal.registrarAcesso({
      alunoId: null, metodo: 'admin_panico', resultado: 'liberado',
      mensagem: `Liberação de pânico ATIVADA por ${req.usuario?.email || 'admin'}`,
    });

    res.json({ ok: true, ativo: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/catraca/panico/cancelar
admin.post('/catraca/panico/cancelar', async (req, res, next) => {
  try {
    if (panicoInterval) {
      clearInterval(panicoInterval);
      panicoInterval = null;
      await acessoTerminal.registrarAcesso({
        alunoId: null, metodo: 'admin_panico', resultado: 'liberado',
        mensagem: `Liberação de pânico CANCELADA por ${req.usuario?.email || 'admin'}`,
      });
    }
    panicoConfig = null;
    res.json({ ok: true, ativo: false });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/catraca/panico/status
admin.get('/catraca/panico/status', (req, res) => {
  res.json({ ativo: Boolean(panicoInterval), config: panicoConfig });
});

// POST /api/terminal/catraca/liberar-aluno { aluno_id, ip?, port?, mensagem? }
// Libera a catraca manualmente indicando o aluno — diferente de /catraca/liberar
// (teste de campo anônimo), este fica registrado em acessos_catraca com o
// aluno_id, então aparece no histórico e no painel de "Acessos recentes".
admin.post('/catraca/liberar-aluno', async (req, res, next) => {
  try {
    const schema = z.object({
      aluno_id: z.string(),
      ip: z.string().optional(),
      port: z.number().optional(),
      mensagem: z.string().optional(),
    });
    const body = schema.parse(req.body || {});
    const { ip, port } = configCatraca(body);

    const alunoResult = await db.execute({ sql: 'SELECT id, nome FROM alunos WHERE id = ?', args: [body.aluno_id] });
    const aluno = alunoResult.rows[0];
    if (!aluno) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    await catracaGateway.liberarAcesso({ ip, port, mensagem: body.mensagem || `Liberação manual - ${aluno.nome}` });
    await acessoTerminal.registrarAcesso({
      alunoId: aluno.id, metodo: 'admin', resultado: 'liberado',
      mensagem: `Liberação manual pelo painel (${req.usuario?.email || 'admin'})`,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/catraca/testar?ip=...&port=... — testa conectividade (TCP
// direto ou, se houver agente local conectado, TCP feito por ele)
admin.get('/catraca/testar', async (req, res, next) => {
  try {
    const { ip, port } = configCatraca(req.query);
    const resultado = await catracaGateway.testarConexao({ ip, port });
    res.json({ ip, port, ...resultado });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/catraca/agente/status — se há um agente local conectado
// agora (usado pelo painel pra indicar "agente conectado" vs "modo direto")
admin.get('/catraca/agente/status', (req, res) => {
  res.json(catracaGateway.statusAgente());
});

// POST /api/terminal/catraca/liberar { ip?, port?, mensagem? } — dispara abertura manual (teste de campo)
admin.post('/catraca/liberar', async (req, res, next) => {
  try {
    const schema = z.object({ ip: z.string().optional(), port: z.number().optional(), mensagem: z.string().optional() });
    const body = schema.parse(req.body || {});
    const { ip, port } = configCatraca(body);
    await catracaGateway.liberarAcesso({ ip, port, mensagem: body.mensagem });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/acessos?aluno_id=&data=&data_inicio=&data_fim=&busca= — histórico de
// tentativas de acesso pelo totem/catraca. Usado pelo painel "Acessos recentes", pela janela
// da catraca e pelos relatórios "Acesso Diário" (usa "data") e "Acesso Pessoal" (usa
// "aluno_id" + "data_inicio"/"data_fim").
admin.get('/acessos', async (req, res, next) => {
  try {
    const {
      aluno_id: alunoId, data, data_inicio: dataInicio, data_fim: dataFim, busca,
    } = req.query;
    const condicoes = [];
    const args = [];
    if (alunoId) { condicoes.push('ac.aluno_id = ?'); args.push(alunoId); }
    if (data) { condicoes.push("date(ac.criado_em) = ?"); args.push(data); }
    if (dataInicio) { condicoes.push('date(ac.criado_em) >= ?'); args.push(dataInicio); }
    if (dataFim) { condicoes.push('date(ac.criado_em) <= ?'); args.push(dataFim); }
    if (busca) { condicoes.push('a.nome LIKE ?'); args.push(`%${busca}%`); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const result = await db.execute({
      sql: `SELECT ac.*, a.nome as aluno_nome FROM acessos_catraca ac LEFT JOIN alunos a ON a.id = ac.aluno_id
            ${where} ORDER BY ac.criado_em DESC LIMIT 500`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/acessos/ultimo-por-aluno?data_inicio=&data_fim=&busca=&incluir_inativos=
// relatório "Último Acesso": um registro por aluno, com a data/hora do acesso mais recente
// (que tenha sido efetivamente liberado). O período, quando informado, restringe quais acessos
// contam pra esse "mais recente" — útil pra achar quem não vem há tempos. Por padrão só traz
// alunos com status='ativo'; passe incluir_inativos=true (checkbox "mostrar inativos") pra
// incluir todo mundo.
admin.get('/acessos/ultimo-por-aluno', async (req, res, next) => {
  try {
    const {
      data_inicio: dataInicio, data_fim: dataFim, busca, incluir_inativos: incluirInativos,
    } = req.query;
    const condicoes = ["ac.resultado = 'liberado'"];
    const args = [];
    if (!(incluirInativos === 'true' || incluirInativos === '1')) { condicoes.push("a.status = 'ativo'"); }
    if (dataInicio) { condicoes.push('date(ac.criado_em) >= ?'); args.push(dataInicio); }
    if (dataFim) { condicoes.push('date(ac.criado_em) <= ?'); args.push(dataFim); }
    if (busca) { condicoes.push('a.nome LIKE ?'); args.push(`%${busca}%`); }
    const where = `WHERE ${condicoes.join(' AND ')}`;

    const result = await db.execute({
      sql: `SELECT a.id as aluno_id, a.nome as aluno_nome, MAX(ac.criado_em) as ultimo_acesso
            FROM acessos_catraca ac
            JOIN alunos a ON a.id = ac.aluno_id
            ${where}
            GROUP BY a.id, a.nome
            ORDER BY ultimo_acesso DESC`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.use(admin);

module.exports = router;
