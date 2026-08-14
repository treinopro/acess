const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('./client');

// Colunas adicionadas depois da versão inicial do schema. CREATE TABLE IF NOT EXISTS
// não altera tabelas já existentes, então bancos criados antes destas mudanças
// precisam de ALTER TABLE. Cada comando roda isolado e ignora erro de "coluna
// duplicada" para que rodar `npm run migrate` de novo seja sempre seguro.
const ALTERACOES_INCREMENTAIS = [
  "ALTER TABLE alunos ADD COLUMN biometria_id TEXT",
  "ALTER TABLE cobrancas ADD COLUMN descricao TEXT",
  "ALTER TABLE alunos ADD COLUMN codigo_acesso TEXT",
  "ALTER TABLE alunos ADD COLUMN face_descriptor TEXT",
  "ALTER TABLE usuarios ADD COLUMN usuario TEXT",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN medida_panturrilha_cm REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN imc_atual REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN imc_ideal REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN iac REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN massa_magra_kg REAL",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN perfil_morfologico TEXT",
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN dados_extras TEXT",
  // 'nativo' = treino cadastrado neste sistema (aba Treino no perfil) | 'app_externo'
  // = aluno acompanha o treino em outro aplicativo (vínculo por CPF/e-mail lá).
  "ALTER TABLE alunos ADD COLUMN treino_modo TEXT DEFAULT 'nativo'",
  // Desconto opcional por forma de pagamento (ex: "desconto pagamento em dinheiro").
  "ALTER TABLE planos ADD COLUMN desconto_tipo TEXT",
  "ALTER TABLE planos ADD COLUMN desconto_percentual REAL",
  "ALTER TABLE planos ADD COLUMN desconto_valor_centavos INTEGER",
  "ALTER TABLE planos ADD COLUMN desconto_forma_pagamento TEXT",
  // Categoria da pessoa + indicação de visitante (2026-07) — ver comentário
  // detalhado junto da definição de "alunos" em schema.sql.
  "ALTER TABLE alunos ADD COLUMN categoria TEXT NOT NULL DEFAULT 'aluno'",
  "ALTER TABLE alunos ADD COLUMN indicado_por_aluno_id TEXT",
  // Data da primeira liberação do visitante (2026-07-19 — troca do limite de
  // "N acessos" para "N dias corridos"). Ver comentário em schema.sql.
  "ALTER TABLE alunos ADD COLUMN visitante_liberado_em TEXT",
  // Idade do aluno calculada (front-end) na data da avaliação (2026-07-27) —
  // ver comentário junto da definição de "avaliacoes_fisicas" em schema.sql.
  "ALTER TABLE avaliacoes_fisicas ADD COLUMN idade INTEGER",
  // Id da conta_pagar no Secullum (2026-07-28) — ver comentário junto da
  // definição de "contas_pagar" em schema.sql.
  "ALTER TABLE contas_pagar ADD COLUMN secullum_id TEXT",
  // Port do módulo de treinos do TreinoPro (2026-08) — ver comentário
  // detalhado junto da definição de "treino_exercicios" em schema.sql.
  "ALTER TABLE treino_exercicios ADD COLUMN biblioteca_id TEXT REFERENCES exercicio_biblioteca(id)",
  "ALTER TABLE treino_exercicios ADD COLUMN video_url TEXT",
  "ALTER TABLE treino_exercicios ADD COLUMN imagem_url TEXT",
  "ALTER TABLE treino_exercicios ADD COLUMN metodo TEXT",
  "ALTER TABLE treino_exercicios ADD COLUMN dica TEXT",
  "ALTER TABLE treino_exercicios ADD COLUMN concluido INTEGER NOT NULL DEFAULT 0",
  // Preferência de notificação de vencimento pelo portal (2026-08-13) — ver
  // comentário detalhado junto da definição de "alunos" em schema.sql.
  "ALTER TABLE alunos ADD COLUMN notificar_vencimento INTEGER",
  "ALTER TABLE alunos ADD COLUMN notificar_vencimento_dias_antes INTEGER NOT NULL DEFAULT 3",
  "ALTER TABLE cobrancas ADD COLUMN aviso_vencimento_enviado INTEGER NOT NULL DEFAULT 0",
];

// Divide um arquivo .sql em statements individuais (o driver libsql nao aceita
// multiplos comandos separados por ';' em uma unica chamada .execute).
// Cuidado: um ';' pode aparecer DENTRO de uma linha de comentario ('-- texto; texto'),
// e nesse caso nao deve ser tratado como fim de statement - senao o pedaco cortado
// vira um "comando" formado só por comentário, sem SQL nenhum, e o banco rejeita
// com "SQL string does not contain any statement" (bug real, já visto em produção,
// causado por um comentário do schema.sql que tinha um ';' no meio do texto).
function dividirStatementsSQL(sql) {
  const MARCADOR = ''; // caractere de controle que nunca aparece no schema.sql de verdade
  const linhas = sql.split('\n');
  const linhasProtegidas = linhas.map((linha) => {
    const semEspacos = linha.trimStart();
    if (semEspacos.startsWith('--')) {
      // Linha é 100% comentário: protege qualquer ';' que apareça nela,
      // trocando por um marcador temporário até depois do split.
      return linha.split(';').join(MARCADOR);
    }
    return linha;
  });
  return linhasProtegidas
    .join('\n')
    .split(';')
    .map((s) => s.split(MARCADOR).join(';').trim())
    .filter(Boolean)
    // Rede de segurança extra: descarta qualquer statement que, tirando as
    // linhas de comentário, não sobrou nenhum SQL de verdade.
    .filter((s) => {
      const semComentarios = s
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim();
      return Boolean(semComentarios);
    });
}

// Modelos prontos, semeados uma vez (idempotente — checa por nome antes de
// inserir) pra já vir pronto no composer de Recuperação de Clientes, sem o
// admin precisar redigitar.
//
// "Boas-vindas / Cadastro facial" (2026-07) — reaproveita o mesmo texto do
// e-mail automático de cadastro (ver src/services/emailBoasVindas.service.js),
// pra reenviar em massa pra "Todos os ativos" (GET /api/recuperacao/todos-ativos)
// quando for útil — ex.: pedir de novo pra quem ainda não fez o cadastro
// facial. Usa {nome} e {senha} (ver substituirVariaveis em
// recuperacao.routes.js); o link do Portal do Aluno já entra sozinho por
// causa de link_tipo='portal'. Deliberadamente DESACOPLADO do e-mail
// automático em si (ver comentário no topo de emailBoasVindas.service.js) —
// apagar/editar este modelo nunca afeta o e-mail que dispara sozinho no
// cadastro.
//
// "Feliz Aniversário" (2026-07-19, pedido do dono do sistema: texto que
// pareça alguém conhecido escrevendo, não uma mensagem automática de
// sistema) — de propósito SEM link nenhum (link_tipo='nenhum'), pra não
// parecer oferta/venda no meio de um recado de carinho.
const TEMPLATES_SEED = [
  {
    nome: 'Boas-vindas / Cadastro facial',
    saudacao: 'Olá {nome}! Seja bem-vindo(a) à Academia Superação.',
    corpo: 'Para acompanhar seus dados, treinos e contas pelo celular, acesse o Portal do Aluno abaixo.\n\n'
      + 'Sua senha de acesso ao portal é: {senha}\n\n'
      + 'Se você ainda não fez o cadastro facial na academia (pra liberar a catraca automaticamente, sem precisar digitar nada), aproveite para fazer pelo próprio Portal do Aluno — é rápido!',
    link_tipo: 'portal',
  },
  {
    nome: 'Feliz Aniversário',
    saudacao: '{nome}, feliz aniversário! 🎉',
    corpo: 'Vim aqui só pra te dar um abraço e desejar um ano novo de vida cheio de energia — pra continuar firme nos treinos (e no resto da vida também, claro). Qualquer coisa que precisar, é só chamar.\n\n'
      + 'Um beijo,\nEquipe Academia Superação',
    link_tipo: 'nenhum',
  },
];

async function seedMensagensTemplates() {
  let criados = 0;
  for (const template of TEMPLATES_SEED) {
    // eslint-disable-next-line no-await-in-loop
    const existente = await db.execute({
      sql: 'SELECT id FROM mensagens_templates WHERE nome = ?',
      args: [template.nome],
    });
    if (existente.rows[0]) continue;

    // eslint-disable-next-line no-await-in-loop
    await db.execute({
      sql: `INSERT INTO mensagens_templates (id, nome, saudacao, corpo, link_tipo, ativo)
            VALUES (?, ?, ?, ?, ?, 1)`,
      args: [uuid(), template.nome, template.saudacao, template.corpo, template.link_tipo],
    });
    criados += 1;
  }
  return criados;
}

// Biblioteca padrão de exercícios (2026-08) — port do catálogo do TreinoPro
// (98 exercícios com vídeo de execução no YouTube já levantado). Cada linha:
// [grupo_muscular, nome, video_url, equipamento, dificuldade, musculos_secundarios, instrucoes].
// Seed idempotente por (grupo_muscular, nome) — rodar de novo não duplica, e
// não sobrescreve um vídeo que o admin já tenha trocado manualmente depois.
const BIBLIOTECA_SEED = [
  ['Peito', 'Supino reto com barra', 'https://youtu.be/EZMYCLKuGow', 'barra', 'intermediario', 'Tríceps, ombro anterior', 'Deite no banco, pegada pouco mais aberta que os ombros, desça a barra até o peito e empurre.'],
  ['Peito', 'Supino inclinado com halteres', 'https://youtu.be/WP1VLAt8hbM', 'halter', 'intermediario', 'Ombro anterior, tríceps', 'Banco a 30-45°, desça os halteres na linha do peito superior e empurre para cima.'],
  ['Peito', 'Supino reto com halteres', 'https://youtu.be/EZMYCLKuGow', 'halter', 'iniciante', 'Tríceps, ombro anterior', 'Permite maior amplitude que a barra; controle a descida.'],
  ['Peito', 'Crucifixo com halteres', 'https://youtu.be/uDMmccuPVPQ', 'halter', 'iniciante', 'Ombro anterior', 'Cotovelos levemente flexionados, abra os braços em arco e traga de volta.'],
  ['Peito', 'Crossover na polia', 'https://youtu.be/jqTlJt3JXzQ', 'polia', 'intermediario', 'Ombro anterior', 'Puxe os cabos à frente cruzando levemente as mãos; contraia o peito.'],
  ['Peito', 'Flexão de braço', 'https://youtu.be/dHgoYiCraCw', 'peso corporal', 'iniciante', 'Tríceps, core', 'Corpo alinhado, desça até o peito quase tocar o chão e empurre.'],
  ['Peito', 'Flexão inclinada (mãos elevadas)', '', 'peso corporal', 'iniciante', 'Tríceps', 'Mãos num banco; versão mais fácil da flexão, boa para iniciantes.'],
  ['Peito', 'Peck deck (voador)', 'https://youtu.be/FzCnfD0gOXo', 'máquina', 'iniciante', 'Ombro anterior', 'Sentado, junte os braços à frente pela almofada; movimento guiado.'],
  ['Peito', 'Supino declinado com barra', 'https://youtu.be/J2g6qPBJfqo', 'barra', 'intermediario', 'Tríceps, ombro anterior', 'No banco declinado, desça a barra à linha inferior do peito e empurre sem perder a retração escapular.'],
  ['Peito', 'Crucifixo inclinado com halteres', 'https://youtu.be/uy9Xk3SVrms', 'halter', 'intermediario', 'Ombro anterior', 'Banco inclinado, abra os braços em arco mantendo leve flexão dos cotovelos.'],
  ['Peito', 'Crossover polia alta', 'https://youtu.be/jqTlJt3JXzQ', 'polia', 'intermediario', 'Ombro anterior', 'Conduza as mãos de cima para baixo e à frente, sem projetar os ombros.'],
  ['Peito', 'Crossover polia baixa', 'https://youtu.be/jqTlJt3JXzQ', 'polia', 'intermediario', 'Ombro anterior', 'Conduza as mãos de baixo para cima em direção ao centro do peito.'],
  ['Peito', 'Pullover com halter', 'https://youtu.be/-KaMXMMIVrU', 'halter', 'intermediario', 'Dorsal, serrátil, tríceps', 'Deitado, leve o halter atrás da cabeça com controle e retorne sem arquear a lombar.'],
  ['Costas', 'Puxada frente na polia', 'https://youtu.be/pJM_rHhluK8', 'polia', 'iniciante', 'Bíceps, antebraço', 'Pegada aberta, puxe a barra até a clavícula descendo as escápulas.'],
  ['Costas', 'Remada curvada com barra', 'https://youtu.be/TfxJMertfsw', 'barra', 'avancado', 'Bíceps, lombar', 'Tronco inclinado ~45°, puxe a barra ao umbigo mantendo a coluna neutra.'],
  ['Costas', 'Remada unilateral com haltere', 'https://youtu.be/m4h4jT9patY', 'halter', 'iniciante', 'Bíceps', 'Apoie joelho e mão no banco, puxe o haltere ao quadril.'],
  ['Costas', 'Remada baixa na polia', 'https://youtu.be/HpWWreyaBN0', 'polia', 'iniciante', 'Bíceps', 'Sentado, puxe o triângulo ao abdômen mantendo o peito aberto.'],
  ['Costas', 'Barra fixa (pull-up)', 'https://youtu.be/thg6cGXSlvY', 'peso corporal', 'avancado', 'Bíceps, core', 'Pegada pronada, puxe o corpo até o queixo passar a barra.'],
  ['Costas', 'Remada com elástico', '', 'elástico', 'iniciante', 'Bíceps', 'Elástico preso à frente, puxe os punhos às costelas.'],
  ['Costas', 'Pulldown com corda', 'https://youtu.be/v6-QIOY0nW0', 'polia', 'iniciante', 'Ombro posterior', 'Com braços quase estendidos, conduza a corda até as coxas usando o grande dorsal.'],
  ['Costas', 'Levantamento terra', 'https://youtu.be/50AkPBZwACQ', 'barra', 'avancado', 'Glúteos, posterior de coxa, core', 'Barra próxima às canelas, coluna neutra; estenda joelhos e quadris em conjunto.'],
  ['Costas', 'Barra fixa supinada', 'https://youtu.be/thg6cGXSlvY', 'peso corporal', 'avancado', 'Bíceps, antebraço', 'Palmas voltadas para você; suba sem balanço e controle a descida.'],
  ['Costas', 'Remada cavalinho', 'https://youtu.be/TfxJMertfsw', 'barra', 'intermediario', 'Bíceps, romboides', 'Tronco estável e inclinado; puxe a carga em direção ao abdômen.'],
  ['Costas', 'Remada na máquina', 'https://youtu.be/QyvIEdEHzHc', 'máquina', 'iniciante', 'Bíceps, romboides', 'Apoie o tronco quando disponível e puxe conduzindo os cotovelos para trás.'],
  ['Costas', 'Remada unilateral na polia', 'https://youtu.be/HpWWreyaBN0', 'polia', 'intermediario', 'Bíceps, core', 'Mantenha o tronco alinhado e puxe a alça em direção à costela.'],
  ['Ombros', 'Desenvolvimento com barra', 'https://youtu.be/EuQAfhXBEvs', 'barra', 'intermediario', 'Tríceps', 'Sentado ou em pé, empurre a barra acima da cabeça sem arquear a lombar.'],
  ['Ombros', 'Desenvolvimento com halteres', 'https://youtu.be/EuQAfhXBEvs', 'halter', 'iniciante', 'Tríceps', 'Halteres na linha das orelhas, empurre até quase estender os cotovelos.'],
  ['Ombros', 'Elevação lateral com halteres', 'https://youtu.be/IwWvZ0rlNXs', 'halter', 'iniciante', 'Trapézio', 'Braços quase retos, eleve os halteres até a linha dos ombros.'],
  ['Ombros', 'Elevação frontal com halteres', 'https://youtu.be/NxSuojHZa8k', 'halter', 'iniciante', '—', 'Eleve o haltere à frente até a altura dos olhos, alternando ou junto.'],
  ['Ombros', 'Crucifixo inverso (posterior)', 'https://youtu.be/5HDkxzxe400', 'halter', 'intermediario', 'Trapézio, romboides', 'Tronco inclinado, abra os braços para trabalhar o deltoide posterior.'],
  ['Ombros', 'Elevação lateral na polia', 'https://youtu.be/sKPJdvVvHuI', 'polia', 'intermediario', 'Trapézio', 'Tensão constante ao longo de todo o movimento.'],
  ['Ombros', 'Elevação lateral sentado', 'https://youtu.be/IwWvZ0rlNXs', 'halter', 'iniciante', 'Trapézio', 'Sentado e com tronco firme, eleve os halteres sem embalo.'],
  ['Ombros', 'Elevação frontal com barra', 'https://youtu.be/_ZQhDiONpZA', 'barra', 'intermediario', 'Peitoral superior', 'Eleve a barra à frente até a linha dos ombros mantendo o abdômen firme.'],
  ['Ombros', 'Desenvolvimento na máquina', 'https://youtu.be/EuQAfhXBEvs', 'máquina', 'iniciante', 'Tríceps', 'Ajuste o banco para as pegadas iniciarem próximas às orelhas e empurre para cima.'],
  ['Ombros', 'Rotação externa do manguito', 'https://youtu.be/AevNFIX7lV4', 'polia', 'iniciante', 'Infraespinal, redondo menor', 'Cotovelo junto ao corpo e flexionado a 90°; gire o antebraço para fora sem mover o tronco.'],
  ['Ombros', 'Rotação interna do manguito', 'https://youtu.be/vN9_Bw_yZGA', 'polia', 'iniciante', 'Subescapular', 'Cotovelo junto ao corpo e flexionado a 90°; gire o antebraço para dentro com carga leve.'],
  ['Trapézio', 'Encolhimento com halteres', 'https://youtu.be/RhGjwIUe16E', 'halter', 'iniciante', 'Antebraço', 'Eleve os ombros verticalmente sem girá-los e controle a descida.'],
  ['Trapézio', 'Remada alta com barra', 'https://youtu.be/tm0IywBhIYM', 'barra', 'intermediario', 'Ombros', 'Puxe a barra próxima ao corpo até a altura confortável, conduzindo pelos cotovelos.'],
  ['Bíceps', 'Rosca direta com barra', 'https://youtu.be/Q8TqfD8E7BU', 'barra', 'iniciante', 'Antebraço', 'Cotovelos fixos ao tronco, flexione a barra até o peito.'],
  ['Bíceps', 'Rosca alternada com halteres', 'https://youtu.be/S1HAcTVQVYE', 'halter', 'iniciante', 'Antebraço', 'Alterne os braços, girando o punho na subida.'],
  ['Bíceps', 'Rosca martelo', 'https://youtu.be/0qkQy8V2FC0', 'halter', 'iniciante', 'Braquial, antebraço', 'Pegada neutra (polegar para cima) do início ao fim.'],
  ['Bíceps', 'Rosca scott', 'https://youtu.be/zpTK6eihdSA', 'máquina', 'intermediario', 'Antebraço', 'Braços apoiados no banco scott, isola o bíceps.'],
  ['Bíceps', 'Rosca com elástico', '', 'elástico', 'iniciante', 'Antebraço', 'Pise no elástico e flexione — boa opção para casa.'],
  ['Bíceps', 'Rosca concentrada', 'https://youtu.be/EEpvOQAAtRo', 'halter', 'intermediario', 'Antebraço', 'Sentado, apoie o cotovelo na parte interna da coxa e flexione sem mover o ombro.'],
  ['Bíceps', 'Rosca direta na polia', 'https://youtu.be/Q8TqfD8E7BU', 'polia', 'iniciante', 'Antebraço', 'Mantenha os cotovelos fixos e flexione contra a tensão constante da polia.'],
  ['Tríceps', 'Tríceps corda na polia', 'https://youtu.be/dTqDKC0D6P4', 'polia', 'iniciante', '—', 'Cotovelos fixos, estenda a corda abrindo as pontas no final.'],
  ['Tríceps', 'Tríceps testa com barra', 'https://youtu.be/zznCYBVZOVA', 'barra', 'intermediario', '—', 'Deitado, desça a barra à testa flexionando só os cotovelos.'],
  ['Tríceps', 'Mergulho entre bancos', 'https://youtu.be/TCVj8cliLNo', 'peso corporal', 'iniciante', 'Ombro anterior', 'Mãos no banco atrás, desça o quadril e empurre.'],
  ['Tríceps', 'Tríceps francês com haltere', 'https://youtu.be/YJ4kGE3eemY', 'halter', 'iniciante', '—', 'Haltere acima da cabeça, desça atrás da nuca e estenda.'],
  ['Tríceps', 'Tríceps coice na polia', 'https://youtu.be/PyKv23F-fVM', 'polia', 'iniciante', '—', 'Tronco inclinado, estenda o cotovelo para trás.'],
  ['Tríceps', 'Paralelas', 'https://youtu.be/LJz40nTE_sI', 'peso corporal', 'avancado', 'Peito, ombro anterior', 'Desça com controle até a amplitude confortável e empurre sem perder a estabilidade dos ombros.'],
  ['Tríceps', 'Supino fechado com barra', 'https://youtu.be/ZiemT4r4DcU', 'barra', 'intermediario', 'Peito, ombro anterior', 'Use pegada próxima à largura dos ombros e mantenha os cotovelos mais junto ao tronco.'],
  ['Tríceps', 'Tríceps unilateral na polia', 'https://youtu.be/nTTTjbA0TSU', 'polia', 'iniciante', '—', 'Cotovelo fixo ao lado do tronco; estenda um braço por vez.'],
  ['Antebraço', 'Flexão de punho com barra', 'https://youtu.be/3PDPiCoWF-Y', 'barra', 'iniciante', 'Flexores dos dedos', 'Apoie os antebraços e mova somente os punhos, controlando a amplitude.'],
  ['Antebraço', 'Extensão de punho com barra', 'https://youtu.be/Kx8rg0MJX_c', 'barra', 'iniciante', 'Extensores dos dedos', 'Com pegada pronada, estenda os punhos sem tirar os antebraços do apoio.'],
  ['Antebraço', 'Rosca inversa com barra', 'https://youtu.be/jbSr9CzJPmA', 'barra', 'intermediario', 'Bíceps, braquiorradial', 'Pegada pronada, cotovelos fixos; flexione a barra sem embalo.'],
  ['Antebraço', 'Hand grip', 'https://youtu.be/XVlGHmeISEQ', 'hand grip', 'iniciante', 'Flexores dos dedos', 'Feche o aparelho com controle e retorne sem soltar de uma vez.'],
  ['Pernas', 'Agachamento livre', 'https://youtu.be/zgk71dUUt0Y', 'barra', 'avancado', 'Glúteo, core', 'Barra nas costas, desça até coxas paralelas mantendo o tronco firme.'],
  ['Pernas', 'Leg press 45°', 'https://youtu.be/nY8UsiAqwds', 'máquina', 'iniciante', 'Glúteo', 'Pés na plataforma, desça controlando e empurre sem travar os joelhos.'],
  ['Pernas', 'Cadeira extensora', 'https://youtu.be/el3oHblB5DM', 'máquina', 'iniciante', '—', 'Isola o quadríceps; estenda os joelhos e segure 1s no topo.'],
  ['Pernas', 'Cadeira flexora', 'https://youtu.be/Zss6E3VU6X0', 'máquina', 'iniciante', 'Panturrilha', 'Isola o posterior de coxa; flexione os joelhos trazendo os calcanhares.'],
  ['Pernas', 'Stiff com barra', 'https://youtu.be/u1E3_u2gJYE', 'barra', 'intermediario', 'Glúteo, lombar', 'Joelhos semi-rígidos, desça a barra rente às pernas sentindo o posterior.'],
  ['Pernas', 'Afundo (lunges)', 'https://youtu.be/Umzor-_g-tQ', 'peso corporal', 'iniciante', 'Glúteo', 'Passo à frente, desça o joelho de trás em direção ao chão.'],
  ['Pernas', 'Agachamento goblet', 'https://youtu.be/zgk71dUUt0Y', 'halter', 'iniciante', 'Glúteo, core', 'Segure um haltere junto ao peito e agache — ótimo para aprender o padrão.'],
  ['Pernas', 'Agachamento búlgaro', 'https://youtu.be/IGf9fR4Y7Iw', 'halter', 'intermediario', 'Glúteo', 'Pé de trás elevado no banco; unilateral, alto estímulo.'],
  ['Pernas', 'Agachamento frontal', 'https://youtu.be/syfDrU220FU', 'barra', 'avancado', 'Glúteo, core', 'Barra apoiada à frente dos ombros; mantenha cotovelos altos e tronco firme.'],
  ['Pernas', 'Agachamento no smith', 'https://youtu.be/zgk71dUUt0Y', 'máquina', 'iniciante', 'Glúteo, core', 'Posicione os pés de modo que a barra permaneça alinhada ao centro do apoio.'],
  ['Pernas', 'Agachamento no hack', 'https://youtu.be/zgk71dUUt0Y', 'máquina', 'iniciante', 'Glúteo', 'Mantenha costas apoiadas e joelhos acompanhando a direção dos pés.'],
  ['Pernas', 'Passada com halteres', 'https://youtu.be/sQ5RjbpPirY', 'halter', 'intermediario', 'Glúteo, core', 'Caminhe com passos controlados, mantendo o joelho alinhado ao pé.'],
  ['Pernas', 'Avanço com halteres', 'https://youtu.be/XBJtM2phDDM', 'halter', 'intermediario', 'Glúteo, core', 'Dê o passo, desça verticalmente e retorne à posição inicial.'],
  ['Pernas', 'Mesa flexora', 'https://youtu.be/2-ULaRrQa7c', 'máquina', 'iniciante', 'Panturrilha', 'Deitado, flexione os joelhos levando os calcanhares em direção aos glúteos.'],
  ['Pernas', 'Flexor vertical', 'https://youtu.be/KomsEmm5oxA', 'máquina', 'iniciante', 'Glúteo', 'Apoie o corpo e flexione uma perna por vez, sem girar o quadril.'],
  ['Pernas', 'Cadeira adutora', 'https://youtu.be/Wf602gn_9zU', 'máquina', 'iniciante', '—', 'Aproxime as pernas contra a resistência sem bater os pesos no retorno.'],
  ['Glúteos', 'Elevação pélvica com barra', 'https://youtu.be/ptK0azwOXwM', 'barra', 'intermediario', 'Posterior de coxa', 'Ombros no banco, barra no quadril, eleve até o corpo ficar reto.'],
  ['Glúteos', 'Abdução no cabo', 'https://youtu.be/JdHbXlggr6Q', 'polia', 'iniciante', '—', 'Tornozeleira no cabo, afaste a perna lateralmente.'],
  ['Glúteos', 'Agachamento sumô', 'https://youtu.be/O6Cmxez6D0k', 'halter', 'iniciante', 'Adutor, quadríceps', 'Pés bem afastados e apontados para fora, desça mantendo o tronco ereto.'],
  ['Glúteos', 'Coice na polia (kickback)', 'https://youtu.be/JdHbXlggr6Q', 'polia', 'iniciante', 'Posterior de coxa', 'Estenda o quadril levando a perna para trás.'],
  ['Glúteos', 'Abdução com elástico', '', 'elástico', 'iniciante', '—', 'Elástico acima dos joelhos, afaste as pernas — ativa glúteo médio.'],
  ['Glúteos', 'Quatro apoios com joelho flexionado', 'https://youtu.be/e4RuZ1NVYqA', 'peso corporal', 'iniciante', 'Posterior de coxa', 'Em quatro apoios, eleve uma perna mantendo o joelho flexionado e o quadril estável.'],
  ['Glúteos', 'Glúteo na máquina', 'https://youtu.be/JhodVO0l1vw', 'máquina', 'iniciante', 'Posterior de coxa', 'Ajuste os apoios e estenda o quadril sem compensar com a lombar.'],
  ['Glúteos', 'Cadeira abdutora', 'https://youtu.be/e2gmqTG1OgQ', 'máquina', 'iniciante', '—', 'Afaste os joelhos contra a resistência e retorne de forma controlada.'],
  ['Panturrilhas', 'Panturrilha em pé', 'https://youtu.be/824pMjvGXgc', 'máquina', 'iniciante', '—', 'Use amplitude confortável, suba na ponta dos pés e controle a descida.'],
  ['Panturrilhas', 'Panturrilha sentado', 'https://youtu.be/jMWs_p-W9gY', 'máquina', 'iniciante', '—', 'Mantenha a carga apoiada sobre as coxas e eleve os calcanhares.'],
  ['Panturrilhas', 'Panturrilha no leg press', 'https://youtu.be/wCXvfH_-BLg', 'máquina', 'intermediario', '—', 'Apoie apenas a parte anterior dos pés e mova a plataforma pelos tornozelos.'],
  ['Abdômen', 'Abdominal crunch', 'https://youtu.be/7YxVRiATugo', 'peso corporal', 'iniciante', '—', 'Eleve o tronco contraindo o abdômen, sem puxar o pescoço.'],
  ['Abdômen', 'Prancha isométrica', 'https://youtu.be/qNRqGqESAWU', 'peso corporal', 'iniciante', 'Lombar, ombro', 'Antebraços no chão, corpo reto; segure sem deixar o quadril cair.'],
  ['Abdômen', 'Russian twist', 'https://youtu.be/Smr8ipkN5A0', 'peso corporal', 'intermediario', 'Oblíquos', 'Sentado com o tronco inclinado, gire de um lado ao outro.'],
  ['Abdômen', 'Elevação de pernas', 'https://youtu.be/ixJcUH8AlL8', 'peso corporal', 'intermediario', 'Flexor do quadril', 'Deitado ou pendurado, eleve as pernas controlando a descida.'],
  ['Abdômen', 'Abdominal na polia (crunch cabo)', 'https://youtu.be/7YxVRiATugo', 'polia', 'intermediario', '—', 'Ajoelhado, flexione o tronco puxando a corda.'],
  ['Abdômen', 'Abdominal oblíquo', 'https://youtu.be/Smr8ipkN5A0', 'peso corporal', 'iniciante', '—', 'Flexione ou gire o tronco com controle, sem puxar a cabeça.'],
  ['Abdômen', 'Extensão lombar', 'https://youtu.be/z0rx9swRDR0', 'peso corporal', 'intermediario', 'Glúteo, posterior de coxa', 'No banco, desça o tronco com a coluna neutra e retorne até alinhar o corpo.'],
  ['Abdômen', 'Vácuo abdominal', 'https://youtu.be/qvdiga5sQvQ', 'peso corporal', 'intermediario', 'Transverso do abdômen', 'Expire, recolha o abdômen e sustente sem prender tensão no pescoço.'],
  ['Cardio', 'Esteira', '', 'máquina', 'iniciante', '—', 'Caminhada ou corrida; ajuste inclinação e velocidade ao objetivo.'],
  ['Cardio', 'Bicicleta ergométrica', '', 'máquina', 'iniciante', '—', 'Baixo impacto; boa para aquecimento ou trabalho aeróbico contínuo.'],
  ['Cardio', 'Polichinelo', '', 'peso corporal', 'iniciante', '—', 'Abra e feche pernas e braços em salto — aquecimento clássico.'],
  ['Cardio', 'Burpee', '', 'peso corporal', 'avancado', 'Corpo todo', 'Agache, prancha, flexão, salto — alta intensidade.'],
  ['Cardio', 'Pular corda', '', 'peso corporal', 'intermediario', 'Panturrilha', 'Saltos curtos e ritmados; excelente condicionamento.'],
  ['Cardio', 'Remo ergômetro', '', 'máquina', 'intermediario', 'Costas, pernas', 'Empurre com as pernas, puxe com as costas em sequência.'],
];

async function seedBibliotecaExercicios() {
  let criados = 0;
  for (const [grupoMuscular, nome, videoUrl, equipamento, dificuldade, musculosSecundarios, instrucoes] of BIBLIOTECA_SEED) {
    // eslint-disable-next-line no-await-in-loop
    const existente = await db.execute({
      sql: 'SELECT id FROM exercicio_biblioteca WHERE grupo_muscular = ? AND nome = ?',
      args: [grupoMuscular, nome],
    });
    if (existente.rows[0]) continue;

    // eslint-disable-next-line no-await-in-loop
    await db.execute({
      sql: `INSERT INTO exercicio_biblioteca
              (id, grupo_muscular, nome, video_url, equipamento, dificuldade, musculos_secundarios, instrucoes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [uuid(), grupoMuscular, nome, videoUrl || null, equipamento || null, dificuldade || null, musculosSecundarios || null, instrucoes || null],
    });
    criados += 1;
  }
  return criados;
}

// Corrige registros antigos de acessos_catraca gravados em formato ISO
// ("...T...Z", de `new Date().toISOString()`) em vez do formato do SQLite
// ("AAAA-MM-DD HH:MM:SS", de `datetime('now')`) — bug que fazia acessos por
// biometria da catraca (repassados em lote pelo agente local) aparecerem
// como "mais recentes" que acessos por facial/QR do mesmo dia na tela de
// Últimos Acessos, mesmo quando o facial foi depois de verdade (comparação
// de texto: 'T' é "maior" que espaço). Ver src/utils/data.js e
// acessoTerminal.service.js (2026-07-21) pro fix que evita gravar mais linha
// assim daqui pra frente — isto aqui só arruma o que já ficou torto.
// Idempotente: depois de rodar uma vez não sobra nenhuma linha com 'T' na
// posição certa, então roda de novo sem fazer nada.
async function corrigirFormatoDatasAcessosAntigos() {
  const result = await db.execute(
    `UPDATE acessos_catraca
     SET criado_em = substr(criado_em, 1, 10) || ' ' || substr(criado_em, 12, 8)
     WHERE criado_em LIKE '____-__-__T__:__:__%'`,
  );
  return result.rowsAffected || 0;
}

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  const statements = dividirStatementsSQL(schema);

  // Índices (CREATE INDEX/CREATE UNIQUE INDEX) rodam DEPOIS dos ALTER TABLE
  // abaixo, de propósito: em bancos já existentes a tabela já existe (o
  // CREATE TABLE IF NOT EXISTS correspondente é ignorado), então um índice
  // sobre uma coluna nova (ex.: codigo_acesso) só pode ser criado depois que
  // o ALTER TABLE ADD COLUMN já rodou — senão dá "no such column".
  const statementsTabelas = statements.filter((s) => !/^CREATE (UNIQUE )?INDEX/i.test(s));
  const statementsIndices = statements.filter((s) => /^CREATE (UNIQUE )?INDEX/i.test(s));

  for (const statement of statementsTabelas) {
    await db.execute(statement);
  }

  let aplicadas = 0;
  for (const alteracao of ALTERACOES_INCREMENTAIS) {
    try {
      await db.execute(alteracao);
      aplicadas += 1;
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  }

  for (const statement of statementsIndices) {
    await db.execute(statement);
  }

  const templatesSeedCriados = await seedMensagensTemplates();
  const bibliotecaSeedCriados = await seedBibliotecaExercicios();
  const acessosCorrigidos = await corrigirFormatoDatasAcessosAntigos();

  console.log(`Migração concluída: ${statements.length} statements de schema + ${aplicadas} alteração(ões) incremental(is) nova(s)${templatesSeedCriados ? ` + ${templatesSeedCriados} modelo(s) de mensagem novo(s) criado(s)` : ''}${bibliotecaSeedCriados ? ` + ${bibliotecaSeedCriados} exercício(s) novo(s) na biblioteca` : ''}${acessosCorrigidos ? ` + ${acessosCorrigidos} registro(s) de acesso com data corrigida` : ''}.`);
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro ao migrar banco de dados:', err);
    process.exit(1);
  });
