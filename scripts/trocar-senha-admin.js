// Troca a senha de um usuário do painel (por padrão, o admin), gerando uma
// senha nova aleatória (ou usando uma que você passar) e gravando o hash no
// banco configurado em DATABASE_URL/.env — o mesmo banco usado pelo app (em
// produção, o Turso).
//
// Como rodar (a partir da pasta academia-gestao):
//   node scripts/trocar-senha-admin.js
//     -> troca a senha de admin@academia.com por uma senha nova, gerada
//        aleatoriamente, e imprime ela na tela (única vez que ela aparece —
//        anote/guarde num gerenciador de senhas antes de fechar o terminal).
//
//   node scripts/trocar-senha-admin.js --email=outro@exemplo.com
//     -> troca a senha de outro usuário em vez do admin padrão.
//
//   node scripts/trocar-senha-admin.js --senha="MinhaSenhaForte123!"
//     -> define uma senha específica em vez de gerar uma aleatória.
//
// Efeito: só troca a senha. Não mexe em nada mais (e-mail, papel, etc.) nem
// invalida sessões já abertas de OUTROS usuários — só quem usava esta senha
// precisa logar de novo.

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../src/db/client');

function lerArgumento(nome, padrao) {
  const prefixo = `--${nome}=`;
  const encontrado = process.argv.find((a) => a.startsWith(prefixo));
  return encontrado ? encontrado.slice(prefixo.length) : padrao;
}

function gerarSenhaAleatoria() {
  // 18 caracteres, alfanumérico + alguns símbolos — forte o bastante e ainda
  // razoável de digitar/copiar manualmente se precisar.
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(18);
  return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('');
}

async function main() {
  const email = lerArgumento('email', 'admin@academia.com');
  const senhaNova = lerArgumento('senha', null) || gerarSenhaAleatoria();
  const senhaFoiGerada = !lerArgumento('senha', null);

  const result = await db.execute({ sql: 'SELECT id, nome, email FROM usuarios WHERE email = ?', args: [email] });
  const usuario = result.rows[0];
  if (!usuario) {
    console.error(`Nenhum usuário encontrado com o e-mail "${email}". Nada foi alterado.`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(senhaNova, 10);
  await db.execute({ sql: 'UPDATE usuarios SET senha_hash = ? WHERE id = ?', args: [hash, usuario.id] });

  console.log('Senha atualizada com sucesso.');
  console.log(`Usuário: ${usuario.nome} <${usuario.email}>`);
  if (senhaFoiGerada) {
    console.log('');
    console.log(`Nova senha (só aparece agora, aqui — anote antes de fechar o terminal):`);
    console.log(`  ${senhaNova}`);
    console.log('');
  } else {
    console.log('Senha definida para o valor passado em --senha.');
  }
}

main()
  .catch((err) => {
    console.error('Erro ao trocar a senha:', err.message);
    process.exit(1);
  })
  .finally(() => process.exit(0));
