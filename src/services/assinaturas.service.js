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
    'Acompanhe a confirmação dos pagamentos pelo portal do aluno',
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

// Aceita o objeto de desconto direto ({ativo,tipo,...}) ou a oferta legada ({desconto:{...}}).
function precoDaOferta(valorCheioCentavos, descontoOuOferta) {
  const cfg = descontoOuOferta && descontoOuOferta.desconto && typeof descontoOuOferta.desconto === 'object' ? descontoOuOferta.desconto : descontoOuOferta;
  const desconto = calcularDescontoCentavos(valorCheioCentavos, cfg);
  return { valor_cheio_centavos: valorCheioCentavos, desconto_centavos: desconto, valor_centavos: valorCheioCentavos - desconto };
}


// Modalidades oferecidas somente no cadastro de novos alunos. Os valores ficam
// no banco; ao contratar, valor, desconto e limite são copiados para a assinatura.
const CATEGORIAS_ALUNO = ['aluno', 'professor', 'visitante', 'colaborador', 'bolsista'];
const PLANOS_CADASTRO_PADRAO = [
  { id: '12_meses', nome: 'Compromisso de 12 meses', valor_centavos: 6500, limite_cobrancas: 12, ativo: true, desconto: { ativo: false, tipo: 'percentual', percentual: 0, valor_centavos: 0 } },
  { id: 'mensal_livre', nome: 'Mensal sem fidelidade', valor_centavos: 7000, limite_cobrancas: null, ativo: true, desconto: { ativo: false, tipo: 'percentual', percentual: 0, valor_centavos: 0 } },
];

function normalizarPlanosCadastro(bruto) {
  const lista = Array.isArray(bruto) ? bruto : PLANOS_CADASTRO_PADRAO;
  const ids = new Set();
  return lista.map((p) => {
    const id = String(p?.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    const nome = String(p?.nome || '').trim().slice(0, 80);
    const valor = Math.round(Number(p?.valor_centavos) || 0);
    const limiteRaw = p?.limite_cobrancas;
    const limite = limiteRaw == null || limiteRaw === '' || Number(limiteRaw) === 0 ? null : Math.max(1, Math.min(120, Math.round(Number(limiteRaw))));
    const d = p?.desconto && typeof p.desconto === 'object' ? p.desconto : {};
    const tipo = d.tipo === 'valor' ? 'valor' : 'percentual';
    const percentual = Math.max(0, Math.min(90, Number(d.percentual) || 0));
    const valorDesconto = Math.max(0, Math.round(Number(d.valor_centavos) || 0));
    if (!id || !nome || valor < VALOR_MINIMO_CENTAVOS || ids.has(id)) return null;
    ids.add(id);
    // Visibilidade: restrita = só os CPFs listados enxergam/contratam (ex.: aluno de teste). Lista vazia = ninguém
    // além do painel enxerga (rascunho).
    const cpfs = [...new Set((Array.isArray(p?.cpfs_permitidos) ? p.cpfs_permitidos : []).map((x) => String(x).replace(/\D/g, '')).filter((x) => x.length === 11))].slice(0, 50);
    return { id, nome, valor_centavos: valor, limite_cobrancas: limite, ativo: p?.ativo !== false,
      restrito: p?.restrito === true, cpfs_permitidos: cpfs,
      categorias_permitidas: [...new Set((Array.isArray(p?.categorias_permitidas) ? p.categorias_permitidas : []).map((x) => String(x).toLowerCase()).filter((x) => CATEGORIAS_ALUNO.includes(x)))],
      desconto: { ativo: d.ativo === true && (tipo === 'percentual' ? percentual > 0 : valorDesconto > 0), tipo, percentual, valor_centavos: valorDesconto } };
  }).filter(Boolean).slice(0, 12);
}

async function obterPlanosCadastro() {
  const cfg = await lerConfig(['assinatura_planos_cadastro']);
  try { return normalizarPlanosCadastro(cfg.assinatura_planos_cadastro ? JSON.parse(cfg.assinatura_planos_cadastro) : null); }
  catch { return normalizarPlanosCadastro(null); }
}

async function salvarPlanosCadastro(planos) {
  const normalizados = normalizarPlanosCadastro(planos);
  if (!normalizados.length) throw erro('Cadastre ao menos uma modalidade válida.', 400);
  await db.execute({
    sql: "INSERT INTO configuracoes (chave, valor) VALUES ('assinatura_planos_cadastro', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
    args: [JSON.stringify(normalizados)],
  });
  return normalizados;
}

// Uma modalidade restrita só é visível/contratável por quem tem o CPF na lista OU pertence a uma das
// categorias liberadas (ex.: só "professor"). O painel (admin=true) enxerga todas.
function modalidadeVisivelPara(p, { cpf = null, categoria = null, admin = false } = {}) {
  if (!p.ativo && !admin) return false;
  if (admin || !p.restrito) return true;
  const digitos = String(cpf || '').replace(/\D/g, '');
  if (digitos.length === 11 && (p.cpfs_permitidos || []).includes(digitos)) return true;
  return !!categoria && (p.categorias_permitidas || []).includes(String(categoria).toLowerCase());
}

// CPF e categoria do aluno, por id ou por CPF (só dígitos). Sem aluno → valores nulos.
async function identidadeDoAluno({ alunoId = null, cpf = null } = {}) {
  try {
    if (alunoId) {
      const r = await db.execute({ sql: 'SELECT cpf, categoria FROM alunos WHERE id = ?', args: [alunoId] });
      return { cpf: r.rows[0]?.cpf || null, categoria: r.rows[0]?.categoria || null };
    }
    const digitos = String(cpf || '').replace(/\D/g, '');
    if (digitos.length !== 11) return { cpf: null, categoria: null };
    const r = await db.execute({
      sql: "SELECT cpf, categoria FROM alunos WHERE replace(replace(replace(cpf, '.', ''), '-', ''), ' ', '') = ? LIMIT 1",
      args: [digitos],
    });
    return { cpf: digitos, categoria: r.rows[0]?.categoria || null };
  } catch { return { cpf: null, categoria: null }; }
}

async function listarPlanosCadastroPublicos({ cpf = null, alunoId = null } = {}) {
  // Recurso desligado (MERCADOPAGO_ASSINATURAS != 1): não oferece nada ao aluno.
  if (!habilitado()) return [];
  const planos = await obterPlanosCadastro();
  const identidade = planos.some((p) => p.ativo && p.restrito) ? await identidadeDoAluno({ alunoId, cpf }) : { cpf, categoria: null };
  return planos.filter((p) => p.ativo && modalidadeVisivelPara(p, identidade)).map(p => {
    const preco = precoDaOferta(p.valor_centavos, p.desconto);
    return { id: p.id, nome: p.nome, valor_centavos: p.valor_centavos, valor_final_centavos: preco.valor_centavos,
      desconto_centavos: preco.desconto_centavos, limite_cobrancas: p.limite_cobrancas };
  });
}

async function buscarPlanoCadastro(id, { alunoId = null, cpf = null, admin = false } = {}) {
  const p = (await obterPlanosCadastro()).find(x => x.id === id && (x.ativo || admin));
  const identidade = p && p.restrito && !admin ? await identidadeDoAluno({ alunoId, cpf }) : { cpf, categoria: null };
  if (!p || !modalidadeVisivelPara(p, { ...identidade, admin })) throw erro('Esta modalidade de recorrência não está disponível. Atualize a página e escolha outra opção.', 404);
  return p;
}

function formatarValorParaDescricao(centavos) {
  return 'R$ ' + (Number(centavos || 0) / 100).toFixed(2).replace('.', ',');
}

// ── Criar / listar / cancelar ───────────────────────────────────────────────

async function criarAssinatura({ matriculaId, baseUrl, modalidade = null, dataPrimeiraCobranca = null, cobrancaInicialId = null, valorAnteriorCentavos = null, statusAnteriorCobranca = null, vencimentoAnterior = null, cobrancaInicialCriada = false, permitirMatriculaPendente = false }) {
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
  if (m.status !== 'ativa' && !(permitirMatriculaPendente && modalidade && m.status === 'pendente')) throw erro('Só matrícula ativa pode ter assinatura.', 409);
  if (!modalidade && !TIPOS_RECORRENTES.includes(m.tipo)) throw erro('O plano desta matrícula não é recorrente.', 409);
  if (!m.email) throw erro('O aluno precisa ter e-mail cadastrado — o Mercado Pago exige.', 400);

  const existente = await db.execute({
    sql: `SELECT id FROM assinaturas_mp WHERE matricula_id = ? AND status IN ('pending', 'authorized', 'paused')`,
    args: [matriculaId],
  });
  if (existente.rows.length) throw erro('Esta matrícula já tem uma assinatura ativa ou aguardando o cartão.', 409);

  const oferta = await obterOferta();
  // Só o fluxo de NOVO cadastro usa a tabela configurável. A oferta de migração
  // para alunos existentes mantém as condições antigas e independentes.
  const planoCadastro = modalidade ? await buscarPlanoCadastro(modalidade, { admin: true }) : null; // quem chama já validou a visibilidade
  const preco = planoCadastro
    ? precoDaOferta(Number(planoCadastro.valor_centavos), planoCadastro.desconto)
    : precoDaOferta(Number(m.valor_centavos), oferta);

  const id = uuid();
  const frequenciaMeses = modalidade ? 1 : MESES_POR_TIPO[m.tipo];
  const limiteCobrancas = planoCadastro ? planoCadastro.limite_cobrancas : null;
  const hojeCobranca = new Date().toISOString().slice(0, 10);
  const dataInicioMP = dataPrimeiraCobranca && dataPrimeiraCobranca > hojeCobranca
    ? `${dataPrimeiraCobranca}T00:00:00.000-03:00`
    : null;
  const mp = await mercadopago.criarAssinaturaPendente({
    razao: modalidade
      ? (m.plano_nome + ' — ' + planoCadastro.nome + ' — ' + formatarValorParaDescricao(preco.valor_centavos) + ' por mês')
      : (m.plano_nome + ' — ' + m.aluno_nome),
    valorCentavos: preco.valor_centavos,
    frequenciaMeses,
    emailPagador: m.email,
    referenciaExterna: id,
    urlRetorno: urlRetorno(baseUrl, id),
    dataInicio: dataInicioMP,
    limiteCobrancas,
  });
  if (!mp?.id) throw erro('Mercado Pago não devolveu o id da assinatura.', 502);

  await db.execute({
    sql: `INSERT INTO assinaturas_mp (id, matricula_id, aluno_id, preapproval_id, status, valor_centavos, valor_cheio_centavos, desconto_centavos, frequencia_meses, modalidade, limite_cobrancas, cobrancas_processadas, data_primeira_cobranca, cobranca_inicial_id, valor_anterior_centavos, status_anterior_cobranca, vencimento_anterior, cobranca_inicial_criada, init_point)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, matriculaId, m.aluno_id, String(mp.id), preco.valor_centavos, preco.valor_cheio_centavos, preco.desconto_centavos, frequenciaMeses, modalidade || 'legado', limiteCobrancas, dataPrimeiraCobranca, cobrancaInicialId, valorAnteriorCentavos, statusAnteriorCobranca, vencimentoAnterior, cobrancaInicialCriada ? 1 : 0, mp.init_point || null],
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
                 frequencia_meses, modalidade, limite_cobrancas, cobrancas_processadas, init_point, criado_em, atualizado_em
          FROM assinaturas_mp WHERE matricula_id = ? ORDER BY criado_em DESC`,
    args: [matriculaId],
  });
  return r.rows;
}

// Devolve a cobrança do cadastro ao estado de antes do checkout (valor, status e
// vencimento originais — regra normal 10/20). Usado em cancelamento, recusa e expiração.
async function restaurarCobrancaInicial(a) {
  if (!a?.cobranca_inicial_id) return;
  if (Number(a.cobranca_inicial_criada) === 1) {
    await db.execute({ sql: `UPDATE cobrancas SET status = 'cancelado' WHERE id = ? AND status IN ('pendente','atrasado')`, args: [a.cobranca_inicial_id] });
    return;
  }
  if (a.valor_anterior_centavos == null) return;
  await db.execute({
    sql: `UPDATE cobrancas SET valor_centavos = ?, status = ?, vencimento = COALESCE(?, vencimento)
          WHERE id = ? AND status IN ('pendente','atrasado')`,
    args: [a.valor_anterior_centavos, a.status_anterior_cobranca || 'pendente', a.vencimento_anterior || null, a.cobranca_inicial_id],
  });
}

// Marca (em `row.recorrencia`) as linhas que pertencem a uma matrícula com assinatura no cartão,
// para o painel distinguir "recorrência" de "plano normal". `campoMatricula` = nome da coluna do id.
// Se a tabela ainda não existe (migração pendente) ou o recurso falha, devolve as linhas sem marca.
async function anexarRecorrencia(rows, campoMatricula = 'matricula_id') {
  if (!rows?.length) return rows;
  let subs;
  try {
    subs = await db.execute({
      sql: `SELECT matricula_id, modalidade, status, limite_cobrancas, cobrancas_processadas
            FROM assinaturas_mp WHERE status IN ('pending', 'authorized', 'paused', 'completed') ORDER BY criado_em ASC`,
      args: [], // o cliente do Turso exige `args`, mesmo vazio
    });
  } catch (err) {
    if (/no such table: assinaturas_mp/i.test(String(err.message))) return rows;
    throw err;
  }
  if (!subs.rows.length) return rows;
  const nomes = {};
  try { for (const p of await obterPlanosCadastro()) nomes[p.id] = p.nome; } catch { /* sem nomes: usa o id */ }
  const porMatricula = new Map(); // a mais recente vence (ORDER BY criado_em ASC)
  for (const x of subs.rows) {
    porMatricula.set(x.matricula_id, {
      modalidade: x.modalidade,
      nome: x.modalidade === 'legado' ? 'Cartão automático' : (nomes[x.modalidade] || x.modalidade),
      status: x.status,
      limite_cobrancas: x.limite_cobrancas == null ? null : Number(x.limite_cobrancas),
      cobrancas_processadas: Number(x.cobrancas_processadas || 0),
    });
  }
  for (const row of rows) row.recorrencia = porMatricula.get(row[campoMatricula]) || null;
  return rows;
}

// O aluno escolheu pagar em Pix: cancela a tentativa de cartão que estava pendente (sem cobrar nada).
async function cancelarPendentesDasMatriculas(matriculaIds) {
  if (!habilitado() || !matriculaIds?.length) return 0;
  let n = 0;
  for (const matriculaId of new Set(matriculaIds.filter(Boolean))) {
    let r;
    try {
      r = await db.execute({ sql: `SELECT id FROM assinaturas_mp WHERE matricula_id = ? AND status = 'pending'`, args: [matriculaId] });
    } catch (err) {
      if (/no such table: assinaturas_mp/i.test(String(err.message))) return 0;
      throw err;
    }
    for (const a of r.rows) {
      try { await cancelar({ assinaturaId: a.id }); n++; }
      catch (err) { console.error('[assinaturas] não foi possível cancelar checkout pendente', a.id, err.message); }
    }
  }
  return n;
}

// Recorrência encerrada com a matrícula seguindo: volta a valer a regra normal
// (renovação automática do sistema, vencimentos dia 10/20, pagamento Pix/balcão).
// Apaga só as contas em aberto criadas pela assinatura (provedor 'assinatura_mp');
// as pagas ficam no histórico e o gerador normal retoma a partir da última paga.
async function reverterParaPlanoNormal(a) {
  await db.execute({
    sql: `DELETE FROM cobrancas WHERE matricula_id = ? AND provedor = 'assinatura_mp' AND status IN ('pendente','atrasado')`,
    args: [a.matricula_id],
  });
  await db.execute({ sql: `UPDATE matriculas SET renovacao_automatica = 1 WHERE id = ? AND status = 'ativa'`, args: [a.matricula_id] });
}

async function cancelar({ assinaturaId, encerrarMatricula = false }) {
  if (!habilitado()) throw erro('Assinaturas do Mercado Pago estão desligadas (MERCADOPAGO_ASSINATURAS).', 503);
  const r = await db.execute({ sql: 'SELECT * FROM assinaturas_mp WHERE id = ?', args: [assinaturaId] });
  const a = r.rows[0];
  if (!a) throw erro('Assinatura não encontrada.', 404);
  if (a.status === 'cancelled' || a.status === 'completed') return { id: a.id, status: a.status };
  await mercadopago.cancelarAssinatura(a.preapproval_id);
  await atualizarStatus(a.preapproval_id, 'cancelled');
  // Checkout pendente ainda não migrou a matrícula nem encerrou a modalidade atual.
  if (a.status === 'pending') {
    await restaurarCobrancaInicial(a);
    return { id: a.id, status: 'cancelled' };
  }
  // Recorrência de novo cadastro: cancelar = voltar ao plano normal (a matrícula segue
  // ativa pela regra de hoje). Só encerra o acesso se pedirem explicitamente.
  if (a.modalidade && a.modalidade !== 'legado' && !encerrarMatricula) {
    await reverterParaPlanoNormal(a);
    return { id: a.id, status: 'cancelled', voltou_plano_normal: true };
  }
  const ultimaPaga = await db.execute({
    sql: `SELECT vencimento FROM cobrancas WHERE matricula_id = ? AND status = 'pago' ORDER BY vencimento DESC, pago_em DESC LIMIT 1`,
    args: [a.matricula_id],
  });
  const hoje = new Date().toISOString().slice(0, 10);
  const fimAcesso = ultimaPaga.rows[0]?.vencimento
    ? somarMesesISO(String(ultimaPaga.rows[0].vencimento), 1)
    : hoje;
  await db.execute({
    sql: `UPDATE matriculas SET data_fim = ?, renovacao_automatica = 0 WHERE id = ?`,
    args: [fimAcesso, a.matricula_id],
  });
  await db.execute({
    sql: `UPDATE cobrancas SET status = 'cancelado' WHERE matricula_id = ? AND status IN ('pendente', 'atrasado') AND vencimento >= date('now')`,
    args: [a.matricula_id],
  });
  return { id: a.id, status: 'cancelled', acesso_ate: fimAcesso };
}

async function atualizarStatus(preapprovalId, status) {
  const permitido = ['pending', 'authorized', 'paused', 'cancelled', 'completed'];
  if (!permitido.includes(status)) return;
  await db.execute({
    sql: `UPDATE assinaturas_mp SET status = ?, atualizado_em = datetime('now') WHERE preapproval_id = ? AND (status != 'completed' OR ? = 'completed')`,
    args: [status, String(preapprovalId), status],
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
    sql: `SELECT id, aluno_id, valor_centavos, vencimento FROM cobrancas
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
    if (assinatura.modalidade && assinatura.modalidade !== 'legado' && pago === Number(assinatura.valor_centavos)) { baixa = 'baixada'; novoValorConta = pago; }
    else if (pago >= valorConta) baixa = 'baixada';
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
    // Novo cadastro no cartão: a 1ª conta passa a vencer no dia da adesão (e as seguintes no mesmo dia),
    // sem seguir o 10/20 — isso só volta a valer se a recorrência for cancelada.
    if (assinatura.modalidade && assinatura.modalidade !== 'legado' && !assinatura.data_primeira_cobranca && conta.id === assinatura.cobranca_inicial_id) {
      const hojeAdesao = new Date().toISOString().slice(0, 10);
      await db.execute({ sql: 'UPDATE cobrancas SET vencimento = ? WHERE id = ?', args: [hojeAdesao, conta.id] });
      conta.vencimento = hojeAdesao; // a próxima conta (registrarProximaCobranca) parte da data da adesão
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
    if (assinatura.modalidade && assinatura.modalidade !== 'legado') {
      await registrarProximaCobranca(assinatura, conta);
    }
  } else if (baixa === 'sem_cobranca') {
    // Primeira cobrança aprovada sem conta aberta: ainda assim ativa a matrícula e agenda o ciclo seguinte.
    if (assinatura.modalidade && assinatura.modalidade !== 'legado') {
      await registrarProximaCobranca(assinatura, { vencimento: new Date().toISOString().slice(0, 10) });
    }
    console.warn(`[assinaturas] parcela ${paymentId} aprovada mas a matrícula ${assinatura.matricula_id} não tem conta em aberto — registrada como "sem_cobranca" para conferência.`);
  } else {
    console.warn(`[assinaturas] parcela ${paymentId} de ${pago} centavos não bate com a conta ${conta.id} (${conta.valor_centavos}) — NÃO baixada, conferir manualmente.`);
  }
  if (!(assinatura.limite_cobrancas && Number(assinatura.cobrancas_processadas || 0) + 1 >= Number(assinatura.limite_cobrancas))) {
    await atualizarStatus(assinatura.preapproval_id, 'authorized');
  }
  return { baixada: baixa === 'baixada', cobrancaId: conta?.id || null, alunoId: assinatura.aluno_id };
}

async function registrarProximaCobranca(assinatura, cobrancaAtual) {
  await db.execute({
    sql: `UPDATE assinaturas_mp SET cobrancas_processadas = cobrancas_processadas + 1, atualizado_em = datetime('now') WHERE id = ?`,
    args: [assinatura.id],
  });
  const lida = await db.execute({ sql: 'SELECT * FROM assinaturas_mp WHERE id = ?', args: [assinatura.id] });
  const a = lida.rows[0];
  if (!a) return;
  await db.execute({ sql: 'UPDATE matriculas SET renovacao_automatica = 0 WHERE id = ?', args: [a.matricula_id] });
  const quantidade = Number(a.cobrancas_processadas || 0);
  const limite = a.limite_cobrancas == null ? null : Number(a.limite_cobrancas);
  const hoje = new Date().toISOString().slice(0, 10);
  const baseVencimento = String(cobrancaAtual.vencimento || hoje).slice(0, 10);
  let proximoVencimento = somarMesesISO(baseVencimento < hoje ? hoje : baseVencimento, 1);
  // A assinatura substitui a geração automática tradicional de cobranças
  // (renovacao_automatica fica desligada). Portanto, cada parcela aprovada
  // precisa estender a validade da matrícula até o próximo vencimento.
  await db.execute({
    sql: `UPDATE matriculas SET data_fim = ?, status = CASE WHEN status = 'pendente' THEN 'ativa' ELSE status END WHERE id = ?`,
    args: [proximoVencimento, a.matricula_id],
  });
  if (limite && quantidade >= limite) {
    await db.execute({
      sql: `UPDATE cobrancas SET status = 'cancelado' WHERE matricula_id = ? AND status IN ('pendente','atrasado') AND vencimento > ?`,
      args: [a.matricula_id, baseVencimento],
    });
    // Fecha a assinatura limitada após a última cobrança aprovada. Marca 'completed' ANTES
    // de cancelar no MP, para o webhook de cancelamento não tratar como cancelamento do aluno.
    await db.execute({
      sql: `UPDATE assinaturas_mp SET status = 'completed', atualizado_em = datetime('now') WHERE id = ?`,
      args: [a.id],
    });
    try { await mercadopago.cancelarAssinatura(a.preapproval_id); }
    catch (err) { console.error('[assinaturas] não foi possível encerrar no Mercado Pago após o último ciclo:', err.message); }
    await db.execute({
      sql: `UPDATE matriculas SET data_fim = ?, renovacao_automatica = 0 WHERE id = ?`,
      args: [proximoVencimento, a.matricula_id],
    });
    return;
  }
  let proximaExistente = await db.execute({
    sql: `SELECT id, status FROM cobrancas WHERE matricula_id = ? AND vencimento = ? LIMIT 1`,
    args: [a.matricula_id, proximoVencimento],
  });
  // Se a próxima competência já foi quitada manualmente, não cobre de novo:
  // avança até a primeira competência ainda não paga.
  while (proximaExistente.rows[0]?.status === 'pago') {
    proximoVencimento = somarMesesISO(proximoVencimento, 1);
    proximaExistente = await db.execute({
      sql: `SELECT id, status FROM cobrancas WHERE matricula_id = ? AND vencimento = ? LIMIT 1`,
      args: [a.matricula_id, proximoVencimento],
    });
  }
  const descricao = 'Recorrência - ' + String(a.modalidade || 'mensal');
  // Cancela somente competências futuras além da próxima. Reutiliza a linha
  // já pré-gerada para a próxima competência, respeitando o índice único.
  await db.execute({
    sql: `UPDATE cobrancas SET status = 'cancelado'
          WHERE matricula_id = ? AND status IN ('pendente','atrasado') AND vencimento > ?`,
    args: [a.matricula_id, proximoVencimento],
  });
  if (proximaExistente.rows[0]) {
    if (proximaExistente.rows[0].status !== 'pago') {
      await db.execute({
        sql: `UPDATE cobrancas SET aluno_id = ?, valor_centavos = ?, status = 'pendente', provedor = 'assinatura_mp', descricao = ?, pago_em = NULL, metodo_pagamento = NULL WHERE id = ?`,
        args: [a.aluno_id, a.valor_centavos, descricao, proximaExistente.rows[0].id],
      });
    }
  } else {
    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento)
            VALUES (?, ?, ?, ?, 'pendente', 'assinatura_mp', ?, ?)`,
      args: [uuid(), a.aluno_id, a.matricula_id, a.valor_centavos, descricao, proximoVencimento],
    });
  }
}

/**
 * Encerra checkouts recorrentes abandonados (aluno nunca cadastrou o cartão ou a
 * 1ª cobrança não foi aprovada) com mais de `horas` horas. Antes de cancelar,
 * confere o status real no MP: se já estiver autorizada, só sincroniza (webhook
 * perdido). Ao cancelar, cancelar() restaura a cobrança tradicional original.
 */
async function expirarCheckoutsAbandonados({ horas = 48 } = {}) {
  if (!habilitado()) return { cancelados: 0, sincronizados: 0 };
  const r = await db.execute({
    sql: `SELECT id, preapproval_id FROM assinaturas_mp
          WHERE status = 'pending' AND criado_em <= datetime('now', ?)`,
    args: [`-${Math.max(1, Number(horas) || 48)} hours`],
  });
  let cancelados = 0, sincronizados = 0;
  for (const a of r.rows) {
    try {
      const mp = await mercadopago.consultarAssinatura(a.preapproval_id);
      if (mp?.status && mp.status !== 'pending') {
        await atualizarStatus(a.preapproval_id, mp.status);
        sincronizados++;
        if (mp.status !== 'cancelled') continue;
      }
      if (mp?.status !== 'cancelled') { await cancelar({ assinaturaId: a.id }); cancelados++; }
      else {
        // Já cancelada no MP: só restaura a cobrança original (status local ainda era pending).
        const x = (await db.execute({ sql: 'SELECT * FROM assinaturas_mp WHERE id = ?', args: [a.id] })).rows[0];
        await restaurarCobrancaInicial(x);
      }
    } catch (err) {
      console.error('[assinaturas] falha ao expirar checkout', a.id, err.message);
    }
  }
  return { cancelados, sincronizados };
}

// Sincroniza UMA assinatura com o MP: status + cobranças aprovadas ainda não processadas.
// Lança erro se o MP não responder (para o painel mostrar o motivo).
async function reconciliarUmaAssinatura(preapprovalId) {
  const r = { baixas: 0, alunosAtualizados: [] };
  await processarEvento({ type: 'subscription_preapproval', dataId: preapprovalId });
  const cobrancas = await mercadopago.listarCobrancasDaAssinatura(preapprovalId);
  for (const parcela of cobrancas) {
    const pagamento = parcela.payment || {};
    if (pagamento.status !== 'approved' || !pagamento.id) continue;
    const assinatura = await buscarPorPreapproval(preapprovalId); // recarrega: o contador muda a cada baixa
    if (!assinatura || assinatura.status === 'completed') break;
    const valor = parcela.transaction_amount != null ? Math.round(Number(parcela.transaction_amount) * 100) : assinatura.valor_centavos;
    const b = await baixarParcela({ assinatura, paymentId: pagamento.id, valorCentavos: valor, metodo: 'credit_card' });
    if (b.baixada) { r.baixas++; r.alunosAtualizados.push(b.alunoId); }
  }
  return r;
}

/**
 * Reconciliação ativa (rede de segurança para webhook que não chega): para cada
 * assinatura ainda viva, sincroniza o status e dá baixa nas cobranças aprovadas
 * no MP que ainda não foram processadas. Idempotente — usa a mesma baixarParcela
 * (INSERT OR IGNORE por payment_id), então rodar junto com o webhook não duplica.
 * Devolve { assinaturas, baixas, alunosAtualizados[] }.
 */
async function reconciliarAssinaturas() {
  const resultado = { assinaturas: 0, baixas: 0, alunosAtualizados: [] };
  if (!habilitado()) return resultado;
  const vivas = await db.execute({
    sql: `SELECT id, preapproval_id FROM assinaturas_mp WHERE status IN ('pending', 'authorized', 'paused') ORDER BY criado_em ASC LIMIT 200`,
    args: [], // o cliente do Turso exige `args`, mesmo vazio
  });
  for (const v of vivas.rows) {
    try {
      resultado.assinaturas++;
      const r = await reconciliarUmaAssinatura(v.preapproval_id);
      resultado.baixas += r.baixas;
      resultado.alunosAtualizados.push(...r.alunosAtualizados);
    } catch (err) {
      console.error('[assinaturas] falha ao reconciliar', v.id, err.message);
    }
  }
  return resultado;
}

// Botão "Atualizar status" do painel: sincroniza uma assinatura agora.
async function sincronizarAgora({ assinaturaId }) {
  if (!habilitado()) throw erro('Assinaturas do Mercado Pago estão desligadas (MERCADOPAGO_ASSINATURAS).', 503);
  const a = await buscarPorId(assinaturaId);
  if (!a) throw erro('Assinatura não encontrada.', 404);
  const r = await reconciliarUmaAssinatura(a.preapproval_id);
  const atual = await buscarPorId(assinaturaId);
  return { status: atual.status, baixas: r.baixas, alunosAtualizados: r.alunosAtualizados };
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
    if (mp?.id) {
      const assinaturaAntes = await buscarPorPreapproval(mp.id);
      await atualizarStatus(mp.id, mp.status);
      if (mp.status === 'authorized') {
        if (assinaturaAntes?.modalidade && assinaturaAntes.modalidade !== 'legado') {
          await db.execute({ sql: 'UPDATE matriculas SET renovacao_automatica = 0 WHERE id = ?', args: [assinaturaAntes.matricula_id] });
        }
      } else if (mp.status === 'cancelled' && assinaturaAntes?.status === 'pending') {
        await restaurarCobrancaInicial(assinaturaAntes);
      } else if (mp.status === 'cancelled' && ['authorized', 'paused'].includes(assinaturaAntes?.status) && assinaturaAntes.modalidade && assinaturaAntes.modalidade !== 'legado') {
        // Cancelada do lado do Mercado Pago (ex.: aluno cancelou no app do banco): volta ao plano normal.
        await reverterParaPlanoNormal(assinaturaAntes);
      }
    }
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
    sql: `SELECT s.status, s.valor_centavos, s.valor_cheio_centavos, s.desconto_centavos, s.frequencia_meses, s.modalidade, s.limite_cobrancas, s.cobrancas_processadas, s.data_primeira_cobranca, s.init_point,
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
  const modalidadeConfigurada = o.modalidade && o.modalidade !== 'legado';
  const valorMensal = Number(o.valor_centavos || 0);
  const limiteContratado = o.limite_cobrancas == null ? null : Number(o.limite_cobrancas);
  const resumoCondicao = modalidadeConfigurada
    ? (limiteContratado ? 'Compromisso de ' + limiteContratado + ' cobranças mensais de ' + formatarValorParaDescricao(valorMensal) : 'Cobrança mensal de ' + formatarValorParaDescricao(valorMensal) + ', sem permanência mínima')
    : null;
  const beneficiosModalidade = [
    ...oferta.beneficios.filter((b) => !/cancele quando quiser|sem fidelidade|permanência mínima/i.test(b)),
    resumoCondicao,
  ].filter(Boolean).slice(0, LIMITES.beneficios);
  const faqModalidade = modalidadeConfigurada
    ? [
      { p: 'Quais são as condições?', r: resumoCondicao + '. O valor e a quantidade de cobranças ficam registrados no contrato no momento da adesão.' },
      { p: 'A academia guarda os dados do cartão?', r: 'Não. O cartão é cadastrado diretamente no Mercado Pago.' },
      { p: 'E se o cartão for recusado?', r: 'O Mercado Pago poderá tentar processar novamente. A situação da cobrança será atualizada após a confirmação.' },
    ]
    : oferta.faq;
  return montarOferta(base, oferta, {
    subtitulo: modalidadeConfigurada
      ? 'Plano ' + o.plano_nome + ': ' + resumoCondicao.toLowerCase() + '.'
      : oferta.subtitulo,
    faq: faqModalidade,
    beneficios: beneficiosModalidade,
    aluno: primeiroNome(o.aluno_nome),
    plano: o.plano_nome,
    status: o.status,
    init_point: ['cancelled', 'completed'].includes(o.status) ? null : o.init_point,
    frequencia_meses: Number(o.frequencia_meses),
    modalidade: o.modalidade || 'legado',
    limite_cobrancas: o.limite_cobrancas == null ? null : Number(o.limite_cobrancas),
    cobrancas_processadas: Number(o.cobrancas_processadas || 0),
    total_contratado_centavos: o.limite_cobrancas == null ? null : Number(o.valor_centavos) * Number(o.limite_cobrancas),
    valor_centavos: Number(o.valor_centavos),
    desconto_centavos: desconto,
    // Assinaturas antigas (sem valor cheio gravado) não exibem "de/por".
    valor_cheio_centavos: o.valor_cheio_centavos != null ? Number(o.valor_cheio_centavos) : Number(o.valor_centavos) + desconto,
  });
}

// Matrícula do aluno que pode virar assinatura (ativa + plano recorrente).
async function matriculaElegivel(alunoId) {
  // A oferta migra matrículas ativas de planos com ciclo recorrente (mensal,
  // trimestral, semestral ou anual), independentemente do ciclo tradicional atual.
  const r = await db.execute({
    sql: `SELECT m.id, m.data_inicio, p.nome AS plano_nome, p.valor_centavos
          FROM matriculas m JOIN planos p ON p.id = m.plano_id
          WHERE m.aluno_id = ? AND m.status = 'ativa'
            AND (m.data_fim IS NULL OR m.data_fim >= date('now'))
            AND p.tipo IN (${TIPOS_RECORRENTES.map(() => '?').join(', ')})
            AND NOT EXISTS (SELECT 1 FROM assinaturas_mp s WHERE s.matricula_id = m.id AND s.status = 'completed')
          ORDER BY m.data_inicio DESC LIMIT 1`,
    args: [alunoId, ...TIPOS_RECORRENTES],
  });
  return r.rows[0] || null;
}

function somarMesesISO(dataISO, meses) {
  const [ano, mes, dia] = dataISO.slice(0, 10).split('-').map(Number);
  const alvo = new Date(Date.UTC(ano, mes - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dia, ultimoDia)).padStart(2, '0')}`;
}

// Cobrança automática de NOVO cadastro: a 1ª é feita na hora em que o cartão é cadastrado
// (a matrícula ativa na hora) e as seguintes caem no mesmo dia dos meses seguintes. Não segue
// o dia 10/20 das mensalidades normais — isso só volta a valer se a recorrência for cancelada.
function cronogramaCobrancaAutomatica(hoje = new Date().toISOString().slice(0, 10)) {
  return { primeira_cobranca: hoje, primeira_ao_cadastrar: true, proxima_cobranca: somarMesesISO(hoje, 1) };
}

// Na migração: reaproveita a primeira mensalidade em aberto. Se a competência
// atual já foi quitada, inicia no próximo vencimento mensal; não cria segunda
// cobrança para a mesma competência.
async function prepararCobrancaInicial({ matricula, valorCentavos, modalidade }) {
  const abertas = await db.execute({
    sql: `SELECT id, vencimento, valor_centavos, status FROM cobrancas
          WHERE matricula_id = ? AND status IN ('pendente', 'atrasado')
          ORDER BY vencimento ASC, criado_em ASC`,
    args: [matricula.id],
  });
  const hoje = new Date().toISOString().slice(0, 10);
  let vencimento;
  let cobrancaId;
  let valorAnteriorCentavos = null;
  let statusAnteriorCobranca = null;
  let cobrancaCriada = false;
  if (abertas.rows.length) {
    vencimento = String(abertas.rows[0].vencimento || hoje).slice(0, 10);
    cobrancaId = abertas.rows[0].id;
    valorAnteriorCentavos = Number(abertas.rows[0].valor_centavos);
    statusAnteriorCobranca = abertas.rows[0].status;
    // O valor da conta só muda quando o cartão for aprovado (ver baixarParcela): até lá, quem
    // preferir pagar em Pix continua vendo e pagando o valor original do plano.
  } else {
    const ultima = await db.execute({
      sql: `SELECT vencimento FROM cobrancas WHERE matricula_id = ? AND status = 'pago' ORDER BY vencimento DESC, criado_em DESC LIMIT 1`,
      args: [matricula.id],
    });
    vencimento = ultima.rows[0]?.vencimento
      ? somarMesesISO(String(ultima.rows[0].vencimento), 1)
      : primeiroVencimento(matricula.data_inicio || hoje);
    const existenteNaCompetencia = await db.execute({
      sql: `SELECT id, valor_centavos, status FROM cobrancas WHERE matricula_id = ? AND vencimento = ? AND provedor = 'recorrencia' LIMIT 1`,
      args: [matricula.id, vencimento],
    });
    const descricao = 'Recorrência - ' + String(modalidade || 'mensal');
    if (existenteNaCompetencia.rows[0]) {
      cobrancaId = existenteNaCompetencia.rows[0].id;
      valorAnteriorCentavos = Number(existenteNaCompetencia.rows[0].valor_centavos);
      statusAnteriorCobranca = existenteNaCompetencia.rows[0].status;
      await db.execute({
        sql: `UPDATE cobrancas SET status = 'pendente', descricao = ? WHERE id = ?`,
        args: [descricao, cobrancaId],
      });
    } else {
      cobrancaId = uuid();
      cobrancaCriada = true;
      await db.execute({
        sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, status, provedor, descricao, vencimento)
              VALUES (?, ?, ?, ?, 'pendente', 'recorrencia', ?, ?)`,
        args: [cobrancaId, matricula.aluno_id, matricula.id, Number(matricula.valor_centavos) || valorCentavos, descricao, vencimento],
      });
    }
  }
  return { vencimento, cobrancaId, valorAnteriorCentavos, statusAnteriorCobranca, cobrancaCriada };
}

async function assinaturaAbertaDaMatricula(matriculaId) {
  const r = await db.execute({
    sql: `SELECT id, status, valor_centavos, modalidade FROM assinaturas_mp WHERE matricula_id = ? AND status IN ('pending', 'authorized', 'paused')
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
    opcoes: (await listarPlanosCadastroPublicos({ alunoId })).map((p) => ({
      modalidade: p.id, titulo: p.nome, valor_centavos: p.valor_final_centavos, limite_cobrancas: p.limite_cobrancas,
      total_centavos: p.limite_cobrancas ? p.valor_final_centavos * p.limite_cobrancas : null,
      descricao: p.limite_cobrancas ? `${p.limite_cobrancas} cobranças mensais de ${formatarValorParaDescricao(p.valor_final_centavos)}.` : `${formatarValorParaDescricao(p.valor_final_centavos)} por mês, sem permanência mínima.`,
    })),
    assinatura_pendente: existente ? { id: existente.id, modalidade: existente.modalidade } : null,
  };
}

// Reaproveita assinatura pendente da mesma modalidade. Uma assinatura ativa impede
// criar outra, para não manter duas cobranças automáticas simultâneas.
async function obterOuCriarParaAluno({ alunoId, baseUrl, modalidade, admin = false }) {
  if (typeof modalidade !== 'string' || !modalidade.trim()) throw erro('Escolha uma das modalidades disponíveis.', 400);
  const disp = await disponibilidadeParaAluno({ alunoId, baseUrl });
  if (!disp.disponivel) throw erro('Pagamento automático não está disponível para este aluno.', 409);
  const m = await matriculaElegivel(alunoId);
  const pendente = await assinaturaAbertaDaMatricula(m.id);
  if (pendente && pendente.modalidade === modalidade) {
    return { id: pendente.id, status: 'pending', oferta_url: urlOferta(baseUrl, pendente.id) };
  }
  const planoCadastro = await buscarPlanoCadastro(modalidade, { alunoId, admin }); // valida antes de cancelar a pendente
  if (pendente) await cancelar({ assinaturaId: pendente.id });
  const precoCadastro = precoDaOferta(Number(planoCadastro.valor_centavos), planoCadastro.desconto);
  const ciclo = await prepararCobrancaInicial({ matricula: { ...m, aluno_id: alunoId }, valorCentavos: precoCadastro.valor_centavos, modalidade });
  // Matrícula SEM nenhuma conta paga (aluno criado do zero, ainda não pagou o plano): cobra NA ADESÃO, como no
  // cadastro novo. Só adia a 1ª cobrança para o próximo vencimento quando já existe pagamento nessa matrícula
  // (o ciclo atual já foi pago e o aluno não deve pagar duas vezes).
  const jaPagou = (await db.execute({ sql: `SELECT 1 FROM cobrancas WHERE matricula_id = ? AND status = 'pago' LIMIT 1`, args: [m.id] })).rows.length > 0;
  try {
    const criada = await criarAssinatura({
      matriculaId: m.id, baseUrl, modalidade, dataPrimeiraCobranca: jaPagou ? ciclo.vencimento : null,
      cobrancaInicialId: ciclo.cobrancaId, valorAnteriorCentavos: ciclo.valorAnteriorCentavos,
      statusAnteriorCobranca: ciclo.statusAnteriorCobranca, cobrancaInicialCriada: ciclo.cobrancaCriada,
    });
    return criada;
  } catch (err) {
    if (ciclo.cobrancaCriada) {
      await db.execute({ sql: `UPDATE cobrancas SET status = 'cancelado' WHERE id = ? AND status = 'pendente'`, args: [ciclo.cobrancaId] });
    } else if (ciclo.valorAnteriorCentavos != null) {
      await db.execute({
        sql: `UPDATE cobrancas SET valor_centavos = ?, status = ? WHERE id = ? AND status IN ('pendente','atrasado')`,
        args: [ciclo.valorAnteriorCentavos, ciclo.statusAnteriorCobranca || 'pendente', ciclo.cobrancaId],
      });
    }
    throw err;
  }
}


async function obterOuCriarParaNovoCadastro({alunoId,matriculaId,baseUrl,modalidade}){
 if(!habilitado())throw erro('Pagamento recorrente indisponível no momento.',503);
 const m=await db.execute({sql:"SELECT id FROM matriculas WHERE id=? AND aluno_id=? AND status='pendente'",args:[matriculaId,alunoId]});
 if(!m.rows[0])throw erro('Matrícula pendente não encontrada.',404);
 const q=await db.execute({sql:"SELECT id,provedor_referencia,valor_centavos,vencimento,descricao,provedor FROM cobrancas WHERE matricula_id=? AND status='pendente' ORDER BY criado_em LIMIT 1",args:[matriculaId]});
 const c=q.rows[0];if(!c||c.provedor_referencia)throw erro('O Pix já foi iniciado ou a cobrança não está disponível.',409);
 const pend=await db.execute({sql:"SELECT id,modalidade,status FROM assinaturas_mp WHERE matricula_id=? AND status IN ('pending','authorized','paused') ORDER BY criado_em DESC LIMIT 1",args:[matriculaId]});
 if(pend.rows[0]){if(pend.rows[0].modalidade===modalidade&&pend.rows[0].status==='pending')return{oferta_url:urlOferta(baseUrl,pend.rows[0].id)};throw erro('Já existe uma assinatura aguardando confirmação para esta matrícula.',409);}

 const planoCadastro = await buscarPlanoCadastro(modalidade, { alunoId });
 const preco = precoDaOferta(Number(planoCadastro.valor_centavos), planoCadastro.desconto); const valor=preco.valor_centavos,hoje=new Date().toISOString().slice(0,10);
 // Novo cadastro no cartão: o MP cobra NA HORA em que o cartão é cadastrado (sem start_date). A conta NÃO muda aqui:
 // valor e vencimento só passam para os da modalidade quando a cobrança for aprovada (baixarParcela). Até lá,
 // quem desistir do cartão e pagar em Pix vê e paga o valor original.
 try{const criada=await criarAssinatura({matriculaId,baseUrl,modalidade,dataPrimeiraCobranca:null,cobrancaInicialId:c.id,valorAnteriorCentavos:Number(c.valor_centavos),statusAnteriorCobranca:'pendente',vencimentoAnterior:c.vencimento||null,permitirMatriculaPendente:true});return{oferta_url:criada.oferta_url};}
 catch(e){throw e;}
}

module.exports = {
  habilitado, criarAssinatura, listar, cancelar, processarEvento, processarPagamentoAprovado,
  ofertaPublica, disponibilidadeParaAluno, obterOuCriarParaAluno, obterOuCriarParaNovoCadastro, baseUrlDaRequisicao, urlOferta,
  obterOferta, salvarOferta, calcularDescontoCentavos, OFERTA_PADRAO,
  obterPlanosCadastro, salvarPlanosCadastro, listarPlanosCadastroPublicos, buscarPlanoCadastro, expirarCheckoutsAbandonados, reconciliarAssinaturas, sincronizarAgora, cronogramaCobrancaAutomatica, cancelarPendentesDasMatriculas, anexarRecorrencia,
};
