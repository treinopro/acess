const express = require('express');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar, apenasAdmin } = require('../middleware/auth');

const router = express.Router();

const PADROES = {
  nome_app: 'Academia Gestão',
  licenciado_para: '',
};

// GET /api/config — pública de propósito: a tela de login precisa mostrar o
// nome do app e o "licenciado para" ANTES do usuário estar autenticado.
// Não expõe nada sensível, só as strings de marca/identidade visual.
router.get('/', async (req, res, next) => {
  try {
    const result = await db.execute('SELECT chave, valor FROM configuracoes');
    const config = { ...PADROES };
    result.rows.forEach((row) => { config[row.chave] = row.valor; });
    res.json(config);
  } catch (err) {
    next(err);
  }
});

// PUT /api/config { nome_app?, licenciado_para? } — só admin
router.put('/', autenticar, apenasAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      nome_app: z.string().trim().min(1).optional(),
      licenciado_para: z.string().trim().optional(),
    });
    const dados = schema.parse(req.body);
    const chaves = Object.keys(dados);
    if (chaves.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    for (const chave of chaves) {
      await db.execute({
        sql: 'INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
        args: [chave, dados[chave]],
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
