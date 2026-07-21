const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const { autenticar, apenasAdmin, autenticarTerminal, autenticarTerminalOuCadastroPublico } = require('../middleware/auth');
const catracaGateway = require('../services/catracaGateway.service');
const acessoTerminal = require('../services/acessoTerminal.service');
const mercadopago = require('../services/payment/mercadopago.service');
const pagamentoContas = require('../services/pagamentoContas.service');
const emailBoasVindas = require('../services/emailBoasVindas.service');
const { criarLimitador } = require('../middleware/rateLimit');
const db = require('../db/client');

const router = express.Router();

// ---------------------------------------------------------------------------
// Rota pública: página "meu acesso" (QR pessoal / cartão de embarque do aluno)
// Sem autenticação de propósito — a própria posse do código já é a prova de
// identidade (como um link de embarque). Só expõe o primeiro nome.
// ---------------------------------------------------------------------------
router.get('/meu-acesso/:codigo', async (req, res, next) => {
  try {
    const aluno = await acessoTerminal.buscarAlunoPorCodigoAcesso(req.params.codigo);
    if (!aluno) return res.status(404).json({ erro: 'Código de acesso inválido.' });
    const primeiroNome = (aluno.nome || '').split(' ')[0];
    res.json({ nome: primeiroNome, codigo_acesso: aluno.codigo_acesso });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Rotas do totem (autenticadas por segredo compartilhado TERMINAL_TOKEN, já
// que o aluno não tem login). Cobrem: identificação por CPF, por código/QR
// pessoal, por reconhecimento facial, e vinculação inicial de método de
// acesso para alunos que já existiam antes do totem.
// ---------------------------------------------------------------------------
const terminal = express.Router();
// autenticarTerminal é aplicado rota a rota (e não via terminal.use()) de
// propósito: um router.use() sem path intercepta QUALQUER requisição que
// passe por este sub-router antes mesmo dele tentar casar a rota — inclusive
// as que não têm handler aqui e deveriam "cair" para o router "admin" logo
// abaixo (ex.: /catraca/testar). Com o middleware por rota, uma requisição
// para um caminho que não existe neste router simplesmente não bate em nada
// aqui e segue adiante normalmente.
//
// Rate limiting: mesmo autenticado por token, o TERMINAL_TOKEN hoje fica
// visível a quem inspecionar o front-end do totem — os limites abaixo são
// generosos o bastante pro fluxo normal de uma academia, mas travam
// automação/scripts caso um token vaze.
const limitadorIdentificacao = criarLimitador({
  janelaMs: 5 * 60 * 1000, maximo: 60,
  mensagem: 'Muitas tentativas de identificação. Aguarde alguns minutos.',
});
const limitadorVinculacao = criarLimitador({
  janelaMs: 60 * 60 * 1000, maximo: 5,
  mensagem: 'Muitas tentativas para este CPF. Procure a recepção se o problema persistir.',
  chavePor: (req) => `${req.ip}:${req.body?.cpf || req.query?.cpf || ''}`,
});
const limitadorCadastro = criarLimitador({
  janelaMs: 60 * 60 * 1000, maximo: 15,
  mensagem: 'Muitas tentativas de cadastro a partir deste endereço. Aguarde um pouco.',
});
const limitadorContas = criarLimitador({
  janelaMs: 15 * 60 * 1000, maximo: 20,
  mensagem: 'Muitas requisições. Aguarde alguns minutos.',
});

// 2026-07-21: REMOVIDA de propósito a rota POST /acesso/cpf (liberar a
// catraca só com o CPF, sem mais nada). Motivo (pedido do dono do sistema):
// CPF não é segredo — não prova que quem digitou é o dono do cadastro, e o
// TERMINAL_TOKEN que "protegia" esta rota já fica visível pra quem inspeciona
// o front-end do totem (ver comentário mais abaixo), então bastava alguém
// saber/adivinhar o CPF de um aluno pra abrir a catraca remotamente, sem
// nem estar na academia. Ficou só como caminho de identificação: QR pessoal
// (não adivinhável, gerado por gerarCodigoAcesso) e reconhecimento facial —
// ambos continuam abaixo. `buscarAlunoPorCpfParaAcesso` continua existindo
// em acessoTerminal.service.js (usada só como lookup interno), mas não tem
// mais nenhuma rota HTTP que a exponha como forma de liberar acesso.

// POST /api/terminal/acesso/codigo { codigo_acesso } — leitura do QR pessoal do celular
terminal.post('/acesso/codigo', limitadorIdentificacao, autenticarTerminal, async (req, res, next) => {
  try {
    const { codigo_acesso } = z.object({ codigo_acesso: z.string().min(1) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorCodigoAcessoParaAcesso(codigo_acesso);
    if (!aluno) {
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'qrcode', resultado: 'negado', mensagem: 'Código de acesso inválido.' });
      return res.json({ autorizado: false, motivo: 'Código de acesso inválido.' });
    }
    const resultado = await acessoTerminal.tentarLiberar({ aluno, metodo: 'qrcode' });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/acesso/facial { descriptor: number[128] } — reconhecimento facial recorrente
terminal.post('/acesso/facial', limitadorIdentificacao, autenticarTerminal, async (req, res, next) => {
  try {
    const { descriptor } = z.object({ descriptor: z.array(z.number()).min(16) }).parse(req.body);
    const match = await acessoTerminal.encontrarMelhorMatchFacialParaAcesso(descriptor);

    if (!match.aluno) {
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'facial', resultado: 'negado', mensagem: 'Nenhum aluno com rosto cadastrado.' });
      return res.json({ autorizado: false, motivo: 'Nenhum aluno com rosto cadastrado no sistema ainda.' });
    }

    if (!match.dentroDoLimite) {
      // Diagnóstico usado para calibrar FACE_MATCH_THRESHOLD/FACE_MATCH_MARGEM_MINIMA
      // no .env — o log interno (registrarAcesso) sempre guarda a distância
      // exata (inclusive do 2o colocado, quando a recusa foi por match
      // ambíguo — ver acessoTerminal.service.js), mas a RESPOSTA HTTP só
      // inclui esse detalhe fora de produção. Em produção, devolver a
      // distância/limite pra quem quer que esteja chamando a rota (com o
      // TERMINAL_TOKEN, hoje mais exposto por causa da página de cadastro
      // pelo celular) ajudaria a calibrar tentativas de bypass.
      const ambiguo = match.distancia <= match.limite; // bateu o limiar, mas foi recusado pela margem do 2o colocado
      const motivo = ambiguo
        ? `Rosto não reconhecido (match ambíguo: distância ${match.distancia.toFixed(3)} muito perto do 2º colocado ${match.distanciaSegundoMelhor?.toFixed(3)}, limite ${match.limite}).`
        : `Rosto não reconhecido (mais próximo: distância ${match.distancia.toFixed(3)}, limite ${match.limite}).`;
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'facial', resultado: 'negado', mensagem: motivo });
      const detalheDiagnostico = process.env.NODE_ENV === 'production'
        ? {}
        : { distancia: match.distancia, distancia_segundo_melhor: match.distanciaSegundoMelhor, limite: match.limite };
      return res.json({ autorizado: false, motivo: process.env.NODE_ENV === 'production' ? 'Rosto não reconhecido.' : motivo, ...detalheDiagnostico });
    }

    const resultado = await acessoTerminal.tentarLiberar({ aluno: match.aluno, metodo: 'facial' });
    const detalheDistancia = process.env.NODE_ENV === 'production' ? {} : { distancia: match.distancia };
    res.json({ ...resultado, ...detalheDistancia });
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/validar-biometria-catraca { biometria_id }
// Usada pelo agente local quando a PRÓPRIA catraca lê a digital (evento via
// escutar()). Aqui só validamos e devolvemos autorizado/negado — quem manda
// permitir_entrada/impedir_entrada de volta pra catraca é o agente, pois é
// ele quem tem o "index" da mensagem original.
terminal.post('/validar-biometria-catraca', limitadorIdentificacao, autenticarTerminal, async (req, res, next) => {
  try {
    const { biometria_id } = z.object({ biometria_id: z.string().min(1) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorBiometriaId(biometria_id);
    if (!aluno) {
      await acessoTerminal.registrarAcesso({ alunoId: null, metodo: 'biometria_catraca', resultado: 'negado', mensagem: 'Biometria não vinculada a nenhum aluno.' });
      return res.json({ autorizado: false, motivo: 'Biometria não vinculada a nenhum aluno.' });
    }
    const { autorizado, motivo } = await acessoTerminal.verificarAutorizacaoAluno(aluno);
    await acessoTerminal.registrarAcesso({
      alunoId: aluno.id,
      metodo: 'biometria_catraca',
      resultado: autorizado ? 'liberado' : 'negado',
      mensagem: motivo,
    });
    // aviso_vencimento (2026-07): incluído aqui também pra ficar disponível
    // pro agente local (ver agente-local/), caso algum dia ele passe a exibir
    // isso em algum display próprio — hoje não tem nenhuma tela pra mostrar,
    // mas não custa mandar o dado junto.
    const avisoVencimento = await acessoTerminal.buscarAvisoVencimentoSeguro(aluno.id);
    res.json({ autorizado, motivo, aluno_nome: aluno.nome, aviso_vencimento: avisoVencimento });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Cache local de autorização (Fase 1 do modo offline/resiliente) — o agente
// local (agente-local/agente.js) puxa esta lista periodicamente e ao
// conectar, pra poder liberar uma leitura de digital feita direto na própria
// catraca sem depender de round-trip de rede a cada toque. Ver
// agente-local/cacheAutorizacao.js e acessoTerminal.listarAutorizacoesBiometricas
// (mesma regra de autorização do totem, só que em lote/sem N+1).
// ---------------------------------------------------------------------------
const limitadorCacheAutorizacao = criarLimitador({
  janelaMs: 5 * 60 * 1000, maximo: 20,
  mensagem: 'Muitas requisições de sincronização de cache. Aguarde alguns minutos.',
});

// GET /api/terminal/cache-autorizacao — snapshot completo (todos os alunos
// com biometria vinculada) para o agente local popular/atualizar seu cache.
terminal.get('/cache-autorizacao', limitadorCacheAutorizacao, autenticarTerminal, async (req, res, next) => {
  try {
    const itens = await acessoTerminal.listarAutorizacoesBiometricas();
    res.json({ atualizado_em: Date.now(), itens });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Fila de reenvio de acessos (Fase 2 do modo offline/resiliente) — o agente
// local grava cada leitura de biometria numa fila própria em disco (ver
// agente-local/filaAcessos.js) em vez de um POST síncrono por toque, e
// reenvia em LOTE assim que consegue falar com o servidor de novo (ao
// reconectar no painel + por timer periódico). Isso evita que um acesso
// aconteça e se perca silenciosamente só porque a internet caiu no exato
// segundo do toque — antes ficava só no log do agente, sem chegar em
// "Últimos acessos".
//
// Idempotente por `id` (gerado no agente, no momento da leitura, não aqui):
// reenviar o mesmo lote (ex.: o agente reiniciou antes de receber a
// confirmação) não duplica o registro — ver
// acessoTerminal.registrarAcessoIdempotente (INSERT OR IGNORE pela PK).
//
// Cada evento é processado de forma independente (um item malformado não
// derruba o lote inteiro); a resposta lista só os ids que o servidor
// confirmou, e o agente só remove da fila local os que aparecerem aqui —
// qualquer id que faltar é reenviado automaticamente no próximo flush.
// ---------------------------------------------------------------------------
const limitadorAcessosLote = criarLimitador({
  janelaMs: 5 * 60 * 1000, maximo: 60,
  mensagem: 'Muitas requisições de reenvio de acessos. Aguarde alguns minutos.',
});

terminal.post('/acessos/lote', limitadorAcessosLote, autenticarTerminal, async (req, res, next) => {
  try {
    const { eventos } = z.object({
      eventos: z.array(z.object({
        id: z.string().min(1),
        biometria_id: z.string().min(1),
        capturado_em: z.string().min(1).optional(),
      })).max(200),
    }).parse(req.body);

    const processados = [];
    for (const evento of eventos) {
      try {
        const aluno = await acessoTerminal.buscarAlunoPorBiometriaId(evento.biometria_id);
        if (!aluno) {
          await acessoTerminal.registrarAcessoIdempotente({
            id: evento.id,
            alunoId: null,
            metodo: 'biometria_catraca',
            resultado: 'negado',
            mensagem: 'Biometria não vinculada a nenhum aluno.',
            criadoEm: evento.capturado_em,
          });
          processados.push(evento.id);
          continue;
        }
        const { autorizado, motivo } = await acessoTerminal.verificarAutorizacaoAluno(aluno);
        await acessoTerminal.registrarAcessoIdempotente({
          id: evento.id,
          alunoId: aluno.id,
          metodo: 'biometria_catraca',
          resultado: autorizado ? 'liberado' : 'negado',
          mensagem: motivo,
          criadoEm: evento.capturado_em,
        });
        processados.push(evento.id);
      } catch {
        // Item pontualmente malformado/com erro — não entra em `processados`,
        // então o agente naturalmente tenta de novo no próximo flush. Não
        // interrompe o processamento do resto do lote.
      }
    }

    res.json({ processados });
  } catch (err) {
    next(err);
  }
});

// ---- Vinculação de método de acesso para alunos já cadastrados ----

// GET /api/terminal/vincular/codigo?cpf=... — gera (ou recupera) o código de
// acesso estável do aluno, para gerar o QR/link "meu acesso" pessoal dele.
terminal.get('/vincular/codigo', limitadorVinculacao, autenticarTerminal, async (req, res, next) => {
  try {
    const { cpf } = z.object({ cpf: z.string().min(1) }).parse(req.query);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado.' });
    const codigo = await acessoTerminal.garantirCodigoAcesso(aluno.id);
    res.json({ aluno_nome: aluno.nome, codigo_acesso: codigo });
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/vincular/facial { cpf, descriptor } — cadastra o rosto do
// aluno para reconhecimento facial recorrente (autoatendimento no totem OU,
// logo após um auto-cadastro, pela página de cadastro pelo celular — por isso
// aceita os dois tokens).
//
// Como só o CPF prova identidade aqui, esta rota conseguia SOBRESCREVER um
// rosto já cadastrado sem confirmar que era a mesma pessoa. Decisão do dono
// do sistema (2026-07-07): bloquear por completo a sobrescrita remota — se o
// aluno já tem um rosto cadastrado, recusa (409). Não afeta o fluxo normal:
// tanto "Primeira vez no totem" quanto o cadastro facial logo após um
// auto-cadastro (totem ou celular) só rodam quando o aluno AINDA não tem
// rosto cadastrado. Trocar um rosto já existente passa a exigir a recepção
// (painel -> perfil do aluno -> aba "Biometria & acesso").
terminal.post('/vincular/facial', limitadorVinculacao, autenticarTerminalOuCadastroPublico, async (req, res, next) => {
  try {
    const { cpf, descriptor } = z.object({ cpf: z.string().min(1), descriptor: z.array(z.number()).min(16) }).parse(req.body);
    const aluno = await acessoTerminal.buscarAlunoPorCpf(cpf);
    if (!aluno) return res.status(404).json({ erro: 'CPF não encontrado.' });

    if (aluno.face_descriptor) {
      await acessoTerminal.registrarAcesso({
        alunoId: aluno.id,
        metodo: 'vincular_facial_totem',
        resultado: 'negado',
        mensagem: 'Tentativa de sobrescrever reconhecimento facial já cadastrado, pelo totem/celular (CPF) — bloqueada.',
      });
      return res.status(409).json({
        erro: 'Este cadastro já tem um reconhecimento facial vinculado. Para trocar, procure a recepção.',
      });
    }

    await acessoTerminal.salvarFaceDescriptor(aluno.id, descriptor);
    await acessoTerminal.registrarAcesso({
      alunoId: aluno.id,
      metodo: 'vincular_facial_totem',
      resultado: 'liberado',
      mensagem: 'Primeiro cadastro de reconhecimento facial (totem/cadastro pelo celular).',
    });

    res.json({ ok: true, aluno_nome: aluno.nome });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Auto cadastro + pagamento (alunos novos, sem passar pela recepção). O aluno
// preenche os dados no totem, escolhe um plano, e recebe um QR de pagamento
// (link do gateway) para escanear com o próprio celular. A matrícula nasce com
// status 'pendente' (não conta como ativa em verificarAutorizacaoAluno) e só
// vira 'ativa' — liberando a entrada — quando o pagamento é confirmado, via
// polling em /auto-cadastro/status/:cobrancaId. Sem isso, um cadastro sem
// pagamento nunca abriria a catraca, mesmo com status do aluno = 'ativo'.
// ---------------------------------------------------------------------------

// Categoria da pessoa que está se auto-cadastrando (2026-07 — sistema de
// visitantes). O totem manda 'visitante' quando o fluxo é "Cadastrar
// visitante/amigo" (ver PLANO_VISITANTE_ID abaixo) — nos outros casos (aluno
// novo de verdade, pagando um plano) nem precisa vir, o padrão é 'aluno'.
const CATEGORIAS_AUTO_CADASTRO = ['aluno', 'visitante'];

// 2026-07: nome, e-mail, telefone e data de nascimento passaram a ser
// obrigatórios no auto-cadastro (totem e portal) — decisão do dono do
// sistema, pra sempre ter como contatar/identificar quem se cadastra sozinho
// (antes só nome e CPF eram exigidos, os outros eram opcionais).
const autoCadastroSchema = z.object({
  nome: z.string().min(2),
  cpf: z.string().min(1),
  telefone: z.string().min(8, 'Telefone é obrigatório.'),
  email: z.string().email('E-mail é obrigatório e precisa ser válido.'),
  data_nascimento: z.string().min(1, 'Data de nascimento é obrigatória.'),
  plano_id: z.string().min(1),
  // Preenchido só no fluxo "Cadastrar visitante/amigo": CPF do aluno que já
  // tem cadastro e está indicando o visitante. Validado abaixo (precisa
  // existir, e não pode ter estourado o limite mensal de indicações).
  indicado_por_cpf: z.string().optional().nullable(),
});

// Sentinela do "plano Visitante" (2026-07 — sistema de visitantes/indicação):
// não é uma linha de verdade em `planos` (evita poluir relatórios financeiros
// com um plano de R$ 0,00) — é injetado como uma opção a mais na lista que
// GET /planos devolve, e tratado à parte em POST /auto-cadastro, sem Pix,
// sem matrícula, sem cobrança. Ver também src/routes/portal.routes.js.
const PLANO_VISITANTE_ID = 'visitante';
const PLANO_VISITANTE = {
  id: PLANO_VISITANTE_ID,
  nome: 'Visitante (acesso gratuito, sem matrícula)',
  tipo: 'visitante',
  valor_centavos: 0,
  duracao_dias: null,
};

// GET /api/terminal/planos — planos ativos, para o totem (ou a página de
// cadastro pelo celular) montar o seletor de plano. Sempre inclui a opção
// "Visitante" no final, mesmo que não exista nenhum plano pago cadastrado.
terminal.get('/planos', autenticarTerminalOuCadastroPublico, async (req, res, next) => {
  try {
    const result = await db.execute(
      'SELECT id, nome, tipo, valor_centavos, duracao_dias FROM planos WHERE ativo = 1 ORDER BY valor_centavos',
    );
    res.json([...result.rows, PLANO_VISITANTE]);
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/auto-cadastro { nome, cpf, telefone, email, data_nascimento, plano_id, indicado_por_cpf? }
terminal.post('/auto-cadastro', limitadorCadastro, autenticarTerminalOuCadastroPublico, async (req, res, next) => {
  try {
    const dados = autoCadastroSchema.parse(req.body);

    const existente = await acessoTerminal.buscarAlunoPorCpf(dados.cpf);
    if (existente) {
      return res.status(409).json({
        erro: 'Este CPF já tem cadastro. Use "Primeira vez no totem" para vincular seu acesso, ou procure a recepção.',
      });
    }

    // ---------------- Fluxo "Cadastrar visitante/amigo" (2026-07) ----------------
    // Sem Pix, sem matrícula, sem cobrança — só o cadastro em si, com
    // categoria='visitante' (acesso limitado, ver acessoTerminal.service.js)
    // e, se veio de uma indicação, o vínculo com quem indicou + checagem do
    // limite mensal de indicações por aluno.
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

      // E-mail específico do visitante (2026-07-19) — NUNCA o e-mail normal
      // de boas-vindas: aquele gera/manda a senha do Portal do Aluno
      // (biometria_id), que só faz sentido pareada com cadastro físico na
      // catraca — o visitante não passa por isso. Ver comentário completo em
      // emailBoasVindas.service.js.
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

    const cobrancaId = uuid();
    const descricao = `Matrícula - ${p.nome}`;
    const provedor = 'mercadopago'; // único provedor suportado (InfinitePay foi removido)

    // Gera o pagamento ANTES de escrever qualquer coisa no banco — se o
    // gateway falhar, a requisição falha inteira e nenhum registro órfão fica
    // para trás (mesmo padrão usado em POST /api/pagamentos/cobrar).
    //
    // Pix direto via API de Orders (Checkout Transparente) — sem
    // redirecionar pra nenhuma tela externa, o QR já sai pronto pra
    // mostrar no totem. A API exige um e-mail do pagador; como o totem não
    // pede e-mail, usamos um sintético baseado no CPF quando o aluno não
    // informou um de verdade.
    //
    // A API de Orders SEMPRE exige o Access Token de PRODUÇÃO
    // ("APP_USR-..."), mesmo pra simular — ela não aceita token "TEST-...".
    // O "modo teste" é ativado pelo PAGADOR: se MERCADOPAGO_TEST_PAYER_EMAIL
    // estiver configurado, usamos esse e-mail de teste + o valor mágico
    // "APRO" em first_name, que faz o Mercado Pago simular a aprovação
    // automaticamente, sem mexer em dinheiro de verdade. Remova essa
    // variável (ou apague-a) quando o totem for pra produção de verdade, e
    // o pagamento passa a valer o dinheiro real dos alunos.
    const emailTeste = process.env.MERCADOPAGO_TEST_PAYER_EMAIL;
    const emailPagador = emailTeste || dados.email || `aluno-${dados.cpf.replace(/\D/g, '')}@academia-gestao.com`;
    const firstNamePagador = emailTeste ? 'APRO' : undefined;

    const order = await mercadopago.criarOrderPix({
      descricao,
      valorCentavos: p.valor_centavos,
      referenciaExterna: cobrancaId,
      email: emailPagador,
      firstName: firstNamePagador,
    });
    const metodoPix = order.transactions?.payments?.[0]?.payment_method || {};
    const qrCodePix = metodoPix.qr_code || null; // copia-e-cola (texto)
    const qrCodePixImagem = metodoPix.qr_code_base64 || null; // base64 (imagem pronta)
    // provedorReferencia guarda o ID do pagamento no Mercado Pago (não o
    // cobrancaId) para poder consultar o status diretamente na API como
    // reforço ao webhook — webhook sozinho depende de estar bem configurado
    // no painel do Mercado Pago e de o servidor estar publicamente acessível,
    // então o polling do totem confere os dois.
    const provedorReferencia = String(order.id);

    const alunoId = uuid();
    await db.execute({
      sql: `INSERT INTO alunos (id, nome, email, telefone, cpf, data_nascimento, status)
            VALUES (?, ?, ?, ?, ?, ?, 'ativo')`,
      args: [alunoId, dados.nome, dados.email, dados.telefone, dados.cpf, dados.data_nascimento],
    });
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

    await db.execute({
      sql: `INSERT INTO cobrancas (id, aluno_id, matricula_id, valor_centavos, provedor, provedor_referencia, descricao, vencimento)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [cobrancaId, alunoId, matriculaId, p.valor_centavos, provedor, provedorReferencia, descricao, hoje],
    });

    res.status(201).json({
      cobranca_id: cobrancaId,
      qr_code_pix: qrCodePix,
      qr_code_pix_imagem: qrCodePixImagem,
      valor_centavos: p.valor_centavos,
      aluno_nome: dados.nome,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/auto-cadastro/status/:cobrancaId — o totem faz polling
// aqui enquanto espera o pagamento. Quando a cobrança está paga, ativa a
// matrícula (só na primeira vez — updates seguintes do WHERE status='pendente'
// não afetam nada, evitando reabrir a catraca a cada poll) e libera o acesso.
terminal.get('/auto-cadastro/status/:cobrancaId', autenticarTerminalOuCadastroPublico, async (req, res, next) => {
  try {
    const cobranca = await db.execute({ sql: 'SELECT * FROM cobrancas WHERE id = ?', args: [req.params.cobrancaId] });
    let c = cobranca.rows[0];
    if (!c) return res.status(404).json({ erro: 'Cobrança não encontrada.' });

    // Reforço ao webhook: se ainda não chegou confirmação (webhook não
    // configurado no painel do Mercado Pago, atraso de entrega, etc.),
    // consulta o status direto na API a cada poll do totem. Assim o totem
    // não depende só do webhook pra saber que o Pix foi pago.
    if (c.status !== 'pago' && c.provedor === 'mercadopago' && c.provedor_referencia) {
      try {
        const order = await mercadopago.consultarOrder(c.provedor_referencia);
        const pagamentoOrder = order.transactions?.payments?.[0] || {};
        const aprovado = order.status === 'processed' || pagamentoOrder.status === 'approved';
        if (aprovado) {
          await db.execute({
            sql: `UPDATE cobrancas SET status = 'pago', metodo_pagamento = ?, pago_em = datetime('now') WHERE id = ?`,
            args: ['pix', c.id],
          });
          c = { ...c, status: 'pago' };
        }
      } catch (err) {
        // Não interrompe o polling por causa de uma falha pontual na consulta
        // — o totem simplesmente tenta de novo no próximo tick.
      }
    }

    if (c.status !== 'pago') {
      return res.json({ pago: false });
    }

    let jaAtivadaAntes = false;
    if (c.matricula_id) {
      const upd = await db.execute({
        sql: `UPDATE matriculas SET status = 'ativa' WHERE id = ? AND status = 'pendente'`,
        args: [c.matricula_id],
      });
      jaAtivadaAntes = upd.rowsAffected === 0;
    }

    const alunoResult = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [c.aluno_id] });
    const aluno = alunoResult.rows[0];
    if (!aluno) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    const codigoAcesso = await acessoTerminal.garantirCodigoAcesso(aluno.id);
    // Best-effort, não bloqueia a resposta — pagamento confirmado pode ter
    // tirado este aluno da lista de "em atraso" (se já tinha biometria de
    // catraca vinculada por outro canal, ex.: importação em lote).
    acessoTerminal.notificarAgenteAtualizacaoAluno(aluno.id);

    if (jaAtivadaAntes) {
      return res.json({ pago: true, autorizado: true, motivo: null, aluno_nome: aluno.nome, cpf: aluno.cpf, codigo_acesso: codigoAcesso });
    }

    const resultado = await acessoTerminal.tentarLiberar({ aluno, metodo: 'cadastro' });
    res.json({ pago: true, ...resultado, cpf: aluno.cpf, codigo_acesso: codigoAcesso });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Pagamento de contas em atraso pelo totem (consulta por CPF). A lógica de
// verdade mora em pagamentoContas.service (compartilhada com o portal remoto,
// que faz a mesma coisa mas sempre com liberarAcesso=false) — aqui é só o
// encaixe HTTP + a autenticação do totem.
// ---------------------------------------------------------------------------

// POST /api/terminal/contas/consultar { cpf } — lista as contas em aberto
// (pendente/atrasado) do aluno, pra montar a tela de seleção no totem.
terminal.post('/contas/consultar', limitadorContas, autenticarTerminal, async (req, res, next) => {
  try {
    const { cpf } = z.object({ cpf: z.string().min(1) }).parse(req.body);
    const resultado = await pagamentoContas.consultarContasAbertas(cpf);
    if (!resultado) return res.status(404).json({ erro: 'CPF não encontrado.' });
    res.json({ aluno_id: resultado.aluno.id, aluno_nome: resultado.aluno.nome, contas: resultado.contas });
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/contas/pagar { cpf, cobranca_ids: [...], liberar_acesso? }
// Gera UM pagamento Pix agregado cobrindo todas as cobrancas selecionadas.
// liberar_acesso=true por padrão aqui (totem físico da academia); o portal
// remoto (portal.routes.js) chama o mesmo serviço sempre com false.
terminal.post('/contas/pagar', limitadorContas, autenticarTerminal, async (req, res, next) => {
  try {
    const schema = z.object({
      cpf: z.string().min(1),
      cobranca_ids: z.array(z.string()).min(1),
      liberar_acesso: z.boolean().optional(),
    });
    const dados = schema.parse(req.body);
    const resultado = await pagamentoContas.criarPagamentoAgregado({
      cpf: dados.cpf,
      cobrancaIds: dados.cobranca_ids,
      liberarAcesso: dados.liberar_acesso !== false,
    });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/contas/status/:pagamentoId — polling do totem enquanto
// aguarda o Pix.
terminal.get('/contas/status/:pagamentoId', autenticarTerminal, async (req, res, next) => {
  try {
    const resultado = await pagamentoContas.consultarStatusPagamento(req.params.pagamentoId);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

router.use(terminal);

// ---------------------------------------------------------------------------
// Rotas administrativas (login de staff) — testes de campo da integração TCP
// com a catraca, sem passar pelo fluxo de identificação do aluno.
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use(autenticar, apenasAdmin);

function configCatraca(body = {}) {
  const ip = body.ip || process.env.HENRY_CATRACA_IP;
  const port = Number(body.port || process.env.HENRY_CATRACA_PORT || 3000);
  if (!ip) throw Object.assign(new Error('IP da catraca não configurado (HENRY_CATRACA_IP no .env ou "ip" no body).'), { status: 400 });
  return { ip, port };
}

// ---------------------------------------------------------------------------
// "Liberação de pânico": mantém a catraca liberada continuamente, chamando
// liberarAcesso em loop (o protocolo Henry só libera por tempo fixo por
// comando — RELEASE_TIME em henryCatraca.service.js — não existe um comando
// nativo de "travar aberto"). ATENÇÃO: isso é um mecanismo por software, que
// depende do servidor e da rede estarem no ar; não é um substituto de uma
// trava mecânica de emergência exigida por norma de segurança contra
// incêndio/saída de emergência. Use com essa ressalva em mente.
// ---------------------------------------------------------------------------
let panicoInterval = null;
let panicoConfig = null;

const PANICO_INTERVALO_MS = 3000; // menor que os 4s de liberação por comando, pra não deixar brecha

// POST /api/terminal/catraca/panico/ativar { ip?, port? }
admin.post('/catraca/panico/ativar', async (req, res, next) => {
  try {
    const { ip, port } = configCatraca(req.body || {});
    if (panicoInterval) return res.json({ ok: true, ativo: true, ja_estava_ativo: true });

    panicoConfig = { ip, port };
    await catracaGateway.liberarAcesso({ ip, port, mensagem: 'PANICO - LIBERACAO DE EMERGENCIA' });
    panicoInterval = setInterval(() => {
      catracaGateway.liberarAcesso({ ip, port, mensagem: 'PANICO - LIBERACAO DE EMERGENCIA' }).catch(() => {});
    }, PANICO_INTERVALO_MS);

    await acessoTerminal.registrarAcesso({
      alunoId: null, metodo: 'admin_panico', resultado: 'liberado',
      mensagem: `Liberação de pânico ATIVADA por ${req.usuario?.email || 'admin'}`,
    });

    res.json({ ok: true, ativo: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/terminal/catraca/panico/cancelar
admin.post('/catraca/panico/cancelar', async (req, res, next) => {
  try {
    if (panicoInterval) {
      clearInterval(panicoInterval);
      panicoInterval = null;
      await acessoTerminal.registrarAcesso({
        alunoId: null, metodo: 'admin_panico', resultado: 'liberado',
        mensagem: `Liberação de pânico CANCELADA por ${req.usuario?.email || 'admin'}`,
      });
    }
    panicoConfig = null;
    res.json({ ok: true, ativo: false });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/catraca/panico/status
admin.get('/catraca/panico/status', (req, res) => {
  res.json({ ativo: Boolean(panicoInterval), config: panicoConfig });
});

// POST /api/terminal/catraca/liberar-aluno { aluno_id, ip?, port?, mensagem? }
// Libera a catraca manualmente indicando o aluno — diferente de /catraca/liberar
// (teste de campo anônimo), este fica registrado em acessos_catraca com o
// aluno_id, então aparece no histórico e no painel de "Acessos recentes".
admin.post('/catraca/liberar-aluno', async (req, res, next) => {
  try {
    const schema = z.object({
      aluno_id: z.string(),
      ip: z.string().optional(),
      port: z.number().optional(),
      mensagem: z.string().optional(),
    });
    const body = schema.parse(req.body || {});
    const { ip, port } = configCatraca(body);

    const alunoResult = await db.execute({ sql: 'SELECT id, nome FROM alunos WHERE id = ?', args: [body.aluno_id] });
    const aluno = alunoResult.rows[0];
    if (!aluno) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    await catracaGateway.liberarAcesso({ ip, port, mensagem: body.mensagem || `Liberação manual - ${aluno.nome}` });
    await acessoTerminal.registrarAcesso({
      alunoId: aluno.id, metodo: 'admin', resultado: 'liberado',
      mensagem: `Liberação manual pelo painel (${req.usuario?.email || 'admin'})`,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/catraca/testar?ip=...&port=... — testa conectividade (TCP
// direto ou, se houver agente local conectado, TCP feito por ele)
admin.get('/catraca/testar', async (req, res, next) => {
  try {
    const { ip, port } = configCatraca(req.query);
    const resultado = await catracaGateway.testarConexao({ ip, port });
    res.json({ ip, port, ...resultado });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/catraca/agente/status — se há um agente local conectado
// agora (usado pelo painel pra indicar "agente conectado" vs "modo direto")
admin.get('/catraca/agente/status', (req, res) => {
  res.json(catracaGateway.statusAgente());
});

// POST /api/terminal/catraca/liberar { ip?, port?, mensagem? } — dispara abertura manual (teste de campo)
admin.post('/catraca/liberar', async (req, res, next) => {
  try {
    const schema = z.object({ ip: z.string().optional(), port: z.number().optional(), mensagem: z.string().optional() });
    const body = schema.parse(req.body || {});
    const { ip, port } = configCatraca(body);
    await catracaGateway.liberarAcesso({ ip, port, mensagem: body.mensagem });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/acessos?aluno_id=&data=&data_inicio=&data_fim=&busca=&apenas_primeiro=
// histórico de tentativas de acesso pelo totem/catraca. Usado pelo painel "Acessos recentes",
// pela janela da catraca e pelos relatórios "Acesso Diário" (usa "data") e "Acesso Pessoal"
// (usa "aluno_id" + "data_inicio"/"data_fim").
//
// "apenas_primeiro=true" (2026-07, pedido do usuário pra contabilizar quem realmente veio no
// dia, sem contar cada toque repetido na catraca como se fosse gente diferente): em vez de
// devolver todas as tentativas, devolve só a PRIMEIRA tentativa de cada aluno em cada dia
// (usando ROW_NUMBER() particionado por aluno+dia, ordenado por horário). Tentativas sem aluno
// reconhecido (aluno_id nulo) nunca são agrupadas entre si - cada uma conta como um evento
// próprio, já que não dá pra saber se são a mesma pessoa.
admin.get('/acessos', async (req, res, next) => {
  try {
    const {
      aluno_id: alunoId, data, data_inicio: dataInicio, data_fim: dataFim, busca,
      apenas_primeiro: apenasPrimeiro,
    } = req.query;
    const condicoes = [];
    const args = [];
    if (alunoId) { condicoes.push('ac.aluno_id = ?'); args.push(alunoId); }
    if (data) { condicoes.push("date(ac.criado_em) = ?"); args.push(data); }
    if (dataInicio) { condicoes.push('date(ac.criado_em) >= ?'); args.push(dataInicio); }
    if (dataFim) { condicoes.push('date(ac.criado_em) <= ?'); args.push(dataFim); }
    if (busca) { condicoes.push('a.nome LIKE ?'); args.push(`%${busca}%`); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const somentePrimeiroDoDia = apenasPrimeiro === 'true' || apenasPrimeiro === '1';
    const sql = somentePrimeiroDoDia
      ? `SELECT * FROM (
           SELECT ac.*, a.nome as aluno_nome,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(ac.aluno_id, 'sem-aluno-' || ac.id), date(ac.criado_em)
               ORDER BY ac.criado_em ASC
             ) as rn_primeiro_do_dia
           FROM acessos_catraca ac LEFT JOIN alunos a ON a.id = ac.aluno_id
           ${where}
         ) WHERE rn_primeiro_do_dia = 1 ORDER BY criado_em DESC LIMIT 500`
      : `SELECT ac.*, a.nome as aluno_nome FROM acessos_catraca ac LEFT JOIN alunos a ON a.id = ac.aluno_id
         ${where} ORDER BY ac.criado_em DESC LIMIT 500`;

    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/terminal/acessos/ultimo-por-aluno?data_inicio=&data_fim=&busca=&incluir_inativos=
// relatório "Último Acesso": um registro por aluno, com a data/hora do acesso mais recente
// (que tenha sido efetivamente liberado). O período, quando informado, restringe quais acessos
// contam pra esse "mais recente" — útil pra achar quem não vem há tempos. Por padrão só traz
// alunos com status='ativo'; passe incluir_inativos=true (checkbox "mostrar inativos") pra
// incluir todo mundo.
admin.get('/acessos/ultimo-por-aluno', async (req, res, next) => {
  try {
    const {
      data_inicio: dataInicio, data_fim: dataFim, busca, incluir_inativos: incluirInativos,
    } = req.query;
    const condicoes = ["ac.resultado = 'liberado'"];
    const args = [];
    if (!(incluirInativos === 'true' || incluirInativos === '1')) { condicoes.push("a.status = 'ativo'"); }
    if (dataInicio) { condicoes.push('date(ac.criado_em) >= ?'); args.push(dataInicio); }
    if (dataFim) { condicoes.push('date(ac.criado_em) <= ?'); args.push(dataFim); }
    if (busca) { condicoes.push('a.nome LIKE ?'); args.push(`%${busca}%`); }
    const where = `WHERE ${condicoes.join(' AND ')}`;

    const result = await db.execute({
      sql: `SELECT a.id as aluno_id, a.nome as aluno_nome, MAX(ac.criado_em) as ultimo_acesso
            FROM acessos_catraca ac
            JOIN alunos a ON a.id = ac.aluno_id
            ${where}
            GROUP BY a.id, a.nome
            ORDER BY ultimo_acesso DESC`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.use(admin);

module.exports = router;
