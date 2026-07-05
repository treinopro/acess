const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('./client');

// Cria um usuario admin e um plano de exemplo para facilitar os primeiros testes.
async function seed() {
  const senhaHash = await bcrypt.hash('admin123', 10);
  const adminId = uuid();

  await db.execute({
    sql: `INSERT INTO usuarios (id, nome, email, senha_hash, papel)
          VALUES (?, ?, ?, ?, 'admin')`,
    args: [adminId, 'Administrador', 'admin@academia.com', senhaHash],
  });

  const planoId = uuid();
  await db.execute({
    sql: `INSERT INTO planos (id, nome, tipo, valor_centavos, duracao_dias, aulas_incluidas)
          VALUES (?, 'Mensal Padrão', 'mensal', 9900, 30, NULL)`,
    args: [planoId],
  });

  console.log('Seed concluído.');
  console.log('Login: admin@academia.com / admin123');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao rodar seed:', err);
    process.exit(1);
  });
