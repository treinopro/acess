/**
 * Envio de e-mail via Gmail SMTP + Senha de App (2026-07 — feature de
 * recuperação de clientes, ver src/routes/recuperacao.routes.js).
 *
 * Configuração (variáveis de ambiente, .env local / Northflank em produção):
 *   GMAIL_USER            e-mail da conta Gmail que vai disparar as mensagens
 *                          (ex: academiasuperacao01@gmail.com)
 *   GMAIL_APP_PASSWORD    Senha de App gerada em myaccount.google.com/apppasswords
 *                          (16 caracteres, SEM espaços) — NÃO é a senha normal
 *                          da conta Google, e só funciona com verificação em
 *                          duas etapas ativada na conta.
 *   GMAIL_FROM_NOME        (opcional) nome de exibição do remetente — default
 *                          "Academia Superação"
 *
 * Se as variáveis não estiverem configuradas, enviarEmail() lança um erro
 * claro em vez de falhar silenciosamente — quem chama (recuperacao.routes.js)
 * captura isso por aluno e devolve o motivo no resultado do envio em lote, sem
 * derrubar o restante do lote.
 */

let nodemailer;
try {
  // eslint-disable-next-line global-require
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

let transporterCache = null;

// Tira espaços/quebras de linha acidentais nas pontas (ex.: copiar/colar no painel
// do Northflank às vezes deixa um espaço a mais) — o Gmail rejeita a senha de app
// com "Invalid login: 535-5.7.8" se ela chegar com qualquer caractere estranho.
function limparVariavelAmbiente(valor) {
  return typeof valor === 'string' ? valor.trim() : valor;
}

function gmailUser() {
  return limparVariavelAmbiente(process.env.GMAIL_USER);
}

function gmailSenhaApp() {
  // A Senha de App do Google costuma ser exibida em 4 blocos de 4 ("abcd efgh
  // ijkl mnop") — o Gmail aceita com ou sem esses espaços do meio, mas tiramos
  // todos por segurança (espaço nenhum é parte da senha de verdade).
  const valor = limparVariavelAmbiente(process.env.GMAIL_APP_PASSWORD);
  return typeof valor === 'string' ? valor.replace(/\s+/g, '') : valor;
}

function emailConfigurado() {
  return Boolean(gmailUser() && gmailSenhaApp());
}

function obterTransporter() {
  if (!nodemailer) {
    throw new Error('Dependência "nodemailer" não instalada no servidor. Rode `npm install` no projeto e faça o redeploy.');
  }
  if (!emailConfigurado()) {
    throw new Error('Envio de e-mail não configurado: defina GMAIL_USER e GMAIL_APP_PASSWORD nas variáveis de ambiente (.env local / Northflank em produção).');
  }
  if (!transporterCache) {
    transporterCache = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser(),
        pass: gmailSenhaApp(),
      },
    });
  }
  return transporterCache;
}

async function enviarEmail({
  para, assunto, texto, html,
}) {
  const transporter = obterTransporter();
  const nomeRemetente = limparVariavelAmbiente(process.env.GMAIL_FROM_NOME) || 'Academia Superação';
  await transporter.sendMail({
    from: `"${nomeRemetente}" <${gmailUser()}>`,
    to: para,
    subject: assunto,
    text: texto,
    html: html || undefined,
  });
}

module.exports = { enviarEmail, emailConfigurado };
