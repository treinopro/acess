// 2026-07-27: troca do motor de reconhecimento facial de face-api.js pro
// SFace (OpenCV Zoo) — ver public/facial-sface.js e a conversa que motivou
// isso (reconhecimento errando o aluno mesmo com boa qualidade de captura, e
// o portal remoto usando um mecanismo de cadastro diferente do totem).
//
// Os dois modelos produzem embeddings de espaços vetoriais TOTALMENTE
// diferentes — um face_descriptor salvo pelo face-api não tem NENHUM
// significado quando comparado (cosseno) com um embedding do SFace. Comparar
// os dois às cegas não dá erro nenhum, só produz um resultado sem sentido
// (silenciosamente nunca bate, ou bate por acaso) — pior que simplesmente
// não ter rosto cadastrado.
//
// Corte seco combinado com o dono do sistema (em vez de conviver com os dois
// modelos por um tempo): este script zera face_descriptor de TODO MUNDO de
// uma vez só. A partir daí, reconhecimento facial para de funcionar até cada
// aluno recadastrar o rosto (CPF/QR continuam funcionando normalmente nesse
// meio tempo) — avise a academia antes de rodar isto em produção.
//
// Rode ESTE script manualmente UMA VEZ, no deploy que sobe a troca de modelo
// (build/vendor/onnx + facial-sface.js). NÃO é chamado por `npm run
// migrate` de propósito — se fosse, rodaria de novo a cada deploy futuro e
// apagaria os recadastros novos (que já estarão no formato certo).
//
// Como rodar (a partir da pasta academia-gestao; usa o mesmo DATABASE_URL/
// DATABASE_AUTH_TOKEN do .env — cuidado, aponta pra produção por padrão
// nesse projeto, ver ecosystem.config.js):
//   node scripts/zerar-face-descriptor-modelo-antigo.js            (dry-run)
//   node scripts/zerar-face-descriptor-modelo-antigo.js --aplicar  (zera de verdade)

const db = require('../src/db/client');

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  console.log(`=== Modo: ${APLICAR ? 'APLICANDO' : 'DRY-RUN'} ===\n`);

  const result = await db.execute(
    "SELECT id, nome FROM alunos WHERE face_descriptor IS NOT NULL ORDER BY nome",
  );
  console.log(`Alunos com rosto cadastrado (modelo antigo, face-api): ${result.rows.length}`);

  if (result.rows.length === 0) {
    console.log('Nada a zerar — nenhum face_descriptor pendente de migração.');
    return;
  }

  if (!APLICAR) {
    for (const aluno of result.rows) console.log(`  [zerar] ${aluno.nome}`);
    console.log('\n=== FIM (dry-run — nada foi alterado) ===');
    console.log('Rode de novo com --aplicar para zerar de verdade:');
    console.log('  node scripts/zerar-face-descriptor-modelo-antigo.js --aplicar');
    return;
  }

  const zerado = await db.execute(
    "UPDATE alunos SET face_descriptor = NULL WHERE face_descriptor IS NOT NULL",
  );
  console.log(`\n=== FIM: ${zerado.rowsAffected || result.rows.length} aluno(s) com face_descriptor zerado — precisam recadastrar o rosto ===`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
