const express = require('express');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar, apenasAdmin } = require('../middleware/auth');

const router = express.Router();

// Chaves válidas de menu, na ordem padrão de fábrica — usada como fallback
// quando nenhuma ordem customizada foi salva ainda, e para validar que o
// admin não mande nada estranho (chave inventada, item repetido/faltando).
const CHAVES_MENU_PADRAO = ['alunos', 'planos', 'agenda', 'pagamentos', 'pagamento-rapido', 'relatorios', 'usuarios', 'config', 'catraca'];

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
};

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
    });
    const dados = schema.parse(req.body);
    const chaves = Object.keys(dados);
    if (chaves.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    for (const chave of chaves) {
      const valor = (chave === 'menu_ordem' || chave === 'som_totem') ? JSON.stringify(dados[chave]) : dados[chave];
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
const TABELAS_BACKUP = [
  'alunos', 'anamneses', 'avaliacoes_fisicas', 'planos', 'matriculas', 'turmas',
  'agendamentos', 'checkins', 'cobrancas', 'pagamentos_cobranca', 'acessos_catraca', 'configuracoes',
];

async function gerarBackupCompleto() {
  const dump = { gerado_em: new Date().toISOString(), tabelas: {} };
  for (const tabela of TABELAS_BACKUP) {
    const result = await db.execute(`SELECT * FROM ${tabela}`);
    dump.tabelas[tabela] = result.rows;
  }
  // usuarios entra sem o hash da senha — backup não deve carregar credenciais
  const usuarios = await db.execute('SELECT id, nome, email, papel, criado_em FROM usuarios');
  dump.tabelas.usuarios = usuarios.rows;
  return dump;
}

// GET /api/config/backup — gera e baixa um backup completo agora (admin)
router.get('/backup', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const dump = await gerarBackupCompleto();
    const nomeArquivo = `backup-academia-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(JSON.stringify(dump, null, 2));
  } catch (err) {
    next(err);
  }
});

module.exports = { router, gerarBackupCompleto };
