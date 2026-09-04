// ---------------------------------------------------------------------------
// Portal remoto do aluno — praticamente o mesmo conjunto de funções do totem
// (cadastro novo, cadastro facial, pagamento de matrícula/contas via CPF,
// consulta de treino), só que acessado de fora da academia (celular/PC do
// aluno em casa) e, por isso, com uma diferença fundamental: NUNCA aciona a
// catraca, de forma nenhuma. Mesmo depois de confirmar um pagamento que
// zeraria o motivo de bloqueio, quem libera a entrada de verdade é o totem
// físico (ou a recepção), não este portal.
//
// IMPORTANTE sobre autenticação: diferente do totem — cujo TERMINAL_TOKEN fica
// só num dispositivo fisicamente controlado pela academia — este portal é uma
// página pública na internet, então não dá pra proteger com um segredo fixo
// embutido no HTML/JS (qualquer um veria o código-fonte).
//
// 2026-07: a prova de identidade deixou de ser só o CPF. No 1o acesso de cada
// aluno, o CPF sozinho ainda basta (mesmo espírito do totem físico) — mas
// nesse momento o portal gera (ou reaproveita, se ele já tiver sido enrolado
// na catraca) um código sequencial e o entrega como "senha", pedindo pro
// aluno guardar. A partir daí, CPF sozinho não abre mais nada — todo acesso
// exige CPF + essa senha (ver autenticarAlunoPortal() logo abaixo). Ideia do
// dono do sistema: reaproveitar um identificador que o aluno já tem/recebe
// fisicamente (o mesmo biometria_id da catraca Henry), sem custo de SMS/
// WhatsApp. Ainda assim, como esse código é sequencial (fácil de tentar por
// força bruta), o rate limit por IP abaixo continua valendo como camada
// adicional — e /vincular/facial tem um limite ainda mais apertado por CPF.
// ---------------------------------------------------------------------------

const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const acessoTerminal = require('../services/acessoTerminal.service');
const pagamentoContas = require('../services/pagamentoContas.service');
const mercadopago = require('../services/payment/mercadopago.service');
const emailBoasVindas = require('../services/emailBoasVindas.service');
const gamificacao = require('../services/gamificacao.service');
const { primeiroVencimento, ehRecorrente } = require('../services/cobrancas.service');
const { obterConfigChamarProfessor } = require('./config.routes');
const webPush = require('../services/webPush.service');
const { criarLimitador } = require('../middleware/rateLimit');
const { normalizarCpf } = require('../utils/cpf');

const router = express.Router();

// Portal é público e sem login (prova de identidade é só o CPF — ver
// comentário no topo do arquivo), então é o alvo mais fácil pra automação de
// CPFs vazados/sequenciais. Limite geral pra todas as rotas do portal, mais
// restrito ainda em /vincular/facial (ver abaixo) por ser a rota mais sensível.
router.use(criarLimitador({
  janelaMs: 15 * 60 * 1000,
  maximo: 30,
  mensagem: 'Muitas requisições ao portal a partir deste endereço. Aguarde alguns minutos.',
}));

// Sentinela do "plano Visitante" (2026-07 — sistema de visitantes/indicação),
// mesmo mecanismo de src/routes/terminal.routes.js: não é uma linha de
// verdade em `planos` (evitando poluir relatórios financeiros com um plano de
// R$ 0,00) — é injetado como opção extra na lista que GET /planos devolve, e
// tratado à parte em POST /cadastro, sem Pix, sem matrícula, sem cobrança.
const PLANO_VISITANTE_ID = 'visitante';
const PLANO_VISITANTE = {
  id: PLANO_VISITANTE_ID,
  nome: 'Visitante (acesso gratuito, sem matrícula)',
  tipo: 'visitante',
  valor_centavos: 0,
  duracao_dias: null,
};

// GET /api/portal/planos?incluir_visitante=true — planos ativos, para os
// seletores de cadastro/upgrade. A opção "Visitante" só entra quando
// incluir_visitante=true (usado pelo formulário de "Quero me cadastrar" —
// ver carregarPlanosCadastroPortal em portal.js) — o seletor de UPGRADE (aluno
// já cadastrado trocando de plano) chama este mesmo endpoint SEM esse
// parâmetro de propósito: "virar visitante" não é uma opção de upgrade válida
// (POST /upgrade nem trata plano_id='visitante'), então nunca deve aparecer
// nessa lista.
router.get('/planos', async (req, res, next) => {
  try {
    const result = await db.execute(
      'SELECT id, nome, tipo, valor_centavos, duracao_dias FROM planos WHERE ativo = 1 ORDER BY valor_centavos',
    );
    const incluirVisitante = req.query.incluir_visitante === 'true' || req.query.incluir_visitante === '1';
    res.json(incluirVisitante ? [...result.rows, PLANO_VISITANTE] : result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------------- Senha do portal (2026-07) ----------------
// A partir do 1o acesso de cada aluno ao portal, CPF sozinho deixa de bastar
// — passa a exigir também a "senha", que é o mesmo código sequencial usado
// como biometria_id na catraca (ideia do dono do sistema: reaproveitar um
// código que o aluno já recebe/conhece fisicamente, sem custo de SMS/
// WhatsApp). Ver GET /aluno abaixo pro fluxo de "revelar" a senha na
// primeira vez, e autenticarAlunoPortal() pra exigi-la depois disso.
//
// Só GET /aluno tem a lógica de "revelar" — todas as outras rotas abaixo
// (treino, contas, upgrade, vincular facial) já assumem que o front-end tem
// a senha em mãos (revelada nessa primeira tela, ou digitada pelo aluno) e
// só validam normalmente.
// Limite por CPF (além do limite geral por IP lá em cima) pras rotas que
// validam senha: o código é sequencial (baixa entropia — 4 dígitos), então
// alguém trocando de IP/rede ainda conseguiria ficar tentando várias senhas
// contra o MESMO CPF sem isso. Generoso o bastante pro uso normal (aluno
// errando a senha uma ou duas vezes).
const limitadorSenhaPortal = criarLimitador({
  janelaMs: 15 * 60 * 1000,
  maximo: 8,
  mensagem: 'Muitas tentativas de acesso para este CPF. Aguarde alguns minutos ou procure a recepção.',
  chavePor: (req) => `senha-portal:${req.body?.cpf || req.query?.cpf || ''}`,
});

async function autenticarAlunoPortal(cpf, senha) {
  const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
  if (!aluno) return { status: 404, erro: 'CPF não encontrado. Use "Quero me cadastrar" se ainda não tem cadastro.' };
  if (!aluno.biometria_id || senha !== aluno.biometria_id) {
    return { status: 401, erro: 'CPF ou senha incorretos.' };
  }
  return { aluno };
}

// GET /api/portal/aluno?cpf=...&senha=... — tela "hub" depois de identificar
// o CPF: nome, modo de treino (pra decidir se mostra a lista nativa ou o
// link do app externo) e o plano atual (pra tela de upgrade saber o que já
// tem).
//
// Único ponto de entrada com a lógica de 1o acesso: se este aluno ainda
// nunca "viu" a senha do portal (portal_senha_revelada = 0), este endpoint
// libera com CPF sozinho, gera o código se ele ainda não tiver um (aluno
// nunca enrolado na catraca) e devolve a senha na resposta pra tela mostrar
// e o aluno guardar — só essa vez. Nos acessos seguintes, exige `senha`
// batendo com o biometria_id, senão 401.
router.get('/aluno', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().trim().optional() }).parse(req.query);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado. Use "Quero me cadastrar" se ainda não tem cadastro.' });

    let primeiroAcesso = false;
    let senhaGerada = null;

    if (!aluno.portal_senha_revelada) {
      senhaGerada = aluno.biometria_id || await acessoTerminal.atribuirCodigoAluno(aluno.id);
      await db.execute({ sql: 'UPDATE alunos SET portal_senha_revelada = 1 WHERE id = ?', args: [aluno.id] });
      primeiroAcesso = true;
    } else if (!senha) {
      return res.status(401).json({ erro: 'Informe também sua senha de acesso.', precisa_senha: true });
    } else if (senha !== aluno.biometria_id) {
      return res.status(401).json({ erro: 'CPF ou senha incorretos.' });
    }

    const matricula = await db.execute({
      sql: `SELECT m.id, m.plano_id, p.nome as plano_nome, p.valor_centavos FROM matriculas m
            JOIN planos p ON p.id = m.plano_id
            WHERE m.aluno_id = ? AND m.status = 'ativa' ORDER BY m.data_inicio DESC LIMIT 1`,
      args: [aluno.id],
    });

    // Aba de treino só fica acessível com a mesma regra usada pra liberar a
    // catraca (mensalidade em dia) — ver acessoTerminal.verificarAutorizacaoAluno
    // e o bloqueio espelhado em GET/POST /treino abaixo (defesa em profundidade:
    // o front usa esta flag pra nem mostrar o botão, mas as rotas de treino
    // também recusam por conta própria caso alguém chame a API direto).
    const autorizacaoTreino = await acessoTerminal.verificarAutorizacaoAluno(aluno);

    res.json({
      aluno_nome: aluno.nome,
      treino_modo: aluno.treino_modo || 'nativo',
      treino_liberado: autorizacaoTreino.autorizado,
      treino_bloqueado_motivo: autorizacaoTreino.autorizado ? null : autorizacaoTreino.motivo,
      tem_rosto_cadastrado: Boolean(aluno.face_descriptor),
      plano_atual: matricula.rows[0] || null,
      primeiro_acesso: primeiroAcesso,
      senha_gerada: senhaGerada,
      // null = nunca perguntado (portal mostra o convite de opt-in) — ver
      // comentário em schema.sql junto da coluna.
      notificar_vencimento: aluno.notificar_vencimento,
      notificar_vencimento_dias_antes: aluno.notificar_vencimento_dias_antes,
      // 2026-07-31: dados pessoais crus (não só o nome) — o front usa isso pra
      // saber quais campos faltam preencher antes do 1o cadastro facial (ver
      // POST /completar-cadastro logo abaixo). Muitos alunos antigos vieram
      // de importação (Secullum) sem telefone/e-mail/data de nascimento, que
      // só passaram a ser obrigatórios pra cadastros NOVOS em 2026-07.
      dados_pessoais: {
        nome: aluno.nome || '',
        telefone: aluno.telefone || '',
        email: aluno.email || '',
        data_nascimento: aluno.data_nascimento || '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/portal/completar-cadastro { cpf, senha, nome, telefone, email,
// data_nascimento } — 2026-07-31: pedido do dono do sistema, ao mandar o link
// do portal pra todos os alunos via WhatsApp pra fazerem o cadastro facial:
// muitos alunos antigos (importados do Secullum antes de telefone/e-mail/data
// de nascimento serem obrigatórios) não têm esses dados no sistema. Antes de
// deixar o aluno cadastrar o rosto pela primeira vez, o front (ver
// camposFaltandoHub em portal.js) checa esses 4 campos e, se algum estiver
// vazio, mostra este formulário (pré-preenchido com o que já existe) antes de
// liberar a câmera — assim o cadastro completo do aluno fica em dia no mesmo
// momento em que ele mexe no portal pela primeira vez, sem precisar de uma
// campanha separada.
const completarCadastroSchema = z.object({
  cpf: z.string().min(1),
  senha: z.string().min(1),
  nome: z.string().min(2, 'Nome completo é obrigatório.'),
  telefone: z.string().min(8, 'Telefone é obrigatório.'),
  email: z.string().email('E-mail é obrigatório e precisa ser válido.'),
  data_nascimento: z.string().min(1, 'Data de nascimento é obrigatória.'),
});

router.post('/completar-cadastro', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = completarCadastroSchema.parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    await db.execute({
      sql: 'UPDATE alunos SET nome = ?, telefone = ?, email = ?, data_nascimento = ? WHERE id = ?',
      args: [dados.nome, dados.telefone, dados.email, dados.data_nascimento, aluno.id],
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/treino?cpf=...&senha=... — só usada quando treino_modo =
// 'nativo' (o link do app externo já vem em GET /api/config, campo treino_app_url).
router.get('/treino', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().min(1) }).parse(req.query);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    // Mesma regra de acesso da catraca (mensalidade em dia) — ver comentário
    // em GET /aluno acima. Bloqueia a rota mesmo que o front (que já esconde
    // o botão "Ver treino" nesse caso) seja contornado.
    const autorizacaoTreino = await acessoTerminal.verificarAutorizacaoAluno(aluno);
    if (!autorizacaoTreino.autorizado) {
      return res.status(403).json({ erro: autorizacaoTreino.motivo || 'Acesso ao treino bloqueado.', bloqueado: true });
    }

    // visivel_portal = 0: professor ocultou este treino específico pro aluno
    // (continua existindo/visível pro professor). data_fim vencido: fim do
    // período do treino, mesma ideia mas automática — ver schema.sql.
    const treinos = await db.execute({
      sql: `SELECT * FROM treinos WHERE aluno_id = ? AND ativo = 1 AND visivel_portal = 1
              AND (data_fim IS NULL OR data_fim >= date('now'))
            ORDER BY ordem, criado_em`,
      args: [aluno.id],
    });

    const resultado = [];
    for (const t of treinos.rows) {
      let dias = [];
      try { dias = t.dias_semana ? JSON.parse(t.dias_semana) : []; } catch { dias = []; }
      // Inclui vídeo/imagem/método/dica/concluído (port do TreinoPro, 2026-08)
      // pra o portal poder mostrar o vídeo de execução e o check de concluído.
      // 2026-08-24: "concluido" devolvido aqui é só o estado VISUAL do dia —
      // só vem 1 se foi marcado HOJE (date(concluido_em) = date('now')); um
      // exercício marcado ontem (ou antes) volta a aparecer desmarcado pro
      // aluno, mesmo com a linha ainda tendo concluido=1 no banco (o registro
      // permanente pro professor fica em treino_execucoes, nunca é afetado
      // por isso). Ver também POST /treino/:id/concluir-treino, que reseta
      // esse estado na hora (sem esperar virar o dia).
      const exercicios = await db.execute({
        sql: `SELECT id, exercicio, series, carga, intervalo, observacao, metodo, dica,
                     video_url, imagem_url, ultimo_peso_usado, ultimo_repeticoes_max,
                     CASE WHEN concluido = 1 AND date(concluido_em) = date('now') THEN 1 ELSE 0 END AS concluido
              FROM treino_exercicios WHERE treino_id = ? ORDER BY ordem, criado_em`,
        args: [t.id],
      });
      resultado.push({ id: t.id, nome: t.nome, dias_semana: dias, exercicios: exercicios.rows });
    }
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// Acima de quantas repetições o aluno consegue fazer o exercício sinaliza
// que a carga ficou fácil demais — pedido explícito do dono do sistema
// (2026-08-27): manda pro professor revisar via GET /api/pendencias (ver
// listarPendenciasAjusteCarga em pendencias.routes.js).
const LIMITE_REPETICOES_SEM_AJUSTE = 13;

// POST /api/portal/treino/exercicio/:id/concluir { cpf, senha, concluido, peso_usado?, repeticoes_max? } —
// o aluno marca/desmarca um exercício como feito, direto do portal. Só é
// permitido se o exercício pertencer a um treino do PRÓPRIO aluno
// autenticado (JOIN treino_exercicios -> treinos -> valida aluno_id) — o
// TreinoPro original tinha essa checagem frouxa (ver observação do relatório
// de port), então aqui já nasce corrigido.
//
// peso_usado/repeticoes_max (2026-08-27): opcionais, só fazem sentido junto
// com concluido=true — o aluno reporta quanto peso usou e o máximo de
// repetições que conseguiu, pro professor acompanhar evolução e ajustar a
// carga prescrita. Ficam gravados tanto na própria linha de
// treino_exercicios (ultimo_peso_usado/ultimo_repeticoes_max — pro professor
// bater o olho na aba Treinos sem consultar histórico) quanto em
// treino_execucoes (histórico completo, nunca apagado).
//
// carga (2026-09-02): pedido explícito do dono do sistema — o peso que o
// aluno reporta ter usado passa a SUBSTITUIR o campo "carga" (prescrito)
// automaticamente, não só ficar guardado à parte em ultimo_peso_usado. Assim
// a ficha do aluno (aqui embaixo) e a aba Treinos do professor (coluna
// "Carga" em app.js) já mostram o peso mais recente sem o professor precisar
// copiar manualmente de "Aluno reportou" pra "Carga". Isso fica valendo até
// o professor editar a carga de novo (PUT /exercicios/:id em
// treinos.routes.js, que sempre grava por cima) — o mesmo campo, só que
// agora com duas fontes de escrita: o aluno concluindo o exercício, e o
// professor ajustando manualmente.
router.post('/treino/exercicio/:id/concluir', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = z.object({
      cpf: z.string().min(1),
      senha: z.string().min(1),
      concluido: z.boolean(),
      peso_usado: z.string().trim().min(1).optional().nullable(),
      repeticoes_max: z.number().int().min(0).max(999).optional().nullable(),
    }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    const autorizacaoTreino = await acessoTerminal.verificarAutorizacaoAluno(aluno);
    if (!autorizacaoTreino.autorizado) {
      return res.status(403).json({ erro: autorizacaoTreino.motivo || 'Acesso ao treino bloqueado.', bloqueado: true });
    }

    const dono = await db.execute({
      sql: `SELECT te.id, t.id as treino_id FROM treino_exercicios te
            JOIN treinos t ON t.id = te.treino_id
            WHERE te.id = ? AND t.aluno_id = ?`,
      args: [req.params.id, aluno.id],
    });
    if (!dono.rows[0]) return res.status(404).json({ erro: 'Exercício não encontrado.' });

    // concluido_em (2026-08-24): grava QUANDO foi marcado — é o que permite o
    // portal mostrar o check só no dia em que foi feito (ver GET /treino
    // acima), sem precisar de nenhum job agendado de reset. Desmarcar limpa
    // os dois campos e não grava nada em treino_execucoes (só marcar =
    // "treinou de verdade" conta pro log permanente do professor). Usa
    // datetime('now') do próprio SQLite (em vez de gerar a string em JS) pelo
    // mesmo motivo documentado em todo o resto do projeto: uma string ISO
    // gerada aqui ("...T...Z") ordena/compara errado contra as gravadas pelo
    // banco — ver src/utils/data.js e o comentário de corrigirFormatoDatasAcessosAntigos em migrate.js.
    const concluidoInt = dados.concluido ? 1 : 0;
    const precisaAjuste = dados.concluido && dados.repeticoes_max != null && dados.repeticoes_max > LIMITE_REPETICOES_SEM_AJUSTE;
    const atualizaCarga = dados.concluido && !!dados.peso_usado;
    await db.execute({
      sql: `UPDATE treino_exercicios
            SET concluido = ?, concluido_em = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
                ultimo_peso_usado = CASE WHEN ? = 1 THEN ? ELSE ultimo_peso_usado END,
                ultimo_repeticoes_max = CASE WHEN ? = 1 THEN ? ELSE ultimo_repeticoes_max END,
                carga = CASE WHEN ? THEN ? ELSE carga END,
                precisa_ajuste_carga = CASE WHEN ? THEN 1 ELSE precisa_ajuste_carga END
            WHERE id = ?`,
      args: [
        concluidoInt, concluidoInt,
        concluidoInt, dados.peso_usado || null,
        concluidoInt, dados.repeticoes_max ?? null,
        atualizaCarga ? 1 : 0, dados.peso_usado || null,
        precisaAjuste ? 1 : 0,
        req.params.id,
      ],
    });

    let conquistasNovas = [];
    if (dados.concluido) {
      await db.execute({
        sql: `INSERT INTO treino_execucoes (id, aluno_id, treino_id, treino_exercicio_id, tipo, peso_usado, repeticoes_max)
              VALUES (?, ?, ?, ?, 'exercicio', ?, ?)`,
        args: [uuid(), aluno.id, dono.rows[0].treino_id, req.params.id, dados.peso_usado || null, dados.repeticoes_max ?? null],
      });
      conquistasNovas = await gamificacao.verificarConquistas(aluno.id);
    }

    res.json({ ok: true, conquistas_novas: conquistasNovas });
  } catch (err) {
    next(err);
  }
});

// POST /api/portal/treino/:id/concluir-treino { cpf, senha } — botão "Concluir
// treino" do portal: registra no log permanente (treino_execucoes, tipo
// 'treino_concluido') que o aluno terminou a sessão de hoje, e IMEDIATAMENTE
// limpa o check de todos os exercícios desse treino (concluido/concluido_em),
// sem esperar virar o dia — pra ele poder marcar de novo na próxima vez que
// treinar, mesmo se for ainda hoje (ex.: aluno que treina 2x no mesmo dia).
router.post('/treino/:id/concluir-treino', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = z.object({ cpf: z.string().min(1), senha: z.string().min(1) }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    const autorizacaoTreino = await acessoTerminal.verificarAutorizacaoAluno(aluno);
    if (!autorizacaoTreino.autorizado) {
      return res.status(403).json({ erro: autorizacaoTreino.motivo || 'Acesso ao treino bloqueado.', bloqueado: true });
    }

    const dono = await db.execute({
      sql: 'SELECT id FROM treinos WHERE id = ? AND aluno_id = ?',
      args: [req.params.id, aluno.id],
    });
    if (!dono.rows[0]) return res.status(404).json({ erro: 'Treino não encontrado.' });

    await db.execute({
      sql: `INSERT INTO treino_execucoes (id, aluno_id, treino_id, treino_exercicio_id, tipo)
            VALUES (?, ?, ?, NULL, 'treino_concluido')`,
      args: [uuid(), aluno.id, req.params.id],
    });
    await db.execute({
      sql: 'UPDATE treino_exercicios SET concluido = 0, concluido_em = NULL WHERE treino_id = ?',
      args: [req.params.id],
    });
    const conquistasNovas = await gamificacao.verificarConquistas(aluno.id);

    res.json({ ok: true, aluno_nome: aluno.nome, conquistas_novas: conquistasNovas });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/gamificacao?cpf=...&senha=... — streak (semanas seguidas
// treinando), total de treinos e a vitrine de badges (desbloqueadas e
// bloqueadas) pra tela "Meu progresso" do portal (ver
// src/services/gamificacao.service.js).
router.get('/gamificacao', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().min(1) }).parse(req.query);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    res.json(await gamificacao.obterResumoGamificacao(autenticado.aluno.id));
  } catch (err) {
    next(err);
  }
});

// Cooldown por aluno+contexto (2026-09-02, ajustado 2026-09-04) — evita
// martelar as notificações push do staff se o mesmo aluno clicar "Chamar
// professor" várias vezes seguidas PRO MESMO exercício (ou pro botão
// flutuante geral). A chave inclui o exercício de propósito: um aluno que
// chama, troca de exercício e chama de novo é um pedido NOVO de verdade
// (quer que o professor saiba que mudou de estação), não deve ficar preso
// no cooldown do exercício anterior — relatado como bug real ("troquei de
// exercício e o chamado novo não chegou"). Em memória, reinicia a cada
// deploy/restart (mesmo espírito do cooldown por equipamento em
// notificarInstrutor.service.js) — suficiente pro caso de uso.
const ultimoChamadoProfessorPorAlunoContexto = new Map();
const COOLDOWN_CHAMAR_PROFESSOR_MS = 60 * 1000;

// "HH:MM" comparado como texto funciona igual comparação de horário (os
// dois lados são sempre zero-padded) — suporta janela que vira a virada da
// meia-noite (ex.: 22:00–06:00) e é reaproveitado tanto pro horário geral
// quanto pra pausa (ex.: almoço) do "Chamar professor" abaixo.
function horaDentroDaJanela(hora, inicio, fim) {
  return inicio <= fim ? (hora >= inicio && hora <= fim) : (hora >= inicio || hora <= fim);
}

// POST /api/portal/chamar-professor { cpf, senha, exercicio? } — botão
// "Chamar professor" do portal (2026-09-02). Usa a MESMA infraestrutura de
// Web Push já validada e funcionando pros avisos de vencimento do aluno
// (webPush.service.js, mesmas chaves VAPID/service worker) — não o Telegram
// das tags NFC (nunca chegou a ser configurado em produção, ver
// notificarInstrutor.service.js/NFC-CHAMAR-INSTRUTOR.md), a pedido do dono
// ("use notificações normais, já existe sistema funcionando"). Manda pra
// TODO usuário do painel que tiver ativado notificações neste aparelho
// (enviarParaTodoStaff — sem roteamento por professor específico, academia
// pequena). `exercicio` (opcional) é o nome do exercício em foco no player
// do treino no momento do clique — quando vem preenchido, quem receber o
// aviso já sabe de cara em qual estação/exercício aquele aluno está.
router.post('/chamar-professor', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = z.object({
      cpf: z.string().min(1),
      senha: z.string().min(1),
      exercicio: z.string().trim().min(1).max(120).optional().nullable(),
    }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    // Horário permitido (2026-09-04, pedido do dono) — configurável em
    // Configurações > Chamar professor, desligado por padrão. Checa ANTES
    // do cooldown de propósito: fora do horário nem consome o "slot" do
    // cooldown, senão o primeiro clique de manhã cedo bloquearia o
    // primeiro clique de verdade assim que a academia abrir.
    const configHorario = await obterConfigChamarProfessor();
    if (configHorario.restrito || configHorario.pausaAtiva) {
      const horaAtual = await db.execute("SELECT strftime('%H:%M', datetime('now', '-3 hours')) as hora");
      const hora = horaAtual.rows[0].hora;

      if (configHorario.restrito && !horaDentroDaJanela(hora, configHorario.horaInicio, configHorario.horaFim)) {
        return res.status(403).json({ erro: `O professor só pode ser chamado pelo portal entre ${configHorario.horaInicio} e ${configHorario.horaFim}.` });
      }
      // Pausa (ex.: almoço) — bloqueia mesmo estando dentro do horário
      // geral acima. Checada em separado (não é "senão" do if de cima) pra
      // funcionar mesmo se `restrito` estiver desligado mas a pausa ligada
      // sozinha (ex.: academia abre 24h, só quer bloquear no horário de
      // almoço do professor).
      if (configHorario.pausaAtiva && horaDentroDaJanela(hora, configHorario.pausaInicio, configHorario.pausaFim)) {
        return res.status(403).json({ erro: `O professor está em pausa (${configHorario.pausaInicio} às ${configHorario.pausaFim}). Tente novamente depois, ou procure a recepção.` });
      }
    }

    const chaveContexto = `${aluno.id}|${dados.exercicio || 'geral'}`;
    const ultimoChamado = ultimoChamadoProfessorPorAlunoContexto.get(chaveContexto);
    if (ultimoChamado && (Date.now() - ultimoChamado) < COOLDOWN_CHAMAR_PROFESSOR_MS) {
      return res.json({ enviados: 0, motivo: 'cooldown' });
    }
    ultimoChamadoProfessorPorAlunoContexto.set(chaveContexto, Date.now());

    const corpo = dados.exercicio ? `${aluno.nome} está precisando de ajuda em: ${dados.exercicio}` : `${aluno.nome} está chamando pelo portal.`;
    // `tag` inclui o contexto de propósito: duas chamadas com tags
    // diferentes (ex.: exercícios diferentes) aparecem como notificações
    // SEPARADAS (cada uma re-alerta de verdade); a mesma tag só substitui
    // a anterior — correto pra "chamei de novo pro mesmo exercício", errado
    // pra "troquei de exercício e chamei de novo" (que precisa alertar).
    try {
      const resultado = await webPush.enviarParaTodoStaff({ titulo: '🙋 Chamado do aluno', corpo, url: '/index.html', tag: `chamar-professor-${chaveContexto}` });
      res.json(resultado);
    } catch (erroChamado) {
      // Falha ao avisar (VAPID não configurado, nenhum staff inscrito, etc.)
      // — nunca expõe detalhe técnico pro aluno, sempre dá um caminho
      // alternativo.
      console.error('[chamar-professor] erro ao notificar via portal:', erroChamado.message);
      res.status(503).json({ erro: 'Não consegui avisar o professor agora. Peça ajuda diretamente na recepção.' });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/avaliacoes?cpf=...&senha=... — histórico de avaliação
// física do aluno, vindo do AvaliaPro (mesmo banco, tabelas `avaliandos` e
// `avaliacoes` — ver ../../../avaliapro/src/db/schema.sql). Substitui, do
// ponto de vista do aluno, a antiga `avaliacoes_fisicas` (que nunca foi
// exposta ao aluno, só ao staff no painel — ver app.js `#lista-avaliacoes`).
//
// Mesma autenticação de sempre no portal: CPF + a senha sequencial
// (biometria_id), sem token JWT — este endpoint não passa pelo router do
// AvaliaPro (que é para o staff, protegido por `autenticar`/JWT); lê as
// tabelas dele diretamente, com o MESMO `db` já usado no resto deste
// arquivo, porque é o mesmo banco físico.
//
// Se o aluno nunca teve nenhuma avaliação registrada (ainda não existe
// espelho dele em `avaliandos`, porque staff nunca abriu a ficha), devolve
// lista vazia — não é erro, é "ainda não avaliado".
router.get('/avaliacoes', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().min(1) }).parse(req.query);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    const espelho = await db.execute({
      sql: `SELECT id FROM avaliandos WHERE origem='academia' AND externo_id=?`,
      args: [aluno.id],
    });
    if (!espelho.rows.length) return res.json({ avaliacoes: [] });

    const linhas = await db.execute({
      sql: `SELECT tipo, protocolo, data, fields_json, computed_json, origem
            FROM avaliacoes WHERE avaliando_id=? ORDER BY data ASC, created_at ASC`,
      args: [espelho.rows[0].id],
    });

    res.json({
      avaliacoes: linhas.rows.map((r) => ({
        tipo: r.tipo,
        protocolo: r.protocolo,
        data: r.data,
        origem: r.origem,
        fields: JSON.parse(r.fields_json || '{}'),
        computed: JSON.parse(r.computed_json || '{}'),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Limite dedicado e mais apertado pra /vincular/facial (além do limite geral
// do portal acima): é a rota mais sensível — quem souber o CPF de outra
// pessoa pode tentar vincular o PRÓPRIO rosto ao cadastro dela (ver análise de
// segurança, item 5). Não impede um ataque direcionado isolado, mas
// inviabiliza automação em massa contra vários CPFs.
const limitadorVincularFacial = criarLimitador({
  janelaMs: 60 * 60 * 1000,
  maximo: 5,
  mensagem: 'Muitas tentativas de cadastro facial para este CPF. Procure a recepção se o problema persistir.',
  chavePor: (req) => `${req.ip}:${req.body?.cpf || ''}`,
});

// POST /api/portal/vincular/facial { cpf, descriptor } — cadastra o rosto do
// aluno remotamente (com a câmera do próprio celular/PC), pra reconhecimento
// facial já funcionar na próxima vez que ele chegar ao totem físico.
//
// IMPORTANTE (ver análise de segurança, item 5): como a única prova de
// identidade aqui é o CPF, esta rota conseguia SOBRESCREVER um rosto já
// cadastrado sem confirmar que era a mesma pessoa — alguém que soubesse o CPF
// de um aluno podia vincular o próprio rosto ao cadastro dele. Decisão do
// dono do sistema (2026-07-07): bloquear por completo a sobrescrita remota.
// Se o aluno já tem um rosto cadastrado, esta rota recusa (409) — trocar o
// rosto cadastrado passa a exigir a recepção (painel -> perfil do aluno ->
// aba "Biometria & acesso" -> remover e recadastrar pela câmera do PC).
router.post('/vincular/facial', limitadorVincularFacial, async (req, res, next) => {
  try {
    const { cpf, senha, descriptor, foto } = z.object({
      cpf: z.string().min(1),
      senha: z.string().min(1),
      descriptor: z.array(z.number()).length(128), // 128 = tamanho do embedding do SFace (ver public/facial-sface.js)
      // Foto de perfil (data URL JPEG, comprimida no cliente). Opcional, e só
      // preenche foto_url se o aluno ainda não tiver uma (ver salvarFaceDescriptor).
      foto: z.string().max(500000).optional().nullable(),
    }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    if (aluno.face_descriptor) {
      await acessoTerminal.registrarAcesso({
        alunoId: aluno.id,
        metodo: 'vincular_facial_portal',
        resultado: 'negado',
        mensagem: 'Tentativa de sobrescrever reconhecimento facial já cadastrado, pelo portal (CPF) — bloqueada.',
      });
      return res.status(409).json({
        erro: 'Este cadastro já tem um reconhecimento facial vinculado. Para trocar, procure a recepção.',
      });
    }

    await acessoTerminal.salvarFaceDescriptor(aluno.id, descriptor, foto);
    await acessoTerminal.registrarAcesso({
      alunoId: aluno.id,
      metodo: 'vincular_facial_portal',
      resultado: 'liberado',
      mensagem: 'Primeiro cadastro de reconhecimento facial pelo portal (CPF).',
    });

    res.json({ ok: true, aluno_nome: aluno.nome });
  } catch (err) {
    next(err);
  }
});

// ---------------- Pagamento de contas em atraso (mesmo serviço do totem) ----------------
// Única diferença: liberarAcesso é SEMPRE false aqui — o valor vindo do corpo
// da requisição (se houver) é ignorado de propósito, por segurança.

router.post('/contas/consultar', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().min(1) }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });

    const resultado = await pagamentoContas.consultarContasAbertas(cpf);
    if (!resultado) return res.status(404).json({ erro: 'CPF não encontrado.' });
    res.json({ aluno_id: resultado.aluno.id, aluno_nome: resultado.aluno.nome, contas: resultado.contas });
  } catch (err) {
    next(err);
  }
});

router.post('/contas/pagar', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = z.object({
      cpf: z.string().min(1),
      senha: z.string().min(1),
      cobranca_ids: z.array(z.string()).min(1),
    }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });

    const resultado = await pagamentoContas.criarPagamentoAgregado({
      cpf: dados.cpf,
      cobrancaIds: dados.cobranca_ids,
      liberarAcesso: false, // portal remoto NUNCA aciona a catraca
    });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});

router.get('/contas/status/:pagamentoId', async (req, res, next) => {
  try {
    const resultado = await pagamentoContas.consultarStatusPagamento(req.params.pagamentoId);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ---------------- Cadastro novo (dados + plano -> Pix -> ativa matrícula) ----------------
// Mesmo fluxo do totem (ver terminal.routes.js /auto-cadastro), mas o status
// de confirmação aqui NUNCA chama acessoTerminal.tentarLiberar (sem catraca).

// 2026-07: nome, e-mail, telefone e data de nascimento passaram a ser
// obrigatórios também no portal (mesma decisão do totem, ver
// terminal.routes.js) — antes só nome e CPF eram exigidos.
const cadastroSchema = z.object({
  nome: z.string().min(2),
  cpf: z.string().min(1).transform(normalizarCpf),
  telefone: z.string().min(8, 'Telefone é obrigatório.'),
  email: z.string().email('E-mail é obrigatório e precisa ser válido.'),
  data_nascimento: z.string().min(1, 'Data de nascimento é obrigatória.'),
  plano_id: z.string().min(1),
  // Preenchido só quando um aluno indica um amigo pelo próprio portal (mesmo
  // mecanismo do totem — ver terminal.routes.js /auto-cadastro).
  indicado_por_cpf: z.string().optional().nullable(),
});

router.post('/cadastro', async (req, res, next) => {
  try {
    const dados = cadastroSchema.parse(req.body);

    // 2026-08-04: trava em memória contra duas requisições simultâneas com o
    // mesmo CPF (ver comentário completo em acessoTerminal.service.js, junto
    // de reservarCpfParaCadastro/liberarCpfDoCadastro) — fecha por completo a
    // corrida que a reordenação abaixo só reduzia.
    if (!acessoTerminal.reservarCpfParaCadastro(dados.cpf)) {
      return res.status(409).json({ erro: 'Este CPF já está sendo cadastrado agora. Aguarde um instante e tente novamente.' });
    }

    try {
    const existente = await acessoTerminal.buscarAlunoPorCpf(dados.cpf);
    if (existente) {
      return res.status(409).json({ erro: 'Este CPF já tem cadastro. Use "Já sou aluno" para consultar suas contas e treino.' });
    }

    // ---------------- Fluxo "Indicar visitante/amigo" pelo portal (2026-07) ----------------
    // Mesmo mecanismo do totem (ver terminal.routes.js): sem Pix, sem
    // matrícula, sem cobrança — só o cadastro em si, com categoria='visitante'
    // e, se veio de uma indicação, o vínculo + checagem do limite mensal.
    if (dados.plano_id === PLANO_VISITANTE_ID) {
      let indicadoPorAlunoId = null;
      if (dados.indicado_por_cpf) {
        const indicador = await acessoTerminal.buscarAlunoPorCpf(dados.indicado_por_cpf);
        if (!indicador) {
          return res.status(404).json({ erro: 'CPF de quem está indicando não foi encontrado. Confirme com a recepção.' });
        }
        const [limiteMensal, jaIndicados] = await Promise.all([
          acessoTerminal.limiteIndicacoesMensalEm(db),
          acessoTerminal.contarIndicacoesNoMes(indicador.id),
        ]);
        if (jaIndicados >= limiteMensal) {
          return res.status(409).json({
            erro: `Limite de ${limiteMensal} indicação${limiteMensal === 1 ? '' : 'ões'} por mês atingido para este aluno. Procure a recepção.`,
          });
        }
        indicadoPorAlunoId = indicador.id;
      }

      const alunoId = uuid();
      await db.execute({
        sql: `INSERT INTO alunos (id, nome, email, telefone, cpf, data_nascimento, status, categoria, indicado_por_aluno_id)
              VALUES (?, ?, ?, ?, ?, ?, 'ativo', 'visitante', ?)`,
        args: [alunoId, dados.nome, dados.email, dados.telefone, dados.cpf, dados.data_nascimento, indicadoPorAlunoId],
      });

      // E-mail específico do visitante (2026-07-19, mesmo motivo do totem —
      // ver terminal.routes.js e o comentário completo em
      // emailBoasVindas.service.js): nunca manda a senha do Portal do Aluno.
      emailBoasVindas.enviarBoasVindasVisitanteSeguro({ id: alunoId, nome: dados.nome, email: dados.email }).catch(() => {});

      return res.status(201).json({
        visitante: true,
        aluno_id: alunoId,
        aluno_nome: dados.nome,
        indicado_por_aluno_id: indicadoPorAlunoId,
      });
    }

    const plano = await db.execute({ sql: 'SELECT * FROM planos WHERE id = ? AND ativo = 1', args: [dados.plano_id] });
    const p = plano.rows[0];
    if (!p) return res.status(404).json({ erro: 'Plano não encontrado ou inativo.' });

    // 2026-08-04 (bug real: cadastros duplicados relatado pelo dono do
    // sistema — várias pessoas com 2-3 cadastros idênticos, criados 1-2s um
    // do outro): antes, o aluno só era gravado DEPOIS de chamar a API do
    // Mercado Pago (criarOrderPix) — uma chamada externa que pode demorar
    // segundos. Nesse intervalo, se a pessoa confirmasse o cadastro mais de
    // uma vez (fácil de acontecer sem feedback claro de "processando"),
    // AMBAS as tentativas passavam pela checagem de CPF acima (nenhuma
    // tinha gravado ainda) e criavam cadastros duplicados — cada um com sua
    // própria matrícula/cobrança pendente. Agora o aluno é criado JÁ AQUI,
    // logo após a checagem — fecha quase toda a janela da corrida (sobra só
    // o tempo de uma consulta ao banco, não mais o de uma chamada de rede
    // externa). Se o Mercado Pago falhar depois, o cadastro é desfeito (ver
    // catch abaixo) pra pessoa poder tentar de novo com o mesmo CPF.
    const alunoId = uuid();
    try {
      await db.execute({
        sql: `INSERT INTO alunos (id, nome, email, telefone, cpf, data_nascimento, status)
              VALUES (?, ?, ?, ?, ?, ?, 'ativo')`,
        args: [alunoId, dados.nome, dados.email, dados.telefone, dados.cpf, dados.data_nascimento],
      });
    } catch (err) {
      // Corrida apertadíssima (as duas tentativas chegaram entre a checagem
      // acima e esta gravação) — mesma mensagem amigável de sempre, em vez
      // de estourar um erro genérico.
      return res.status(409).json({ erro: 'Este CPF já tem cadastro. Use "Já sou aluno" para consultar suas contas e treino.' });
    }

    const cobrancaId = uuid();
    const descricao = `Matrícula - ${p.nome}`;

    const emailTeste = process.env.MERCADOPAGO_TEST_PAYER_EMAIL;
    const emailPagador = emailTeste || dados.email || `aluno-${dados.cpf.replace(/\D/g, '')}@academia-gestao.com`;
    const firstNamePagador = emailTeste ? 'APRO' : undefined;

    let order;
    try {
      order = await mercadopago.criarOrderPix({
        descricao,
        valorCentavos: p.valor_centavos,
        referenciaExterna: cobrancaId,
        email: emailPagador,
        firstName: firstNamePagador,
      });
    } catch (err) {
      // Desfaz o cadastro pra não deixar o CPF "preso" (cadastrado, mas sem
      // nenhuma cobrança pra pagar) — a pessoa tenta de novo do zero.
      await db.execute({ sql: 'DELETE FROM alunos WHERE id = ?', args: [alunoId] }).catch(() => {});
      throw err;
    }
    const metodoPix = order.transactions?.payments?.[0]?.payment_method || {};

    // E-mail de boas-vindas automático (2026-07) — best-effort, nunca atrasa
    // nem quebra o cadastro/pagamento em si (ver emailBoasVindas.service.js).
    emailBoasVindas.enviarBoasVindasSeguro({ id: alunoId, nome: dados.nome, email: dados.email }).catch(() => {});

    const hoje = new Date().toISOString().slice(0, 10);
    const dataFim = p.duracao_dias ? new Date(Date.now() + p.duracao_dias * 86400000).toISOString().slice(0, 10) : null;

    const matriculaId = uuid();
    await db.execute({
      sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, data_fim, status, renovacao_automatica)
            VALUES (?, ?, ?, ?, ?, 'pendente', 1)`,
      args: [matriculaId, alunoId, p.id, hoje, dataFim],
    });

    // Vencimento sempre dia 10 ou 20 (2026-09-02, pedido do dono — cartaz
    // "só existem 2 datas de vencimento"), só pra planos recorrentes de
    // verdade — ver mesmo comentário em planos.routes.js.
    const vencimentoCobranca = ehRecorrente(p.tipo) ? primeiroVencimento(hoje) : hoje;
    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, provedor, provedor_referencia, descricao, vencimento)
            VALUES (?, ?, ?, ?, 'mercadopago', ?, ?, ?)`,
      args: [cobrancaId, alunoId, matriculaId, p.valor_centavos, String(order.id), descricao, vencimentoCobranca],
    });

    // Senha do portal (2026-07): já gera o código sequencial de uma vez
    // (mesmo padrão do "cartão" da catraca, ver acessoTerminal.service.js) e
    // marca como revelada — o aluno já sai do cadastro sabendo sua senha,
    // sem precisar de um "primeiro acesso" separado depois.
    const senhaAcesso = await acessoTerminal.atribuirCodigoAluno(alunoId);
    await db.execute({ sql: 'UPDATE alunos SET portal_senha_revelada = 1 WHERE id = ?', args: [alunoId] });

    res.status(201).json({
      cobranca_id: cobrancaId,
      qr_code_pix: metodoPix.qr_code || null,
      qr_code_pix_imagem: metodoPix.qr_code_base64 || null,
      valor_centavos: p.valor_centavos,
      aluno_nome: dados.nome,
      senha_acesso: senhaAcesso,
    });
    } finally {
      acessoTerminal.liberarCpfDoCadastro(dados.cpf);
    }
  } catch (err) {
    next(err);
  }
});

// Ativa a matrícula ligada a uma cobrança quando o pagamento é confirmado —
// versão sem catraca, reaproveitada pelo /cadastro/status e pelo /upgrade/status.
async function confirmarPagamentoEAtivarMatricula(cobrancaId) {
  const cobrancaResult = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [cobrancaId] });
  let c = cobrancaResult.rows[0];
  if (!c) throw Object.assign(new Error('Cobrança não encontrada.'), { status: 404 });

  if (c.status !== 'pago' && c.provedor === 'mercadopago' && c.provedor_referencia) {
    try {
      const order = await mercadopago.consultarOrder(c.provedor_referencia);
      const pagamentoOrder = order.transactions?.payments?.[0] || {};
      const aprovado = order.status === 'processed' || pagamentoOrder.status === 'approved';
      if (aprovado) {
        await db.execute({
          sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = 'pix', pago_em = datetime('now') WHERE id = ?`,
          args: [c.id],
        });
        c = { ...c, status: 'pago' };
      }
    } catch (err) {
      // falha pontual na consulta — quem chamou tenta de novo no próximo poll
    }
  }

  if (c.status !== 'pago') return { pago: false };

  if (c.matricula_id) {
    await db.execute({ sql: `UPDATE matriculas SET status = 'ativa' WHERE id = ? AND status = 'pendente'`, args: [c.matricula_id] });
  }

  const alunoResult = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [c.aluno_id] });
  const aluno = alunoResult.rows[0];
  if (!aluno) throw Object.assign(new Error('Aluno não encontrado.'), { status: 404 });

  return { pago: true, aluno_nome: aluno.nome };
}

// GET /api/portal/cadastro/status/:cobrancaId — o portal faz polling aqui
// enquanto espera o Pix. Sem catraca: só confirma o pagamento e ativa a
// matrícula (a entrada física continua dependendo do totem/recepção).
router.get('/cadastro/status/:cobrancaId', async (req, res, next) => {
  try {
    const resultado = await confirmarPagamentoEAtivarMatricula(req.params.cobrancaId);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ---------------- Upgrade/troca de plano (aluno já cadastrado) ----------------
// "Assinar" um novo plano direto de casa: cria uma matrícula nova (pendente
// até o Pix confirmar) — não mexe na matrícula atual, então a equipe decide
// depois se cancela a antiga (evita encerrar um plano em dia sem querer).

router.post('/upgrade', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = z.object({
      cpf: z.string().min(1),
      senha: z.string().min(1),
      plano_id: z.string().min(1),
    }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    const plano = await db.execute({ sql: 'SELECT * FROM planos WHERE id = ? AND ativo = 1', args: [dados.plano_id] });
    const p = plano.rows[0];
    if (!p) return res.status(404).json({ erro: 'Plano não encontrado ou inativo.' });

    const existente = await db.execute({
      sql: `SELECT id FROM matriculas WHERE aluno_id = ? AND plano_id = ? AND status IN ('ativa', 'pendente')`,
      args: [aluno.id, dados.plano_id],
    });
    if (existente.rows[0]) {
      return res.status(409).json({ erro: 'Você já tem uma matrícula ativa ou pendente neste plano.' });
    }

    const cobrancaId = uuid();
    const descricao = `Matrícula - ${p.nome}`;

    const emailTeste = process.env.MERCADOPAGO_TEST_PAYER_EMAIL;
    const emailPagador = emailTeste || aluno.email || `aluno-${String(aluno.cpf).replace(/\D/g, '')}@academia-gestao.com`;
    const firstNamePagador = emailTeste ? 'APRO' : undefined;

    const order = await mercadopago.criarOrderPix({
      descricao,
      valorCentavos: p.valor_centavos,
      referenciaExterna: cobrancaId,
      email: emailPagador,
      firstName: firstNamePagador,
    });
    const metodoPix = order.transactions?.payments?.[0]?.payment_method || {};

    const hoje = new Date().toISOString().slice(0, 10);
    const dataFim = p.duracao_dias ? new Date(Date.now() + p.duracao_dias * 86400000).toISOString().slice(0, 10) : null;

    const matriculaId = uuid();
    await db.execute({
      sql: `INSERT INTO matriculas (id, aluno_id, plano_id, data_inicio, data_fim, status, renovacao_automatica)
            VALUES (?, ?, ?, ?, ?, 'pendente', 1)`,
      args: [matriculaId, aluno.id, p.id, hoje, dataFim],
    });

    // Vencimento sempre dia 10 ou 20 (2026-09-02, pedido do dono — cartaz
    // "só existem 2 datas de vencimento"), só pra planos recorrentes de
    // verdade — ver mesmo comentário em planos.routes.js.
    const vencimentoCobranca = ehRecorrente(p.tipo) ? primeiroVencimento(hoje) : hoje;
    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, provedor, provedor_referencia, descricao, vencimento)
            VALUES (?, ?, ?, ?, 'mercadopago', ?, ?, ?)`,
      args: [cobrancaId, aluno.id, matriculaId, p.valor_centavos, String(order.id), descricao, vencimentoCobranca],
    });

    res.status(201).json({
      cobranca_id: cobrancaId,
      qr_code_pix: metodoPix.qr_code || null,
      qr_code_pix_imagem: metodoPix.qr_code_base64 || null,
      valor_centavos: p.valor_centavos,
      aluno_nome: aluno.nome,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/upgrade/status/:cobrancaId', async (req, res, next) => {
  try {
    const resultado = await confirmarPagamentoEAtivarMatricula(req.params.cobrancaId);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Web Push (2026-08-13) — notificações que chegam mesmo com o portal fechado.
// Mesmo padrão de autenticação do resto deste arquivo (cpf+senha por
// requisição, sem sessão) — ver autenticarAlunoPortal() no topo.
// ---------------------------------------------------------------------------

// GET /api/portal/push/vapid-public-key — pública de propósito (o front
// precisa dela ANTES de saber quem é o aluno, só pra montar a subscription
// do navegador). Não expõe nada sensível, é uma chave pública por design.
router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: webPush.chavePublicaVapid(), habilitado: webPush.pushHabilitado() });
});

const pushSubscriptionSchema = z.object({
  cpf: z.string().min(1),
  senha: z.string().min(1),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});

// POST /api/portal/push/subscribe — chamado toda vez que o front garante a
// inscrição (não só na primeira vez), então usa UPSERT por endpoint: se o
// mesmo aparelho já tinha uma subscription salva (ex.: reconectando depois
// de uma rotação de chave VAPID), atualiza em vez de duplicar. Também é
// assim que uma troca de aluno no MESMO aparelho transfere o endpoint pro
// novo dono, igual documentado no skill de web push — comportamento
// aceitável aqui (portal não tem conceito de "sessões simultâneas").
router.post('/push/subscribe', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = pushSubscriptionSchema.parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });
    const aluno = autenticado.aluno;

    await db.execute({
      sql: `INSERT INTO push_subscriptions (id, aluno_id, endpoint, p256dh, auth, user_agent)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET aluno_id = excluded.aluno_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      args: [
        uuid(), aluno.id, dados.subscription.endpoint, dados.subscription.keys.p256dh,
        dados.subscription.keys.auth, req.headers['user-agent'] || null,
      ],
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/portal/notificacoes-preferencia { cpf, senha, notificar_vencimento, dias_antes? }
// — grava a resposta do convite de opt-in (ver notificar_vencimento em
// schema.sql) e, opcionalmente, o prazo escolhido em Configurações. Não
// mexe em push_subscriptions — ativar/desativar a inscrição de verdade no
// navegador é sempre uma chamada separada em /push/subscribe|unsubscribe
// (esta rota só grava a PREFERÊNCIA declarada, que o job de aviso de
// vencimento consulta pra decidir quem notificar).
const notificacoesPreferenciaSchema = z.object({
  cpf: z.string().min(1),
  senha: z.string().min(1),
  notificar_vencimento: z.boolean(),
  dias_antes: z.number().int().min(1).max(30).optional(),
});

router.post('/notificacoes-preferencia', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = notificacoesPreferenciaSchema.parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });

    if (dados.dias_antes) {
      await db.execute({
        sql: 'UPDATE alunos SET notificar_vencimento = ?, notificar_vencimento_dias_antes = ? WHERE id = ?',
        args: [dados.notificar_vencimento ? 1 : 0, dados.dias_antes, autenticado.aluno.id],
      });
    } else {
      await db.execute({
        sql: 'UPDATE alunos SET notificar_vencimento = ? WHERE id = ?',
        args: [dados.notificar_vencimento ? 1 : 0, autenticado.aluno.id],
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/portal/push/unsubscribe { cpf, senha, endpoint } — chamado
// quando o aluno desliga notificações explicitamente nas Configurações.
router.post('/push/unsubscribe', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const dados = z.object({ cpf: z.string().min(1), senha: z.string().min(1), endpoint: z.string().url() }).parse(req.body);
    const autenticado = await autenticarAlunoPortal(dados.cpf, dados.senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });

    await db.execute({
      sql: 'DELETE FROM push_subscriptions WHERE aluno_id = ? AND endpoint = ?',
      args: [autenticado.aluno.id, dados.endpoint],
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/banners?cpf=&senha= — banners ativos aplicáveis a este
// aluno (2026-08-14, ver Recuperação de Clientes > Banners). "Some 1h
// depois de aberto" é decidido no cliente, não aqui — este endpoint sempre
// devolve todos os banners ativos aplicáveis, o front filtra pelo que já
// viu há mais de 1h (ver public/portal.js).
router.get('/banners', limitadorSenhaPortal, async (req, res, next) => {
  try {
    const { cpf, senha } = z.object({ cpf: z.string().min(1), senha: z.string().min(1) }).parse(req.query);
    const autenticado = await autenticarAlunoPortal(cpf, senha);
    if (autenticado.erro) return res.status(autenticado.status).json({ erro: autenticado.erro });

    const result = await db.execute(
      'SELECT id, titulo, texto, imagem_url, aluno_ids_json FROM banners_portal WHERE ativo = 1 ORDER BY criado_em DESC',
    );
    const banners = result.rows
      .filter((b) => {
        if (!b.aluno_ids_json) return true; // null = todos os alunos
        try { return JSON.parse(b.aluno_ids_json).includes(autenticado.aluno.id); } catch { return false; }
      })
      .map((b) => ({ id: b.id, titulo: b.titulo, texto: b.texto, imagem_url: b.imagem_url }));

    res.json({ banners });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
