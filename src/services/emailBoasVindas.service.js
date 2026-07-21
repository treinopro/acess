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

// ---------------------------------------------------------------------------
// E-mail de boas-vindas do VISITANTE (2026-07-19) — deliberadamente diferente
// do e-mail normal acima:
//
//  - NUNCA chama atribuirCodigoAluno/gera biometria_id: essa "senha" só faz
//    sentido pareada com um cadastro físico de verdade na catraca (cartão ou
//    digital cadastrados no leitor Henry, "sistema antigo") — o visitante
//    nunca passa por esse cadastro, então gerar e mandar esse código pra ele
//    é enganoso (parece um login válido pro Portal do Aluno, mas não abre
//    nada de fato). Hoje ainda não existe uma função pra cadastrar biometria
//    direto do nosso sistema na catraca — ver observação no README do
//    agente-local; enquanto isso não existir, visitante não recebe esse código.
//  - O link enviado é o de "Meu Acesso" (garantirCodigoAcesso/meu-acesso.html),
//    que é DIRETO — sem CPF nem senha, só o código aleatório na própria URL
//    (enviado por e-mail privado à pessoa, sem risco prático de outra pessoa
//    usar o CPF dela pra adivinhar esse link). Mesmo QR que já aparece na tela
//    do totem ao concluir o cadastro — o e-mail só serve de backup/lembrete.
// ---------------------------------------------------------------------------
const ASSUNTO_BOAS_VINDAS_VISITANTE = 'Seu acesso de visitante — Academia Superação!';

function montarMensagemBoasVindasVisitante({ nome, linkAcesso, dias }) {
  const linhas = [
    `Olá ${primeiroNome(nome)}! Que bom te receber na Academia Superação.`,
    '',
    `Seu acesso gratuito de visitante vale por ${dias} dia${dias === 1 ? '' : 's'} a partir da sua primeira entrada.`,
    'Guarde o link abaixo — ele mostra o QR code que você usa na catraca, sem precisar de senha:',
    linkAcesso || 'Peça o QR de acesso na recepção.',
    '',
    'Depois que o período gratuito acabar, procure a recepção para conhecer nossos planos e continuar treinando com a gente!',
  ];
  return linhas.join('\n');
}

async function enviarBoasVindasVisitante({ id, nome, email }) {
  if (!email) throw new Error('Visitante sem e-mail cadastrado.');
  if (!emailService.emailConfigurado()) throw new Error('Envio de e-mail não configurado no servidor.');

  const codigo = await acessoTerminal.garantirCodigoAcesso(id);
  const appUrl = obterAppUrl();
  const linkAcesso = appUrl ? `${appUrl}/meu-acesso.html?codigo=${codigo}` : null;
  const dias = await acessoTerminal.limiteDiasVisitanteEm(db);
  const mensagem = montarMensagemBoasVindasVisitante({ nome, linkAcesso, dias });

  await emailService.enviarEmail({ para: email, assunto: ASSUNTO_BOAS_VINDAS_VISITANTE, texto: mensagem });
  await db.execute({
    sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, assunto, mensagem, destino, status)
          VALUES (?, ?, 'email', ?, ?, ?, 'enviado')`,
    args: [uuid(), id, ASSUNTO_BOAS_VINDAS_VISITANTE, mensagem, email],
  });
}

async function enviarBoasVindasVisitanteSeguro(aluno) {
  try {
    await enviarBoasVindasVisitante(aluno);
  } catch (err) {
    try {
      await db.execute({
        sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, assunto, mensagem, destino, status, erro)
              VALUES (?, ?, 'email', ?, '', ?, 'erro', ?)`,
        args: [uuid(), aluno.id, ASSUNTO_BOAS_VINDAS_VISITANTE, aluno.email || null, err.message],
      });
    } catch {
      // Best-effort de verdade, ver comentário em enviarBoasVindasSeguro.
    }
  }
}

module.exports = {
  ASSUNTO_BOAS_VINDAS,
  montarMensagemBoasVindas,
  enviarBoasVindas,
  enviarBoasVindasSeguro,
  ASSUNTO_BOAS_VINDAS_VISITANTE,
  montarMensagemBoasVindasVisitante,
  enviarBoasVindasVisitante,
  enviarBoasVindasVisitanteSeguro,
};
