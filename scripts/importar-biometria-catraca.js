// Liga o "Nº Identificador" da biometria da catraca Henry (o mesmo que
// aparece no Secullum em "Manutenção de Biometrias") ao cadastro
// correspondente na tabela `alunos`, preenchendo `biometria_id`. É esse
// vínculo que falta pra POST /api/terminal/validar-biometria-catraca parar
// de responder "negado" pra todo mundo.
//
// Fonte dos dados: um arquivo de texto exportado DIRETO da catraca, uma
// linha por cartão/pessoa cadastrada, no formato bruto do protocolo Henry:
//   4+1+I[[00000000000000000234[[[2[1[1[[[[[0[1[1[[[0[Jameson teixeira[[
// O identificador (234 no exemplo) e o nome (truncado em ~20 caracteres pelo
// próprio equipamento) ficam nesse formato.
//
// Como rodar contra o local.db de teste (a partir da pasta academia-gestao):
//   1. Copie o arquivo exportado da catraca para scripts/data/cartao.txt
//      (crie a pasta "data" se não existir).
//   2. node scripts/importar-biometria-catraca.js
//        -> modo dry-run (padrão): NÃO grava nada, só mostra o que faria:
//           quantos alunos seriam vinculados automaticamente, quais ficaram
//           ambíguos (mais de um candidato) e quais identificadores da
//           catraca não bateram com nenhum aluno.
//   3. Revise a lista. Se estiver tudo certo:
//      node scripts/importar-biometria-catraca.js --aplicar
//        -> grava biometria_id nos alunos com correspondência única e
//           confiável. Nunca sobrescreve um biometria_id já preenchido.
//
// Como rodar contra PRODUCAO:
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/importar-biometria-catraca.js --confirmar-producao"
//   .\scripts\rodar-producao-migracao.ps1 "node scripts/importar-biometria-catraca.js --aplicar --confirmar-producao"
//
// Critério de correspondência: nome do aluno normalizado (sem acento,
// minúsculo) comparado com o nome truncado da catraca — por prefixo quando o
// nome da catraca tem 20 caracteres (truncado pelo equipamento), ou igual
// quando é menor (nome completo coube). Só aplica quando há exatamente 1
// aluno candidato para aquele identificador E aquele aluno não bateu com
// nenhum outro identificador — qualquer ambiguidade fica de fora, pra
// revisão manual (aparece no relatório, nada é adivinhado).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const DATABASE_URL = process.env.DATABASE_URL || 'file:./local.db';
const USANDO_PRODUCAO = DATABASE_URL !== 'file:./local.db';
const CONFIRMAR_PRODUCAO = process.argv.includes('--confirmar-producao');
if (USANDO_PRODUCAO && !CONFIRMAR_PRODUCAO) {
  console.error('\n=== BLOQUEADO ===');
  console.error('DATABASE_URL aponta para um banco que NAO e o local.db de teste:');
  console.error(`  ${DATABASE_URL}`);
  console.error('Rode de novo com --confirmar-producao se for isso mesmo que voce quer.');
  process.exit(1);
}

const db = createClient({
  url: DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

if (USANDO_PRODUCAO) {
  console.log('\n=========================================================');
  console.log(' ATENCAO: conectado em PRODUCAO (Turso), nao e o local.db');
  console.log(` URL: ${DATABASE_URL}`);
  console.log('=========================================================\n');
}

const ARQUIVO_CARTAO = path.join(__dirname, 'data', 'cartao.txt');

function lerFlag(nome) {
  return process.argv.includes(`--${nome}`);
}

function normalizar(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lê e interpreta o arquivo bruto exportado da catraca. */
function lerCartoes() {
  if (!fs.existsSync(ARQUIVO_CARTAO)) {
    console.error(`Arquivo não encontrado: ${ARQUIVO_CARTAO}`);
    console.error('Copie o arquivo exportado da catraca pra essa pasta (scripts/data/cartao.txt) antes de rodar.');
    process.exit(1);
  }
  const linhas = fs.readFileSync(ARQUIVO_CARTAO, 'utf8').split(/\r?\n/);
  const cartoes = [];
  for (const linha of linhas) {
    if (!linha.startsWith('4+1+I[[')) continue;
    const partes = linha.split('[');
    const idBruto = partes[2];
    if (!idBruto) continue;
    const id = String(Number(idBruto)); // remove zeros à esquerda
    if (!id || id === '0' || id === 'NaN') continue;

    let nome = '';
    for (let i = partes.length - 1; i >= 0; i--) {
      if (partes[i] !== '') { nome = partes[i]; break; }
    }
    if (/^\d+$/.test(nome)) nome = ''; // linha sem nome (slot vazio, cartão master, etc.)
    if (!nome) continue;

    cartoes.push({ id, nomeBruto: nome, nomeNormalizado: normalizar(nome) });
  }
  return cartoes;
}

async function main() {
  const aplicar = lerFlag('aplicar');
  const cartoes = lerCartoes();
  console.log(`Lidos ${cartoes.length} cartões/identificadores com nome no arquivo da catraca.`);

  const result = await db.execute('SELECT id, nome, cpf, biometria_id FROM alunos');
  const alunos = result.rows;
  console.log(`${alunos.length} alunos no banco (${alunos.filter((a) => a.biometria_id).length} já têm biometria_id — esses não são mexidos).`);

  const candidatosPorCartao = cartoes.map((cartao) => {
    const alunosCandidatos = alunos.filter((aluno) => {
      if (aluno.biometria_id) return false;
      const nomeAluno = normalizar(aluno.nome);
      return cartao.nomeBruto.length >= 20
        ? nomeAluno.startsWith(cartao.nomeNormalizado)
        : nomeAluno === cartao.nomeNormalizado;
    });
    return { cartao, alunosCandidatos };
  });

  // Um aluno pode bater com mais de um cartão (nomes truncados coincidindo
  // entre pessoas diferentes) — conta em quantos cartões cada aluno aparece
  // como candidato único, pra descartar esses casos também.
  const contagemPorAluno = new Map();
  for (const { alunosCandidatos } of candidatosPorCartao) {
    if (alunosCandidatos.length === 1) {
      const id = alunosCandidatos[0].id;
      contagemPorAluno.set(id, (contagemPorAluno.get(id) || 0) + 1);
    }
  }

  const aplicados = [];
  const ambiguos = [];
  const semCorrespondencia = [];

  for (const { cartao, alunosCandidatos } of candidatosPorCartao) {
    if (alunosCandidatos.length === 0) {
      semCorrespondencia.push(cartao);
    } else if (alunosCandidatos.length > 1) {
      ambiguos.push({ cartao, opcoes: alunosCandidatos });
    } else {
      const aluno = alunosCandidatos[0];
      if (contagemPorAluno.get(aluno.id) > 1) {
        ambiguos.push({ cartao, opcoes: [aluno], motivo: 'esse aluno bateu com mais de um identificador' });
      } else {
        aplicados.push({ cartao, aluno });
      }
    }
  }

  console.log('');
  console.log(`=== Resultado (${aplicar ? 'APLICANDO' : 'dry-run — nada será gravado'}) ===`);
  console.log(`Correspondência única e confiável: ${aplicados.length}`);
  console.log(`Ambíguos (revisão manual): ${ambiguos.length}`);
  console.log(`Sem nenhum aluno correspondente: ${semCorrespondencia.length}`);

  if (ambiguos.length) {
    console.log('');
    console.log('--- Ambíguos ---');
    for (const { cartao, opcoes, motivo } of ambiguos) {
      console.log(`  id ${cartao.id} "${cartao.nomeBruto}" ${motivo || `-> ${opcoes.length} alunos possíveis`}:`);
      for (const o of opcoes) console.log(`      - ${o.nome} (cpf ${o.cpf || '-'}, aluno_id ${o.id})`);
    }
  }

  if (semCorrespondencia.length) {
    console.log('');
    console.log('--- Sem correspondência (nenhum aluno com esse nome no banco) ---');
    for (const cartao of semCorrespondencia) console.log(`  id ${cartao.id} "${cartao.nomeBruto}"`);
  }

  console.log('');
  console.log('--- Serão vinculados ---');
  for (const { cartao, aluno } of aplicados) {
    console.log(`  id ${cartao.id} -> ${aluno.nome} (aluno_id ${aluno.id})`);
  }

  if (aplicar) {
    for (const { cartao, aluno } of aplicados) {
      await db.execute({ sql: 'UPDATE alunos SET biometria_id = ? WHERE id = ?', args: [cartao.id, aluno.id] });
    }
    console.log('');
    console.log(`Gravado: ${aplicados.length} alunos atualizados com biometria_id.`);
  } else {
    console.log('');
    console.log('Nada foi gravado (dry-run). Revise a lista acima e rode de novo com --aplicar para gravar.');
  }
}

main()
  .catch((err) => {
    console.error('Erro:', err.message);
    process.exit(1);
  })
  .finally(() => process.exit(0));
