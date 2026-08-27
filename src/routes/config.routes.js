const express = require('express');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar, apenasAdmin } = require('../middleware/auth');

const router = express.Router();

// Chaves válidas de menu, na ordem padrão de fábrica — usada como fallback
// quando nenhuma ordem customizada foi salva ainda, e para validar que o
// admin não mande nada estranho (chave inventada, item repetido/faltando).
const CHAVES_MENU_PADRAO = ['alunos', 'planos', 'produtos-servicos', 'pendencias', 'agenda', 'pagamentos', 'contas-pagar', 'pagamento-rapido', 'relatorios', 'recuperacao', 'usuarios', 'config', 'catraca'];

const PADROES = {
  nome_app: 'Academia Gestão',
  licenciado_para: '',
  menu_ordem: CHAVES_MENU_PADRAO,
  // Link do app externo de treino, mostrado pro aluno cujo treino_modo =
  // 'app_externo' (perfil, totem, portal remoto). Vínculo com o app acontece
  // lá mesmo, por CPF ou e-mail, no primeiro acesso do aluno.
  treino_app_url: '',
  // Número de WhatsApp da recepção (só dígitos, com DDI+DDD, ex: 5599999999999)
  // usado pelo portal remoto pra montar o link "Agendar avaliação" (wa.me) —
  // enquanto não existe um disparo automático de WhatsApp (ver configuração
  // de aviso de cobrança, ainda não implementada), isso já dá um jeito simples
  // do aluno pedir o agendamento sem precisar ligar.
  whatsapp_contato: '',
  // Aviso sonoro do totem (2026-07) — ver src/services/acessoTerminal.service.js
  // (primeiro_acesso_hoje) e public/terminal.js (tocarAvisoSonoro). Cada
  // situação tem: tipo ('voz' | 'beep' | 'nenhum'), texto (só usado se
  // tipo='voz') e beeps (só usado se tipo='beep', 1 a 5). Fica como objeto
  // (não string) igual menu_ordem, pelo mesmo motivo: só vira string quando
  // volta do banco.
  som_totem: {
    primeiroAcesso: { tipo: 'voz', texto: 'Bom treino!' },
    acessoLiberado: { tipo: 'beep', beeps: 1, texto: 'Acesso liberado' },
    acessoNegado: { tipo: 'beep', beeps: 2, texto: 'Acesso negado' },
  },
  // Sistema de visitantes (2026-07) — ver acessoTerminal.service.js e
  // terminal.routes.js. Guardados como string (igual todo o resto desta
  // tabela chave/valor) mas sempre números inteiros ≥ 0 na prática.
  //
  // 2026-07-19: o limite do visitante deixou de ser contado por NÚMERO DE
  // ACESSOS (visitante_limite_acessos, removida) e passou a ser por DIAS
  // CORRIDOS a partir da primeira liberação (visitante_liberado_em, ver
  // schema.sql) — motivo: um visitante limitado a "1 acesso" não conseguia
  // nem sair e voltar a entrar no mesmo dia (ex.: foi buscar algo no carro).
  visitante_limite_dias: '1',
  indicacao_limite_mensal: '2',
};

// Backup automático (ver src/jobs/backup.js) — destino padrão e agendamento
// configuráveis pelo admin (Configurações > Backup). Guardado na mesma tabela
// `configuracoes` só que por endpoints PRÓPRIOS aqui embaixo (não misturado
// no PADROES/GET /api/config acima), pelo mesmo motivo do saldo inicial em
// contasPagar.routes.js: GET /api/config é PÚBLICO de propósito (tela de
// login precisa dele antes de autenticar) — não dava pra expor o e-mail de
// destino do backup ali.
//
// `backup_destino`: 'local' (só salva em disco no servidor, comportamento de
// sempre), 'email' (manda o dump como anexo pro e-mail configurado, via
// Gmail SMTP já usado em Recuperação de Clientes) ou 'ambos'.
// `backup_email_destino` vazio cai no próprio GMAIL_USER (manda pra si
// mesmo). `backup_agendamento_hora` é 'HH:MM' (hora local do servidor);
// `backup_agendamento_dia_semana` (0=domingo..6=sábado) só é usado quando a
// frequência é 'semanal'.
const PADROES_BACKUP = {
  backup_destino: 'local',
  backup_email_destino: '',
  backup_agendamento_frequencia: 'diario',
  backup_agendamento_hora: '03:00',
  backup_agendamento_dia_semana: '0',
};
const CHAVES_BACKUP = Object.keys(PADROES_BACKUP);

// Tempo mínimo entre DUAS liberações da MESMA pessoa (2026-08-13 — antes era
// só um valor fixo pra reconhecimento facial, via env COOLDOWN_LIBERACAO_
// FACIAL_MS; agora configurável pelo painel, e cobre biometria da catraca
// também, que nunca teve cooldown nenhum — ver acessoTerminal.service.js e
// agente-local/agente.js). Guardado em segundos (mais natural pro admin
// digitar do que milissegundos).
const PADROES_COOLDOWN = {
  cooldown_facial_segundos: '6',
  cooldown_biometria_segundos: '6',
};
const CHAVES_COOLDOWN = Object.keys(PADROES_COOLDOWN);

// GET /api/config — pública de propósito: a tela de login precisa mostrar o
// nome do app e o "licenciado para" ANTES do usuário estar autenticado.
// Não expõe nada sensível, só as strings de marca/identidade visual e a
// ordem do menu (também usada antes do login, pra a barra lateral nascer
// já na ordem certa em vez de "pular" depois de carregar).
router.get('/', async (req, res, next) => {
  try {
    const result = await db.execute('SELECT chave, valor FROM configuracoes');
    const config = { ...PADROES };
    result.rows.forEach((row) => { config[row.chave] = row.valor; });

    if (typeof config.menu_ordem === 'string') {
      try {
        const lista = JSON.parse(config.menu_ordem);
        config.menu_ordem = Array.isArray(lista) && lista.length ? lista : CHAVES_MENU_PADRAO;
      } catch {
        config.menu_ordem = CHAVES_MENU_PADRAO;
      }
    }
    // Auto-cura (2026-07): se uma ordem customizada foi salva ANTES de um menu
    // novo existir (ex.: "Recuperação de Clientes" foi adicionado depois e o
    // admin já tinha reordenado o menu antes disso), a lista salva no banco
    // fica sem essa chave nova pra sempre — e como o item nem aparece na
    // ferramenta de reordenar, o admin não tem como consertar sozinho. Aqui a
    // gente detecta chave nova ausente e simplesmente acrescenta no fim,
    // silenciosamente, sem exigir "resetar tudo". O oposto (chave removida do
    // sistema) também é filtrado, pelo mesmo motivo de nunca travar a UI.
    const chavesValidas = new Set(CHAVES_MENU_PADRAO);
    const presentes = new Set(config.menu_ordem);
    config.menu_ordem = config.menu_ordem.filter((chave) => chavesValidas.has(chave));
    CHAVES_MENU_PADRAO.forEach((chave) => {
      if (!presentes.has(chave)) config.menu_ordem.push(chave);
    });

    if (typeof config.som_totem === 'string') {
      try {
        const somSalvo = JSON.parse(config.som_totem);
        config.som_totem = somSalvo && typeof somSalvo === 'object' ? somSalvo : PADROES.som_totem;
      } catch {
        config.som_totem = PADROES.som_totem;
      }
    }

    res.json(config);
  } catch (err) {
    next(err);
  }
});

// Cada situação do aviso sonoro do totem: tipo obrigatório, texto/beeps
// opcionais (só fazem sentido conforme o tipo, mas não custa aceitar os dois
// sempre — o front decide qual mostrar/usar).
const SomSituacaoSchema = z.object({
  tipo: z.enum(['voz', 'beep', 'nenhum']),
  texto: z.string().trim().max(200).optional(),
  beeps: z.number().int().min(1).max(5).optional(),
});

// PUT /api/config { nome_app?, licenciado_para?, menu_ordem?, som_totem? } — só admin
router.put('/', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      nome_app: z.string().trim().min(1).optional(),
      licenciado_para: z.string().trim().optional(),
      treino_app_url: z.string().trim().optional(),
      whatsapp_contato: z.string().trim().optional(),
      // Precisa conter exatamente as mesmas chaves de menu que já existem,
      // só que em outra ordem — evita salvar uma lista quebrada (item
      // duplicado, faltando, ou inventado) que deixaria a barra lateral bugada.
      menu_ordem: z.array(z.string()).refine(
        (lista) => {
          const recebidas = [...lista].sort().join(',');
          const esperadas = [...CHAVES_MENU_PADRAO].sort().join(',');
          return recebidas === esperadas;
        },
        { message: 'Lista de menus inválida (itens faltando, duplicados ou desconhecidos).' },
      ).optional(),
      som_totem: z.object({
        primeiroAcesso: SomSituacaoSchema,
        acessoLiberado: SomSituacaoSchema,
        acessoNegado: SomSituacaoSchema,
      }).optional(),
      // Sistema de visitantes (2026-07): quantos DIAS corridos de acesso
      // grátis cada visitante tem (a partir da primeira liberação) antes de
      // precisar virar aluno pagante, e quantos amigos cada aluno pode
      // indicar (cadastrar como visitante) por mês. Ver
      // acessoTerminal.service.js / terminal.routes.js.
      visitante_limite_dias: z.number().int().min(0).max(90).optional(),
      indicacao_limite_mensal: z.number().int().min(0).max(50).optional(),
    });
    const dados = schema.parse(req.body);
    const chaves = Object.keys(dados);
    if (chaves.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    for (const chave of chaves) {
      let valor = (chave === 'menu_ordem' || chave === 'som_totem') ? JSON.stringify(dados[chave]) : dados[chave];
      if (chave === 'visitante_limite_dias' || chave === 'indicacao_limite_mensal') valor = String(valor);
      await db.execute({
        sql: 'INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
        args: [chave, valor],
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- Backup completo do banco (JSON) ----------------
// Gera um dump de todas as tabelas relevantes. Usado tanto pelo job agendado
// (src/jobs/backup.js, salva local no servidor) quanto por este endpoint
// (baixado direto pelo admin — mais confiável, porque não depende do disco
// do servidor continuar existindo entre deploys).
// 2026-08-27: lista estava desatualizada desde antes do módulo de treinos
// existir — 18 das 31 tabelas do schema.sql nunca entravam em NENHUM backup
// (nem manual nem agendado), incluindo treinos/treino_exercicios/
// treino_execucoes, biblioteca de exercícios, produtos/serviços e vendas,
// concessões de acesso, avaliação física em pipeline e mensagens. Achado ao
// investigar uma restauração de emergência (bloqueio de leitura do Turso) e
// perceber que o backup de e-mail mais recente não tinha essas tabelas.
// Preferi listar tudo explicitamente (em vez de "SELECT name FROM
// sqlite_master" dinâmico) pra manter o comportamento previsível e o mesmo
// padrão do resto do arquivo — só not exportar de propósito: `usuarios`
// (tratada à parte abaixo, sem o hash da senha) e `pagamentos_totem` (dados
// de pagamento em trânsito do gateway, não é preciso reconstruir histórico).
const TABELAS_BACKUP = [
  'alunos', 'anamneses', 'anamnese_perguntas', 'anamnese_respostas', 'avaliacoes_fisicas', 'avaliacao_pipeline',
  'planos', 'matriculas', 'turmas', 'agendamentos', 'checkins', 'cobrancas', 'pagamentos_cobranca', 'contas_pagar',
  'acessos_catraca', 'configuracoes', 'concessoes_acesso', 'banners_portal', 'produtos_servicos',
  'vendas_produtos_servicos', 'exercicio_biblioteca', 'treinos', 'treino_exercicios', 'treino_execucoes',
  'treino_templates', 'treino_template_exercicios', 'mensagens_templates', 'mensagens_agendadas',
  'mensagens_enviadas', 'push_subscriptions',
];

// Tamanho do lote de leitura por tabela — evita carregar uma tabela inteira
// de uma vez na memória (2026-08-12: acessos_catraca, com meses de histórico
// do totem/catraca, já tinha crescido a ponto do dump completo em memória +
// o JSON.stringify(..., null, 2) do resultado — os dois ao mesmo tempo —
// contribuírem pra estourar o limite de memória do serviço bem no boot, já
// que o backup automático roda incondicionalmente a cada subida do processo
// (ver rodarBackup() em src/jobs/backup.js). Escrever direto num stream,
// tabela por tabela e em lotes, mantém só um punhado de linhas na memória por
// vez em vez do banco inteiro + a string JSON inteira simultaneamente.
const TAMANHO_LOTE_BACKUP = 500;

/** Escreve um chunk no stream e só resolve depois do 'drain' se o buffer interno estiver cheio — evita acumular tudo em memória se o disco/rede for mais lento que a geração dos dados. */
function escreverNoStream(writable, chunk) {
  return new Promise((resolve, reject) => {
    const coube = writable.write(chunk, (err) => { if (err) reject(err); });
    if (coube) resolve();
    else writable.once('drain', resolve);
  });
}

/**
 * Monta o mesmo JSON de sempre ({ gerado_em, tabelas: { ... } }), só que
 * escrevendo direto no `writable` conforme cada lote é lido do banco, nunca
 * guardando o dump inteiro nem o texto final inteiro na memória.
 */
async function escreverBackupStream(writable) {
  await escreverNoStream(writable, `{"gerado_em":${JSON.stringify(new Date().toISOString())},"tabelas":{`);

  // usuarios entra sem o hash da senha — backup não deve carregar credenciais
  const tabelas = [
    ...TABELAS_BACKUP.map((nome) => ({ nome, sql: `SELECT * FROM ${nome}` })),
    { nome: 'usuarios', sql: 'SELECT id, nome, email, papel, criado_em FROM usuarios' },
  ];

  for (let i = 0; i < tabelas.length; i++) {
    const { nome, sql } = tabelas[i];
    await escreverNoStream(writable, `${i > 0 ? ',' : ''}${JSON.stringify(nome)}:[`);

    let offset = 0;
    let primeiraLinha = true;
    for (;;) {
      const result = await db.execute({ sql: `${sql} LIMIT ? OFFSET ?`, args: [TAMANHO_LOTE_BACKUP, offset] });
      for (const row of result.rows) {
        await escreverNoStream(writable, `${primeiraLinha ? '' : ','}${JSON.stringify(row)}`);
        primeiraLinha = false;
      }
      if (result.rows.length < TAMANHO_LOTE_BACKUP) break;
      offset += TAMANHO_LOTE_BACKUP;
    }
    await escreverNoStream(writable, ']');
  }

  await escreverNoStream(writable, '}}');
}

// GET /api/config/backup — gera e baixa um backup completo agora (admin).
// Escreve direto na resposta HTTP (que já é um stream) em vez de montar o
// JSON inteiro em memória primeiro — ver escreverBackupStream acima.
router.get('/backup', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const nomeArquivo = `backup-academia-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    await escreverBackupStream(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// ---------------- Configuração do backup automático (destino + agendamento) ----------------

// GET /api/config/backup-config — admin only (ver comentário de PADROES_BACKUP acima)
router.get('/backup-config', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT chave, valor FROM configuracoes WHERE chave IN (?, ?, ?, ?, ?)',
      args: CHAVES_BACKUP,
    });
    const config = { ...PADROES_BACKUP };
    result.rows.forEach((row) => { config[row.chave] = row.valor; });
    res.json(config);
  } catch (err) {
    next(err);
  }
});

const BackupConfigSchema = z.object({
  backup_destino: z.enum(['local', 'email', 'ambos']).optional(),
  backup_email_destino: z.string().trim().email().optional().or(z.literal('')),
  backup_agendamento_frequencia: z.enum(['diario', 'semanal', 'desativado']).optional(),
  backup_agendamento_hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido (use HH:MM).').optional(),
  backup_agendamento_dia_semana: z.number().int().min(0).max(6).optional(),
});

// PUT /api/config/backup-config — admin only
router.put('/backup-config', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const dados = BackupConfigSchema.parse(req.body);
    const chaves = Object.keys(dados);
    if (chaves.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    for (const chave of chaves) {
      const valor = String(dados[chave]);
      await db.execute({
        sql: 'INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
        args: [chave, valor],
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- Cooldown de acesso (tempo mínimo entre liberações da mesma pessoa) ----------------

// GET /api/config/cooldown-acesso — admin only (ver comentário de PADROES_COOLDOWN acima)
router.get('/cooldown-acesso', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const config = await obterCooldownAcesso();
    res.json(config);
  } catch (err) {
    next(err);
  }
});

const CooldownConfigSchema = z.object({
  cooldown_facial_segundos: z.number().int().min(0).max(300).optional(),
  cooldown_biometria_segundos: z.number().int().min(0).max(300).optional(),
});

// PUT /api/config/cooldown-acesso — admin only
router.put('/cooldown-acesso', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const dados = CooldownConfigSchema.parse(req.body);
    const chaves = Object.keys(dados);
    if (chaves.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    for (const chave of chaves) {
      const valor = String(dados[chave]);
      await db.execute({
        sql: 'INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
        args: [chave, valor],
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Lê o cooldown configurado (em segundos, já convertido pra ms) — usado por
 * acessoTerminal.service.js (facial, checado a cada tentativa) e por
 * terminal.routes.js (embutido na resposta de /cache-autorizacao, pro agente
 * local aplicar o cooldown de biometria sozinho, sem round-trip de rede a
 * cada leitura — ver agente-local/agente.js e cacheAutorizacao.js).
 */
async function obterCooldownAcesso() {
  const result = await db.execute({
    sql: `SELECT chave, valor FROM configuracoes WHERE chave IN (${CHAVES_COOLDOWN.map(() => '?').join(',')})`,
    args: CHAVES_COOLDOWN,
  });
  const config = { ...PADROES_COOLDOWN };
  result.rows.forEach((row) => { config[row.chave] = row.valor; });
  return {
    cooldown_facial_segundos: Number(config.cooldown_facial_segundos),
    cooldown_biometria_segundos: Number(config.cooldown_biometria_segundos),
  };
}

module.exports = { router, escreverBackupStream, obterCooldownAcesso };
