// Assinaturas do Mercado Pago: cobrança recorrente no cartão com baixa automática.
//
// Recurso OPCIONAL e desligado por padrão (MERCADOPAGO_ASSINATURAS=1 liga). Não
// substitui o fluxo atual — "Gerar Contas a Receber" continua sendo quem cria as
// cobranças de cada ciclo (decisão do dono: geração de cobrança é ação
// financeira manual). Aqui o MP só COBRA o cartão do aluno a cada ciclo e, quando
// a parcela é aprovada, damos baixa na conta em aberto mais antiga da matrícula.
//
// Fluxo:
//   1. admin (ou o próprio aluno, no portal) gera a assinatura → link da página de
//      oferta (/assinar/:id), que leva ao cadastro do cartão no Mercado Pago;
//   2. MP cobra a cada ciclo e avisa por webhook (subscription_authorized_payment,
//      subscription_preapproval e payment) → processarEvento() dá baixa.
//
// Desconto para quem assina (configurável na tela Configurações > Pagamento
// automático): é TRAVADO na criação da assinatura — o valor cobrado pelo MP já é o
// com desconto — e, na baixa, segue a convenção do sistema para descontos: o valor
// da conta é reduzido pelo desconto e o pagamento é registrado pelo valor real.
//
// Idempotência: o MP reenvia webhook; cada parcela (payment_id) só baixa uma vez
// (tabela assinaturas_mp_pagamentos).

const { v4: uuid } = require('uuid');
const db = require('../db/client');
const mercadopago = require('./payment/mercadopago.service');
const { MESES_POR_TIPO, TIPOS_RECORRENTES, primeiroVencimento } = require('./cobrancas.service');

const VALOR_MINIMO_CENTAVOS = 100; // nunca cobra menos de R$ 1,00 por ciclo (desconto absurdo = erro de digitação)

function habilitado() {
  return process.env.MERCADOPAGO_ASSINATURAS === '1';
}

function erro(mensagem, status) {
  return Object.assign(new Error(mensagem), { status });
}

// ── Endereços, telefone, nome ───────────────────────────────────────────────

// Endereço público do sistema (para montar o link da página de oferta). Prefere
// PUBLIC_BASE_URL (recomendado: o painel pode rodar em localhost apontando pro
// banco de produção — sem a variável o link sairia como http://localhost). Sem ela,
// usa o host da própria requisição (respeitando o proxy da hospedagem).
function baseUrlDaRequisicao(req) {
  const env = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (env) return env;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function urlOferta(baseUrl, assinaturaId) {
  return `${baseUrl}/assinar/${assinaturaId}`;
}

// O MP exige back_url https; fora disso (ex.: teste em localhost) cai no site do MP.
function urlRetorno(baseUrl, assinaturaId) {
  return /^https:\/\//i.test(baseUrl || '') ? `${urlOferta(baseUrl, assinaturaId)}?retorno=1` : 'https://www.mercadopago.com.br';
}

function normalizarTelefone(telefone) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (!digitos) return null;
  return digitos.length >= 12 ? digitos : `55${digitos}`;
}

function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

// ── Configuração da oferta (textos, argumentos, desconto) ───────────────────
// Guardada como JSON na chave `assinatura_oferta` de `configuracoes` e editada em
// Configurações > Pagamento automático. Só afirmam o que o sistema realmente faz —
// o dono pode trocar os textos, então a responsabilidade pelo que promete é dele.
const OFERTA_PADRAO = {
  selo: '⚡ Oferta para alunos',
  // *palavra* vira destaque verde; {nome} vira o primeiro nome do aluno.
  titulo: 'Deixe sua mensalidade no *automático*, {nome}!',
  subtitulo: 'Treine sem pensar em vencimento: a cobrança é feita sozinha no seu cartão, todo ciclo.',
  beneficios: [
    'Pagamento automático: nunca mais esquece o vencimento',
    'Sem fila no totem e sem Pix pra copiar todo mês',
    'Acesso sempre em dia, sem susto na catraca',
    'Cartão cadastrado direto no Mercado Pago — a academia não vê nem guarda seus dados',
    'Cancele quando quiser: é só avisar a recepção',
  ],
  botao: 'Ativar pagamento automático →',
  microtexto: '🔒 Pagamento seguro pelo Mercado Pago · leva cerca de 1 minuto',
  faq: [
    { p: 'Posso cancelar?', r: 'Sim. Basta avisar a recepção que a assinatura é cancelada.' },
    { p: 'A academia guarda os dados do meu cartão?', r: 'Não. O cartão é cadastrado direto no Mercado Pago; a academia só recebe a confirmação do pagamento.' },
    { p: 'E se meu cartão for recusado?', r: 'O Mercado Pago tenta cobrar novamente de forma automática por alguns dias antes de desistir.' },
  ],
  // Desconto por ciclo para quem opta pela assinatura. Vale enquanto a assinatura
  // estiver ativa (o valor é travado quando o aluno assina).
  desconto: { ativo: false, tipo: 'percentual', percentual: 0, valor_centavos: 0 },
};

const LIMITES = { texto: 160, subtitulo: 300, beneficio: 160, resposta: 400, beneficios: 8, faq: 6 };

function textoLimpo(v, padrao, max) {
  const t = typeof v === 'string' ? v.trim() : '';
  return (t || padrao).slice(0, max);
}

// Valida e normaliza (usado ao ler do banco e ao salvar). Nunca lança: entrada
// inválida cai no padrão — a página pública não pode quebrar por um JSON ruim.
function normalizarOferta(bruto, legadoBeneficios) {
  const b = bruto && typeof bruto === 'object' ? bruto : {};
  const beneficios = (Array.isArray(b.beneficios) ? b.beneficios : legadoBeneficios || [])
    .map((x) => String(x || '').trim().slice(0, LIMITES.beneficio)).filter(Boolean).slice(0, LIMITES.beneficios);
  const faq = (Array.isArray(b.faq) ? b.faq : OFERTA_PADRAO.faq)
    .map((x) => ({ p: String(x?.p || '').trim().slice(0, LIMITES.texto), r: String(x?.r || '').trim().slice(0, LIMITES.resposta) }))
    .filter((x) => x.p && x.r).slice(0, LIMITES.faq);
  const d = b.desconto && typeof b.desconto === 'object' ? b.desconto : {};
  const tipo = d.tipo === 'valor' ? 'valor' : 'percentual';
  const percentual = Math.min(Math.max(Number(d.percentual) || 0, 0), 90);
  const valorCentavos = Math.max(Math.round(Number(d.valor_centavos) || 0), 0);
  return {
    selo: textoLimpo(b.selo, OFERTA_PADRAO.selo, 60),
    titulo: textoLimpo(b.titulo, OFERTA_PADRAO.titulo, LIMITES.texto),
    subtitulo: textoLimpo(b.subtitulo, OFERTA_PADRAO.subtitulo, LIMITES.subtitulo),
    beneficios: beneficios.length ? beneficios : OFERTA_PADRAO.beneficios,
    botao: textoLimpo(b.botao, OFERTA_PADRAO.botao, 60),
    microtexto: textoLimpo(b.microtexto, OFERTA_PADRAO.microtexto, 120),
    faq: faq.length || Array.isArray(b.faq) ? faq : OFERTA_PADRAO.faq,
    desconto: {
      ativo: d.ativo === true && (tipo === 'percentual' ? percentual > 0 : valorCentavos > 0),
      tipo, percentual, valor_centavos: valorCentavos,
    },
  };
}

async function lerConfig(chaves) {
  const out = {};
  try {
    const r = await db.execute({
      sql: `SELECT chave, valor FROM configuracoes WHERE chave IN (${chaves.map(() => '?').join(', ')})`,
      args: chaves,
    });
    for (const row of r.rows) out[row.chave] = row.valor;
  } catch (e) { /* tabela/chave ausente: usa padrões */ }
  return out;
}

async function obterOferta() {
  const cfg = await lerConfig(['assinatura_oferta', 'assinatura_beneficios']);
  let bruto = null;
  try { bruto = cfg.assinatura_oferta ? JSON.parse(cfg.assinatura_oferta) : null; } catch (e) { bruto = null; }
  // Compatibilidade: a versão anterior guardava só os benefícios, um por linha.
  const legado = String(cfg.assinatura_beneficios || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return normalizarOferta(bruto, legado.length ? legado : OFERTA_PADRAO.beneficios);
}

async function salvarOferta(dados) {
  const oferta = normalizarOferta(dados, OFERTA_PADRAO.beneficios);
  await db.execute({
    sql: `INSERT INTO configuracoes (chave, valor) VALUES ('assinatura_oferta', ?)
          ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
    args: [JSON.stringify(oferta)],
  });
  return oferta;
}

// Desconto (centavos) por ciclo sobre o valor cheio. Sempre deixa pelo menos R$ 1,00.
function calcularDescontoCentavos(valorCheioCentavos, desconto) {
  if (!desconto?.ativo) return 0;
  const bruto = desconto.tipo === 'valor'
    ? Number(desconto.valor_centavos) || 0
    : Math.round(valorCheioCentavos * ((Number(desconto.percentual) || 0) / 100));
  return Math.max(0, Math.min(bruto, valorCheioCentavos - VALOR_MINIMO_CENTAVOS));
}

function precoDaOferta(valorCheioCentavos, oferta) {
  const desconto = calcularDescontoCentavos(valorCheioCentavos, oferta.desconto);
  return { valor_cheio_centavos: valorCheioCentavos, desconto_centavos: desconto, valor_centavos: valorCheioCentavos - desconto };
}

// ── Criar / listar / cancelar ───────────────────────────────────────────────

async function criarAssinatura({ matriculaId, baseUrl, modalidade = null, dataPrimeiraCobranca = null }) {
  if (!habilitado()) throw erro('Assinaturas do Mercado Pago estão desligadas (MERCADOPAGO_ASSINATURAS).', 503);

  const r = await db.execute({
    sql: `SELECT m.id, m.status, m.aluno_id, p.nome AS plano_nome, p.tipo, p.valor_centavos,
                 a.nome AS aluno_nome, a.email, a.telefone
          FROM matriculas m
          JOIN planos p ON p.id = m.plano_id
          JOIN alunos a ON a.id = m.aluno_id
          WHERE m.id = ?`,
    args: [matriculaId],
  });
  const m = r.rows[0];
  if (!m) throw erro('Matrícula não encontrada.', 404);
  if (m.status !== 'ativa') throw erro('Só matrícula ativa pode ter assinatura.', 409);
  if (!modalidade && !TIPOS_RECORRENTES.includes(m.tipo)) throw erro('O plano desta matrícula não é recorrente.', 409);
  if (!m.email) throw erro('O aluno precisa ter e-mail cadastrado — o Mercado Pago exige.', 400);

  const existente = await db.execute({
    sql: `SELECT id FROM assinaturas_mp WHERE matricula_id = ? AND status IN ('pending', 'authorized', 'paused')`,
    args: [matriculaId],
  });
  if (existente.rows.length) throw erro('Esta matrícula já tem uma assinatura ativa ou aguardando o cartão.', 409);

  const oferta = await obterOferta();
  const planoRecorrencia = modalidade === '12_meses' || modalidade === 'mensal_livre';
  if (modalidade && !planoRecorrencia) throw erro('Modalidade de recorrência inválida.', 400);
  const valorCiclo = modalidade === '12_meses' ? 6500 : modalidade === 'mensal_livre' ? 7000 : Number(m.valor_centavos);
  const preco = modalidade ? { valor_cheio_centavos: valorCiclo, desconto_centavos: 0, valor_centavos: valorCiclo } : precoDaOferta(Number(m.valor_centavos), oferta);

  const id = uuid();
  const frequenciaMeses = modalidade ? 1 : MESES_POR_TIPO[m.tipo];
  const limiteCobrancas = modalidade === '12_meses' ? 12 : null;
  const dataFimCobranca = modalidade === '12_meses' && dataPrimeiraCobranca
    ? new Date(Date.UTC(Number(dataPrimeiraCobranca.slice(0,4)), Number(dataPrimeiraCobranca.slice(5,7))-1+11, Number(dataPrimeiraCobranca.slice(8,10)), 23, 59, 59)).toISOString()
    : null;
  const mp = await mercadopago.criarAssinaturaPendente({
    razao: `${m.plano_nome} — ${m.aluno_nome}`,
    valorCentavos: preco.valor_centavos,
    frequenciaMeses,
    emailPagador: m.email,
    referenciaExterna: id,
    urlRetorno: urlRetorno(baseUrl, id),
    dataInicio: dataPrimeiraCobranca ? `${dataPrimeiraCobranca}T00:00:00.000-03:00` : null,
    dataFim: dataFimCobranca,
  });
  if (!mp?.id) throw erro('Mercado Pago não devolveu o id da assinatura.', 502);

  await db.execute({
    sql: `INSERT INTO assinaturas_mp (id, matricula_id, aluno_id, preapproval_id, status, valor_centavos, valor_cheio_centavos, desconto_centavos, frequencia_meses, modalidade, limite_cobrancas, cobrancas_processadas, data_primeira_cobranca, init_point)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    args: [id, matriculaId, m.aluno_id, String(mp.id), preco.valor_centavos, preco.valor_cheio_centavos, preco.desconto_centavos, frequenciaMeses, modalidade || 'legado', limiteCobrancas, dataPrimeiraCobranca, mp.init_point || null],
  });

  const oUrl = urlOferta(baseUrl, id);
  const telefone = normalizarTelefone(m.telefone);
  const mensagem = `Oi, ${primeiroNome(m.aluno_nome)}! 💪 Deixe sua mensalidade no automático${preco.desconto_centavos ? ' e ganhe desconto' : ''}. Veja como é rápido: ${oUrl}`;
  return {
    id,
    preapproval_id: String(mp.id),
    init_point: mp.init_point || null,
    oferta_url: oUrl,
    whatsapp_link: telefone ? `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}` : null,
    status: 'pending',
    ...preco,
  };
}

async function listar({ matriculaId }) {
  const r = await db.execute({
    sql: `SELECT id, matricula_id, aluno_id, preapproval_id, status, valor_centavos, valor_cheio_centavos, desconto_centavos,
                 frequencia_meses, init_point, criado_em, atualizado_em
          FROM assinaturas_mp WHERE matricula_id = ? ORDER BY criado_em DESC`,
    args: [matriculaId],
  });
  return r.rows;
}

async function cancelar({ assinaturaId }) {
  if (!habilitado()) throw erro('Assinaturas do Mercado Pago estão desligadas (MERCADOPAGO_ASSINATURAS).', 503);
  const r = await db.execute({ sql: 'SELECT * FROM assinaturas_mp WHERE id = ?', args: [assinaturaId] });
  const a = r.rows[0];
  if (!a) throw erro('Assinatura não encontrada.', 404);
  if (a.status === 'cancelled') return { id: a.id, status: 'cancelled' };
  await mercadopago.cancelarAssinatura(a.preapproval_id);
  await atualizarStatus(a.preapproval_id, 'cancelled');
  return { id: a.id, status: 'cancelled' };
}

async function atualizarStatus(preapprovalId, status) {
  const permitido = ['pending', 'authorized', 'paused', 'cancelled', 'completed'];
  if (!permitido.includes(status)) return;
  await db.execute({
    sql: `UPDATE assinaturas_mp SET status = ?, atualizado_em = datetime('now') WHERE preapproval_id = ?`,
    args: [status, String(preapprovalId)],
  });
}

// ── Baixa automática ────────────────────────────────────────────────────────

// Dá baixa na conta em aberto MAIS ANTIGA da matrícula. Só chamada com pagamento
// já confirmado como aprovado na API do MP (nunca direto do corpo do webhook).
//
// Valor pago x valor da conta:
//   • pago >= conta                         → baixa normal;
//   • pago = conta − desconto da assinatura → reduz o valor da conta pelo desconto
//     (mesma convenção do pagamento manual com desconto) e baixa;
//   • qualquer outra diferença              → NÃO baixa: registra "valor_divergente"
//     para conferência humana (ex.: plano reajustado depois de assinar).
async function baixarParcela({ assinatura, paymentId, valorCentavos, metodo }) {
  const ja = await db.execute({
    sql: 'SELECT 1 FROM assinaturas_mp_pagamentos WHERE payment_id = ?',
    args: [String(paymentId)],
  });
  if (ja.rows.length) return { duplicado: true };

  const aberta = await db.execute({
    sql: `SELECT id, aluno_id, valor_centavos FROM cobrancas
          WHERE matricula_id = ? AND status IN ('pendente', 'atrasado')
          ORDER BY vencimento ASC, criado_em ASC LIMIT 1`,
    args: [assinatura.matricula_id],
  });
  const conta = aberta.rows[0] || null;
  const pago = Number(valorCentavos ?? assinatura.valor_centavos);

  let baixa = 'sem_cobranca';
  let novoValorConta = null;
  if (conta) {
    const valorConta = Number(conta.valor_centavos);
    const desconto = Number(assinatura.desconto_centavos || 0);
    if (pago >= valorConta) baixa = 'baixada';
    else if (desconto > 0 && pago === valorConta - desconto) { baixa = 'baixada'; novoValorConta = pago; }
    else baixa = 'valor_divergente';
  }

  // INSERT OR IGNORE: duas entregas simultâneas do mesmo webhook não baixam duas contas.
  const ins = await db.execute({
    sql: `INSERT OR IGNORE INTO assinaturas_mp_pagamentos (payment_id, assinatura_id, cobranca_id, valor_centavos, baixa)
          VALUES (?, ?, ?, ?, ?)`,
    args: [String(paymentId), assinatura.id, conta?.id || null, pago, baixa],
  });
  if (!ins.rowsAffected) return { duplicado: true };

  if (baixa === 'baixada') {
    if (novoValorConta !== null) {
      await db.execute({ sql: 'UPDATE cobrancas SET valor_centavos = ? WHERE id = ?', args: [novoValorConta, conta.id] });
    }
    await db.execute({
      sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = ?, pago_em = datetime('now') WHERE id = ?`,
      args: [metodo || 'credit_card', conta.id],
    });
    // Histórico/relatórios financeiros leem pagamentos_cobranca: registra o valor REAL cobrado.
    await db.execute({
      sql: `INSERT INTO pagamentos_cobranca (id, cobranca_id, data, valor_centavos, tipo, conta_corrente)
            VALUES (?, ?, date('now', 'localtime'), ?, 'cartao_credito', NULL)`,
      args: [uuid(), conta.id, pago],
    });
  } else if (baixa === 'sem_cobranca') {
    console.warn(`[assinaturas] parcela ${paymentId} aprovada mas a matrícula ${assinatura.matricula_id} não tem conta em aberto — registrada como "sem_cobranca" para conferência.`);
  } else {
    console.warn(`[assinaturas] parcela ${paymentId} de ${pago} centavos não bate com a conta ${conta.id} (${conta.valor_centavos}) — NÃO baixada, conferir manualmente.`);
  }
  await atualizarStatus(assinatura.preapproval_id, 'authorized');
  return { baixada: baixa === 'baixada', cobrancaId: conta?.id || null, alunoId: assinatura.aluno_id };
}

async function buscarPorPreapproval(preapprovalId) {
  const r = await db.execute({ sql: 'SELECT * FROM assinaturas_mp WHERE preapproval_id = ?', args: [String(preapprovalId)] });
  return r.rows[0] || null;
}

async function buscarPorId(id) {
  const r = await db.execute({ sql: 'SELECT * FROM assinaturas_mp WHERE id = ?', args: [String(id)] });
  return r.rows[0] || null;
}

/**
 * Trata um evento do webhook do MP. `type` e `dataId` vêm do corpo notificado.
 * Devolve { alunoId } quando alguma conta foi baixada (pra avisar o agente da
 * catraca), ou null. Eventos que não são de assinatura retornam null sem erro.
 * Sempre confirma o dado na API do MP — o corpo do webhook não prova nada.
 */
async function processarEvento({ type, dataId }) {
  if (!habilitado() || !dataId) return null;

  if (type === 'subscription_preapproval') {
    const mp = await mercadopago.consultarAssinatura(dataId);
    if (mp?.id) await atualizarStatus(mp.id, mp.status);
    return null;
  }

  if (type === 'subscription_authorized_payment') {
    const parcela = await mercadopago.consultarPagamentoAutorizado(dataId);
    const assinatura = parcela?.preapproval_id ? await buscarPorPreapproval(parcela.preapproval_id) : null;
    if (!assinatura) return null;
    const pagamento = parcela.payment || {};
    if (pagamento.status !== 'approved' || !pagamento.id) return null;
    const valor = parcela.transaction_amount != null ? Math.round(Number(parcela.transaction_amount) * 100) : assinatura.valor_centavos;
    const r = await baixarParcela({ assinatura, paymentId: pagamento.id, valorCentavos: valor, metodo: 'credit_card' });
    return r.baixada ? { alunoId: r.alunoId } : null;
  }

  return null;
}

/**
 * Atalho para o tópico "payment": se o pagamento aprovado veio de uma assinatura
 * (external_reference = id local da assinatura), dá a baixa pela mesma via.
 * `pagamento` é o objeto já consultado em GET /v1/payments/{id}.
 */
async function processarPagamentoAprovado(pagamento) {
  if (!habilitado() || pagamento?.status !== 'approved' || !pagamento.external_reference) return null;
  const assinatura = await buscarPorId(pagamento.external_reference);
  if (!assinatura) return null;
  const r = await baixarParcela({
    assinatura,
    paymentId: pagamento.id,
    valorCentavos: pagamento.transaction_amount != null ? Math.round(Number(pagamento.transaction_amount) * 100) : assinatura.valor_centavos,
    metodo: pagamento.payment_type_id || 'credit_card',
  });
  return r.baixada ? { alunoId: r.alunoId } : null;
}

// ── Página de oferta e portal do aluno ──────────────────────────────────────

// Plano recorrente usado como exemplo na prévia da página (o mais barato ativo).
async function planoDeExemplo() {
  const r = await db.execute({
    sql: `SELECT nome, valor_centavos, tipo FROM planos
          WHERE ativo = 1 AND tipo IN (${TIPOS_RECORRENTES.map(() => '?').join(', ')})
          ORDER BY valor_centavos ASC LIMIT 1`,
    args: TIPOS_RECORRENTES,
  });
  return r.rows[0] || null;
}

function montarOferta(base, oferta, extras) {
  return {
    selo: oferta.selo, titulo: oferta.titulo, subtitulo: oferta.subtitulo,
    beneficios: oferta.beneficios, botao: oferta.botao, microtexto: oferta.microtexto, faq: oferta.faq,
    ...base, ...extras,
  };
}

// Dados públicos da página (GET /api/pagamentos/assinaturas/oferta/:id). O id é um
// UUID aleatório. Não expõe e-mail, CPF nem telefone do aluno. `id = 'preview'` monta
// uma prévia com as configurações atuais (sem criar nada, sem link de pagamento).
async function ofertaPublica(id) {
  const [oferta, cfg] = await Promise.all([obterOferta(), lerConfig(['nome_app', 'whatsapp_contato'])]);
  const base = { academia: cfg.nome_app || 'Academia', whatsapp_contato: normalizarTelefone(cfg.whatsapp_contato) };

  if (id === 'preview') {
    const plano = await planoDeExemplo();
    const cheio = plano ? Number(plano.valor_centavos) : 9900;
    return montarOferta(base, oferta, {
      preview: true, aluno: 'Maria', plano: plano?.nome || 'Plano Mensal', status: 'pending', init_point: '#',
      frequencia_meses: plano ? (MESES_POR_TIPO[plano.tipo] || 1) : 1,
      ...precoDaOferta(cheio, oferta),
    });
  }

  const r = await db.execute({
    sql: `SELECT s.status, s.valor_centavos, s.valor_cheio_centavos, s.desconto_centavos, s.frequencia_meses, s.init_point,
                 a.nome AS aluno_nome, p.nome AS plano_nome
          FROM assinaturas_mp s
          JOIN alunos a ON a.id = s.aluno_id
          JOIN matriculas m ON m.id = s.matricula_id
          JOIN planos p ON p.id = m.plano_id
          WHERE s.id = ?`,
    args: [String(id)],
  });
  const o = r.rows[0];
  if (!o) return null;
  const desconto = Number(o.desconto_centavos || 0);
  return montarOferta(base, oferta, {
    aluno: primeiroNome(o.aluno_nome),
    plano: o.plano_nome,
    status: o.status,
    init_point: o.status === 'cancelled' ? null : o.init_point,
    frequencia_meses: Number(o.frequencia_meses),
    valor_centavos: Number(o.valor_centavos),
    desconto_centavos: desconto,
    // Assinaturas antigas (sem valor cheio gravado) não exibem "de/por".
    valor_cheio_centavos: o.valor_cheio_centavos != null ? Number(o.valor_cheio_centavos) : Number(o.valor_centavos) + desconto,
  });
}

// Matrícula do aluno que pode virar assinatura (ativa + plano recorrente).
async function matriculaElegivel(alunoId) {
  // A oferta é uma migração de modalidade para qualquer aluno com matrícula ativa,
  // não depende do tipo do plano tradicional atual.
  const r = await db.execute({
    sql: `SELECT m.id, m.data_inicio, p.nome AS plano_nome, p.valor_centavos
          FROM matriculas m JOIN planos p ON p.id = m.plano_id
          WHERE m.aluno_id = ? AND m.status = 'ativa'
          ORDER BY m.data_inicio DESC LIMIT 1`,
    args: [alunoId],
  });
  return r.rows[0] || null;
}

function somarMesesISO(dataISO, meses) {
  const [ano, mes, dia] = dataISO.slice(0, 10).split('-').map(Number);
  const alvo = new Date(Date.UTC(ano, mes - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dia, ultimoDia)).padStart(2, '0')}`;
}

// Na migração: reaproveita a primeira mensalidade em aberto. Se a competência
// atual já foi quitada, inicia no próximo vencimento mensal; não cria segunda
// cobrança para a mesma competência.
async function prepararCobrancaInicial({ matricula, valorCentavos, modalidade }) {
  const abertas = await db.execute({
    sql: `SELECT id, vencimento FROM cobrancas
          WHERE matricula_id = ? AND status IN ('pendente', 'atrasado')
          ORDER BY vencimento ASC, criado_em ASC`,
    args: [matricula.id],
  });
  const hoje = new Date().toISOString().slice(0, 10);
  let vencimento;
  let cobrancaId;
  if (abertas.rows.length) {
    vencimento = String(abertas.rows[0].vencimento || hoje).slice(0, 10);
    cobrancaId = abertas.rows[0].id;
    await db.execute({
      sql: `UPDATE cobrancas SET valor_centavos = ?, descricao = ? WHERE id = ?`,
      args: [valorCentavos, modalidade === '12_meses' ? 'Recorrência 12 meses - R$ 65,00' : 'Recorrência mensal - R$ 70,00', cobrancaId],
    });
    // Cancela contas futuras pré-geradas pela matrícula tradicional. A partir
    // da migração, a sequência será conduzida pelas confirmações do Mercado Pago.
    for (const futura of abertas.rows.slice(1)) {
      await db.execute({ sql: `UPDATE cobrancas SET status = 'cancelado' WHERE id = ?`, args: [futura.id] });
    }
  } else {
    const ultima = await db.execute({
      sql: `SELECT vencimento FROM cobrancas WHERE matricula_id = ? ORDER BY vencimento DESC, criado_em DESC LIMIT 1`,
      args: [matricula.id],
    });
    vencimento = ultima.rows[0]?.vencimento
      ? somarMesesISO(String(ultima.rows[0].vencimento), 1)
      : primeiroVencimento(matricula.data_inicio || hoje);
    cobrancaId = uuid();
    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento)
            VALUES (?, ?, ?, ?, 'pendente', 'recorrencia', ?, ?)`,
      args: [cobrancaId, matricula.aluno_id, matricula.id, valorCentavos,
        modalidade === '12_meses' ? 'Recorrência 12 meses - R$ 65,00' : 'Recorrência mensal - R$ 70,00', vencimento],
    });
  }
  return { vencimento, cobrancaId };
}

async function assinaturaAbertaDaMatricula(matriculaId) {
  const r = await db.execute({
    sql: `SELECT id, status, valor_centavos FROM assinaturas_mp WHERE matricula_id = ? AND status IN ('pending', 'authorized', 'paused')
          ORDER BY criado_em DESC LIMIT 1`,
    args: [matriculaId],
  });
  return r.rows[0] || null;
}

// Para o portal do aluno: mostra o card "pague no automático"? Nunca mostra se o
// recurso está desligado, se não há matrícula elegível ou se já está autorizada.
// O preço exibido é o ATUAL (com o desconto vigente), não o de uma assinatura antiga.
async function disponibilidadeParaAluno({ alunoId, baseUrl }) {
  if (!habilitado()) return { disponivel: false };
  const m = await matriculaElegivel(alunoId);
  if (!m) return { disponivel: false };
  const existente = await assinaturaAbertaDaMatricula(m.id);
  if (existente && ['authorized', 'paused'].includes(existente.status)) {
    return { disponivel: false, status: existente.status };
  }
  return {
    disponivel: true,
    plano_atual: m.plano_nome,
    opcoes: [
      { modalidade: '12_meses', titulo: 'Recorrência com compromisso de 12 meses', valor_centavos: 6500, limite_cobrancas: 12, total_centavos: 78000, descricao: '12 cobranças de R$ 65,00 (total de R$ 780,00).' },
      { modalidade: 'mensal_livre', titulo: 'Mensal automático sem fidelidade', valor_centavos: 7000, limite_cobrancas: null, total_centavos: null, descricao: 'R$ 70,00 por mês, sem permanência mínima.' },
    ],
    assinatura_pendente: existente ? { id: existente.id, modalidade: existente.modalidade } : null,
  };
}

// Reaproveita assinatura pendente da mesma modalidade. Uma assinatura ativa impede
// criar outra, para não manter duas cobranças automáticas simultâneas.
async function obterOuCriarParaAluno({ alunoId, baseUrl, modalidade }) {
  if (!['12_meses', 'mensal_livre'].includes(modalidade)) throw erro('Escolha uma das modalidades disponíveis.', 400);
  const disp = await disponibilidadeParaAluno({ alunoId, baseUrl });
  if (!disp.disponivel) throw erro('Pagamento automático não está disponível para este aluno.', 409);
  const m = await matriculaElegivel(alunoId);
  const pendente = await assinaturaAbertaDaMatricula(m.id);
  if (pendente && pendente.modalidade === modalidade) {
    return { oferta_url: urlOferta(baseUrl, pendente.id) };
  }
  if (pendente) await cancelar({ assinaturaId: pendente.id });
  const valor = modalidade === '12_meses' ? 6500 : 7000;
  const ciclo = await prepararCobrancaInicial({ matricula: { ...m, aluno_id: alunoId }, valorCentavos: valor, modalidade });
  const criada = await criarAssinatura({
    matriculaId: m.id, baseUrl, modalidade, dataPrimeiraCobranca: ciclo.vencimento,
  });
  return { oferta_url: criada.oferta_url };
}

module.exports = {
  habilitado, criarAssinatura, listar, cancelar, processarEvento, processarPagamentoAprovado,
  ofertaPublica, disponibilidadeParaAluno, obterOuCriarParaAluno, baseUrlDaRequisicao, urlOferta,
  obterOferta, salvarOferta, calcularDescontoCentavos, OFERTA_PADRAO,
};
