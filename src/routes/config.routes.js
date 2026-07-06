const express = require('express');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar, apenasAdmin } = require('../middleware/auth');

const router = express.Router();

// Chaves válidas de menu, na ordem padrão de fábrica — usada como fallback
// quando nenhuma ordem customizada foi salva ainda, e para validar que o
// admin não mande nada estranho (chave inventada, item repetido/faltando).
const CHAVES_MENU_PADRAO = ['alunos', 'planos', 'agenda', 'pagamentos', 'relatorios', 'usuarios', 'config', 'catraca'];

const PADROES = {
  nome_app: 'Academia Gestão',
  licenciado_para: '',
  menu_ordem: CHAVES_MENU_PADRAO,
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

    res.json(config);
  } catch (err) {
    next(err);
  }
});

// PUT /api/config { nome_app?, licenciado_para?, menu_ordem? } — só admin
router.put('/', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      nome_app: z.string().trim().min(1).optional(),
      licenciado_para: z.string().trim().optional(),
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
    });
    const dados = schema.parse(req.body);
    const chaves = Object.keys(dados);
    if (chaves.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    for (const chave of chaves) {
      const valor = chave === 'menu_ordem' ? JSON.stringify(dados[chave]) : dados[chave];
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
