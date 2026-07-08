// Script de conferência rápida (temporário) — mostra o biometria_id de
// alguns alunos específicos direto do local.db, ignorando qualquer .env ou
// variável de ambiente (igual mesclar-alunos-duplicados.js), pra confirmar
// com certeza absoluta o que está gravado no arquivo local de teste.
//
// Como rodar (a partir da pasta academia-gestao, em qualquer terminal):
//   node scripts/debug-biometria-local.js

const { createClient } = require('@libsql/client');
const db = createClient({ url: 'file:./local.db' });

async function main() {
  const r = await db.execute(
    `SELECT id, nome, biometria_id, status FROM alunos WHERE nome LIKE '%Robson Junior%' OR nome LIKE '%uperaç%'`
  );
  console.log(`Encontrados: ${r.rows.length}`);
  for (const row of r.rows) {
    console.log(row);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
