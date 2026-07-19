/**
 * E-mail padrão de boas-vindas (2026-07 — feature de captação/retenção, ver
 * conversa "vamos adicionar uma nova função"). Disparado automaticamente
 * sempre que um cadastro novo é criado COM e-mail (painel admin, portal
 * remoto ou auto-cadastro/indicação de visitante pelo totem) — contém o link
 * do Portal do Aluno e a senha de acesso, pra ele conseguir entrar e fazer o
 * cadastro facial por conta própria caso ainda não tenha feito (a maioria dos
 * alunos ainda não tem, por estarmos em fase de teste do reconhecimento
 * facial — ver também POST /api/recuperacao/enviar com aluno_ids vindos de
 * GET /api/recuperacao/todos-ativos, pra reenviar esse mesmo convite em massa
 * quando for útil).
 *
 * Deliberadamente DESACOPLADO da tabela mensagens_templates: mesmo que o
 * admin edite/apague o modelo "Boas-vindas" usado no envio em massa, o e-mail
 * automático do cadastro continua funcionando do jeito certo. Existe também
 * um modelo seed com o mesmo conteúdo (ver ALTERACOES_INCREMENTAIS /
 * seedMensagensTemplates em migrate.js) só pra já vir pronto no composer.
 */

const { v4: uuid } = require('uuid');
const db = require('../db/client');
const acessoTerminal = require('./acessoTerminal.service');
const emailService = require('./email.service');

const ASSUNTO_BOAS_VINDAS = 'Bem-vindo(a) à Academia Superação!';

function primeiroNome(nomeCompleto) {
  return String(nomeCompleto || '').trim().split(/\s+/)[0] || nomeCompleto;
}

function obterAppUrl() {
  const valor = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return valor || null;
}

function montarMensagemBoasVindas({ nome, senha, linkPortal }) {
  const linhas = [
    `Olá ${primeiroNome(nome)}! Seja bem-vindo(a) à Academia Superação.`,
    '',
    'Para acompanhar seus dados, treinos e contas pelo celular, acesse o Portal do Aluno:',
    linkPortal || 'Peça o link do Portal do Aluno na recepção.',
    '',
    `Sua senha de acesso ao portal é: ${senha}`,
    '',
    'Se você ainda não fez o cadastro facial na academia (pra liberar a catraca automaticamente, sem precisar digitar nada), aproveite para fazer pelo próprio Portal do Aluno — é rápido!',
  ];
  return linhas.join('\n');
}

/**
 * Monta e envia o e-mail de boas-vindas para UM aluno específico. Lança erro
 * se não for possível (sem e-mail configurado no servidor, Gmail recusando,
 * etc.) — quem chama decide se trata isso como best-effort (ver
 * enviarBoasVindasSeguro abaixo) ou não.
 */
async function enviarBoasVindas({ id, nome, email }) {
  if (!email) throw new Error('Aluno sem e-mail cadastrado.');
  if (!emailService.emailConfigurado()) throw new Error('Envio de e-mail não configurado no servidor.');

  const senha = await acessoTerminal.atribuirCodigoAluno(id);
  const appUrl = obterAppUrl();
  const linkPortal = appUrl ? `${appUrl}/portal.html` : null;
  const mensagem = montarMensagemBoasVindas({ nome, senha, linkPortal });

  await emailService.enviarEmail({ para: email, assunto: ASSUNTO_BOAS_VINDAS, texto: mensagem });
  await db.execute({
    sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, assunto, mensagem, destino, status)
          VALUES (?, ?, 'email', ?, ?, ?, 'enviado')`,
    args: [uuid(), id, ASSUNTO_BOAS_VINDAS, mensagem, email],
  });
}

/**
 * Versão "nunca lança" — usada nos pontos de cadastro (alunos.routes.js,
 * portal.routes.js, terminal.routes.js) pra nunca atrasar/quebrar a resposta
 * do cadastro em si por causa de um problema no envio de e-mail. Se falhar,
 * fica registrado em mensagens_enviadas com status='erro' (aparece no
 * Histórico da Recuperação de Clientes) — o admin pode notar e reenviar
 * manualmente depois (aba "Todos os ativos").
 */
async function enviarBoasVindasSeguro(aluno) {
  try {
    await enviarBoasVindas(aluno);
  } catch (err) {
    try {
      await db.execute({
        sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, assunto, mensagem, destino, status, erro)
              VALUES (?, ?, 'email', ?, '', ?, 'erro', ?)`,
        args: [uuid(), aluno.id, ASSUNTO_BOAS_VINDAS, aluno.email || null, err.message],
      });
    } catch {
      // Se nem o log conseguir gravar (ex.: Turso indisponível no exato
      // momento), não há mais nada de seguro a fazer aqui — best-effort de
      // verdade. O cadastro em si (quem chamou) já seguiu seu caminho normal.
    }
  }
}

module.exports = {
  ASSUNTO_BOAS_VINDAS,
  montarMensagemBoasVindas,
  enviarBoasVindas,
  enviarBoasVindasSeguro,
};
