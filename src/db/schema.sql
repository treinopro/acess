-- Schema inicial do sistema de gestao de alunos
-- Compativel com SQLite / libSQL (Turso)

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  usuario TEXT, -- nome de login alternativo ao e-mail (ex: sistemas sem e-mail) - unicidade garantida por indice abaixo
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL DEFAULT 'admin', -- admin | professor | recepcao
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alunos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT,
  telefone TEXT,
  cpf TEXT,
  data_nascimento TEXT,
  foto_url TEXT,
  status TEXT NOT NULL DEFAULT 'ativo', -- ativo | inativo | trancado | inadimplente
  observacoes TEXT,
  biometria_id TEXT, -- referencia/ID do template biometrico cadastrado no leitor externo (catraca/app)
  codigo_acesso TEXT, -- codigo estavel para QR/"cartao de embarque" e fallback manual no totem
  face_descriptor TEXT, -- descritor facial (JSON, 128 floats do face-api.js) para reconhecimento facial recorrente no totem
  treino_modo TEXT DEFAULT 'nativo', -- nativo | app_externo (ver tabela "treinos" mais abaixo)
  -- Categoria da pessoa (2026-07 — sistema de modalidades/perfis e visitantes,
  -- ver acessoTerminal.service.js e src/routes/terminal.routes.js). Chamamos
  -- de "categoria" (não "modalidade") pra não confundir com turmas.modalidade,
  -- que é outro conceito (tipo de aula). Valores: aluno | professor | visitante
  -- | colaborador | bolsista. colaborador e bolsista têm acesso livre (não
  -- dependem de mensalidade em dia) — ver CATEGORIA_ACESSO_LIVRE. visitante
  -- tem um período de acesso gratuito contado em DIAS corridos a partir da
  -- primeira liberação (configuracoes.chave = 'visitante_limite_dias', padrão
  -- 1 dia) — ver visitante_liberado_em logo abaixo. aluno e professor seguem a
  -- regra normal de mensalidade/status.
  categoria TEXT NOT NULL DEFAULT 'aluno',
  -- Preenchido só quando categoria = 'visitante' e o cadastro foi feito por um
  -- aluno indicando um amigo pelo totem (ver POST /api/terminal/auto-cadastro
  -- e o botão "Cadastrar visitante/amigo"). Usado tanto pro relatório de
  -- visitantes (quem indicou quem) quanto pro limite mensal de indicações por
  -- aluno (configuracoes.chave = 'indicacao_limite_mensal').
  indicado_por_aluno_id TEXT REFERENCES alunos(id) ON DELETE SET NULL,
  -- Data/hora (UTC, mesmo formato de criado_em) da PRIMEIRA liberação de
  -- acesso deste visitante (2026-07 — antes o limite era contado por número
  -- de acessos; agora é por dias corridos a partir desta data, ver
  -- acessoTerminal.service.js/verificarAutorizacaoAluno). NULL até a primeira
  -- liberação — nesse estado o visitante ainda está dentro do período
  -- gratuito, mesmo sem nunca ter entrado. Só se aplica a categoria='visitante'.
  visitante_liberado_em TEXT,
  -- Senha do portal remoto (2026-07): a partir do 1o acesso do aluno ao
  -- portal (GET /api/portal/aluno), ele passa a precisar de CPF + biometria_id
  -- (o mesmo codigo sequencial da catraca) pra entrar. Esta flag marca se
  -- esse codigo ja foi revelado pra ele alguma vez - antes disso, so o CPF
  -- basta (e o codigo e gerado/mostrado nesse momento, se ainda nao existir).
  -- Ver src/routes/portal.routes.js e acessoTerminal.service.js.
  portal_senha_revelada INTEGER NOT NULL DEFAULT 0,
  -- Identificador da PESSOA no Secullum Academia.Net (campo "Nº Identificador"
  -- na tela de Contas a Receber). NULL para alunos cadastrados direto aqui,
  -- nunca importados. Usado pela migracao pra decidir "ja existe, so
  -- atualiza" em vez de criar duplicata a cada nova tentativa de migracao.
  secullum_id TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anamnese / avaliacao de saude inicial (dado sensivel - ver LGPD no README)
CREATE TABLE IF NOT EXISTS anamneses (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  historico_saude TEXT,
  restricoes TEXT,
  peso_kg REAL,
  altura_cm REAL,
  observacoes_medicas TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Avaliacoes fisicas periodicas (historico de evolucao - peso, medidas, percentual de gordura)
CREATE TABLE IF NOT EXISTS avaliacoes_fisicas (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  data_avaliacao TEXT NOT NULL,
  peso_kg REAL,
  altura_cm REAL,
  percentual_gordura REAL,
  medida_cintura_cm REAL,
  medida_quadril_cm REAL,
  medida_peito_cm REAL,
  medida_braco_cm REAL,
  medida_coxa_cm REAL,
  medida_panturrilha_cm REAL,
  imc_atual REAL,
  imc_ideal REAL,
  iac REAL,
  massa_magra_kg REAL,
  perfil_morfologico TEXT, -- ex: grande | media | delgada
  dados_extras TEXT, -- JSON livre para valores secundarios (dobras cutaneas, classificacoes, achados de avaliacao etc.)
  objetivo TEXT,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Perguntas configuraveis de anamnese (sim/nao ou texto curto), pensadas para
-- preenchimento rapido (inclusive futuramente no totem/autoatendimento).
CREATE TABLE IF NOT EXISTS anamnese_perguntas (
  id TEXT PRIMARY KEY,
  texto TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'sim_nao', -- sim_nao | texto
  ordem INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS anamnese_respostas (
  id TEXT PRIMARY KEY,
  anamnese_id TEXT NOT NULL REFERENCES anamneses(id) ON DELETE CASCADE,
  pergunta_id TEXT NOT NULL REFERENCES anamnese_perguntas(id),
  resposta_sim_nao INTEGER, -- 1=sim, 0=nao, NULL se a pergunta for do tipo texto
  resposta_texto TEXT, -- usado quando tipo=texto, ou como complemento de uma resposta "sim"
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS planos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL, -- mensal | trimestral | semestral | anual | avulso | pacote_aulas
  valor_centavos INTEGER NOT NULL,
  duracao_dias INTEGER,
  aulas_incluidas INTEGER,
  ativo INTEGER NOT NULL DEFAULT 1,
  -- Desconto opcional por forma de pagamento (ex: "desconto pagamento em
  -- dinheiro"). desconto_tipo é NULL quando o plano não tem desconto.
  desconto_tipo TEXT, -- 'percentual' | 'valor' | NULL
  desconto_percentual REAL, -- preenchido só quando desconto_tipo = 'percentual'
  desconto_valor_centavos INTEGER, -- preenchido só quando desconto_tipo = 'valor'
  desconto_forma_pagamento TEXT, -- dinheiro | pix | cartao_credito | cartao_debito | transferencia | boleto | outro
  -- Identificador do "servico" no Secullum (tabela servicos.id). NULL para
  -- planos cadastrados direto aqui. Evita duplicar plano a cada nova
  -- tentativa de migracao.
  secullum_id TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matriculas (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  plano_id TEXT NOT NULL REFERENCES planos(id),
  data_inicio TEXT NOT NULL,
  data_fim TEXT,
  status TEXT NOT NULL DEFAULT 'ativa', -- ativa | cancelada | trancada | expirada | pendente (auto cadastro no totem, aguardando 1o pagamento)
  renovacao_automatica INTEGER NOT NULL DEFAULT 1,
  -- Identificador do vinculo pessoa+servico no Secullum (tabela
  -- pessoas_servicos.id, ou uma chave sintetica pessoa+servico+data_inicio
  -- quando o export nao tem id). NULL para matriculas criadas direto aqui.
  secullum_id TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS turmas (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  modalidade TEXT,
  professor_id TEXT REFERENCES usuarios(id),
  capacidade_maxima INTEGER NOT NULL DEFAULT 20,
  dia_semana INTEGER NOT NULL, -- 0=domingo ... 6=sabado
  horario_inicio TEXT NOT NULL, -- HH:MM
  horario_fim TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  turma_id TEXT NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
  data_aula TEXT NOT NULL, -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'marcada', -- marcada | cancelada | realizada | falta
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  agendamento_id TEXT REFERENCES agendamentos(id),
  metodo TEXT NOT NULL DEFAULT 'qrcode', -- qrcode | catraca | biometria | app | manual
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cobrancas (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  matricula_id TEXT REFERENCES matriculas(id),
  valor_centavos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente | pago | atrasado | cancelado | estornado
  provedor TEXT NOT NULL, -- mercadopago (único suportado hoje) | manual (contas sem gateway) | infinitepay (valores antigos podem existir em cobrancas históricas)
  provedor_referencia TEXT, -- id/slug da cobranca no provedor
  metodo_pagamento TEXT, -- pix | credit_card | boleto
  descricao TEXT,
  vencimento TEXT,
  pago_em TEXT,
  -- Numero da conta no Secullum (coluna "Número" na tela Contas a Receber,
  -- tabela contas_receber.id). NULL para cobrancas lancadas direto aqui.
  -- Chave usada pela migracao pra nunca duplicar a mesma conta em duas
  -- tentativas de importacao.
  secullum_numero TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Log de tentativas de acesso pelo totem/catraca (facial, QR, CPF, biometria da catraca)
CREATE TABLE IF NOT EXISTS acessos_catraca (
  id TEXT PRIMARY KEY,
  aluno_id TEXT REFERENCES alunos(id) ON DELETE SET NULL,
  metodo TEXT NOT NULL, -- cpf | qrcode | facial | biometria_catraca | cadastro
  resultado TEXT NOT NULL, -- liberado | negado
  mensagem TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pagamentos individuais de uma conta a receber. Permite pagamento parcial/parcelado:
-- cada conta pode ter varios registros aqui, e quando a soma bate o valor total da
-- conta ela e marcada como quitada automaticamente (fluxo inspirado no Secullum).
CREATE TABLE IF NOT EXISTS pagamentos_cobranca (
  id TEXT PRIMARY KEY,
  cobranca_id TEXT NOT NULL REFERENCES cobrancas(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  tipo TEXT, -- dinheiro | pix | cartao_credito | cartao_debito | transferencia | boleto | outro
  conta_corrente TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pagamento agregado de contas em atraso feito pelo totem (consulta por CPF):
-- uma única transação Pix pode quitar VÁRIAS cobranças ao mesmo tempo (ex:
-- aluno com 2 mensalidades vencidas paga tudo de uma vez). cobranca_ids guarda
-- o array JSON dos IDs das cobrancas cobertas por este pagamento, e quando o
-- provedor confirma, cada cobranca listada é marcada como paga (ver
-- terminal.routes.js). liberar_acesso indica se, ao confirmar, deve tentar
-- abrir a catraca também (true no totem físico, false num futuro portal
-- remoto, que nunca deve liberar catraca).
CREATE TABLE IF NOT EXISTS pagamentos_totem (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  cobranca_ids TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  provedor TEXT NOT NULL,
  provedor_referencia TEXT,
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente | pago
  liberar_acesso INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Configurações gerais do app (par chave/valor) — nome do app, "licenciado para", etc.
-- Tabela pequena e genérica de propósito: permite adicionar novas configs no futuro
-- sem precisar de ALTER TABLE.
CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

-- Módulo de treino: cada aluno pode ter vários treinos (ex: "Treino A", "Treino
-- B"), cada um associado a um ou mais dias da semana, com uma lista de
-- exercícios própria. Só é usado quando alunos.treino_modo = 'nativo' — no modo
-- 'app_externo' o aluno acompanha o treino em outro aplicativo (vínculo feito
-- por CPF/e-mail no primeiro acesso desse app, fora do nosso banco).
CREATE TABLE IF NOT EXISTS treinos (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  nome TEXT NOT NULL, -- ex: "Treino A" (editável/renomeável)
  dias_semana TEXT, -- JSON array de inteiros 0-6 (0=domingo ... 6=sabado)
  ordem INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS treino_exercicios (
  id TEXT PRIMARY KEY,
  treino_id TEXT NOT NULL REFERENCES treinos(id) ON DELETE CASCADE,
  exercicio TEXT NOT NULL,
  series TEXT, -- texto livre (ex: "4x12", "3 séries até a falha")
  carga TEXT, -- texto livre (ex: "20kg", "peso corporal")
  intervalo TEXT, -- ex: "60s", "1min30"
  observacao TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ================= Recuperação de clientes / prevenção de evasão (2026-07) =================
-- Ver STATUS-PROJETO.md, seção "Recuperação de clientes / prevenção de evasão".

-- Modelos reutilizáveis de mensagem (e-mail e/ou WhatsApp manual), usados na
-- tela "Recuperação de Clientes" pra não redigitar o texto toda vez. {nome} na
-- saudação é substituído pelo nome do aluno no momento do envio.
CREATE TABLE IF NOT EXISTS mensagens_templates (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL, -- nome interno pra identificar o modelo na lista (ex: "Oferta 5 dias grátis")
  saudacao TEXT NOT NULL DEFAULT 'Olá {nome}!',
  corpo TEXT NOT NULL,
  link_tipo TEXT NOT NULL DEFAULT 'portal', -- portal (link de acesso do aluno) | oferta (url customizada) | nenhum
  link_oferta_url TEXT, -- usado só quando link_tipo = 'oferta'
  link_oferta_texto TEXT, -- texto do link/botão quando link_tipo = 'oferta' (ex: "Aproveitar oferta")
  conceder_dias_gratis INTEGER, -- se preenchido, ENVIAR este modelo também concede N dias de acesso grátis (ver concessoes_acesso) — admin confirma isso na hora do envio
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Concessões de acesso especial/gratuito (ex: "5 dias grátis pra retomar os
-- treinos"). Libera a catraca/totem temporariamente mesmo com mensalidade em
-- atraso, SEM mexer no cadastro financeiro real (nenhuma cobrança é criada,
-- alterada ou marcada como paga). Ver acessoTerminal.service.js
-- (verificarAutorizacaoAluno/listarAutorizacoesBiometricas): uma concessão
-- ativa só ignora bloqueio por INADIMPLÊNCIA (status='inadimplente' ou
-- cobrança vencida) — cadastro trancado ou inativo continua bloqueando mesmo
-- com concessão ativa, porque essas são decisões manuais do admin, não
-- relacionadas a pagamento.
CREATE TABLE IF NOT EXISTS concessoes_acesso (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  dias INTEGER NOT NULL,
  valido_de TEXT NOT NULL, -- YYYY-MM-DD
  valido_ate TEXT NOT NULL, -- YYYY-MM-DD (inclusive)
  motivo TEXT,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Histórico de mensagens enviadas/geradas: e-mail de verdade (via SMTP) tem
-- status enviado/erro; WhatsApp é sempre "manual" (só gera o link wa.me pro
-- admin clicar e mandar ele mesmo), então status fica 'link_gerado' — não há
-- confirmação de entrega nesse canal.
CREATE TABLE IF NOT EXISTS mensagens_enviadas (
  id TEXT PRIMARY KEY,
  aluno_id TEXT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  canal TEXT NOT NULL, -- email | whatsapp
  template_id TEXT REFERENCES mensagens_templates(id) ON DELETE SET NULL,
  assunto TEXT,
  mensagem TEXT NOT NULL, -- texto final, já com {nome}/link substituídos
  destino TEXT, -- e-mail ou telefone usado no envio
  status TEXT NOT NULL DEFAULT 'enviado', -- enviado | erro | link_gerado
  erro TEXT,
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agendamento de envio de mensagens (2026-07-21): mesma origem de dados de
-- mensagens_enviadas/mensagens_templates, mas pra disparo numa data/hora
-- futura em vez de imediato. E-mail é enviado sozinho pelo job
-- src/jobs/mensagensAgendadas.js quando `agendado_para` chega. WhatsApp NUNCA
-- é enviado sozinho (mesma limitação do envio imediato — ver
-- src/routes/recuperacao.routes.js): quando `agendado_para` chega, o item só
-- vira uma notificação na tela pro admin abrir e finalizar clicando um por
-- um (GET /agendadas/:id/preparar-whatsapp + POST .../concluir-whatsapp).
-- O conteúdo final (saudação/corpo/etc.) é resolvido e GRAVADO aqui no
-- momento de agendar, não no momento de disparar — assim editar/apagar o
-- modelo depois de agendado não muda o que já foi programado pra enviar.
CREATE TABLE IF NOT EXISTS mensagens_agendadas (
  id TEXT PRIMARY KEY,
  aluno_ids_json TEXT NOT NULL, -- JSON: array de ids de alunos deste lote
  canal TEXT NOT NULL, -- email | whatsapp
  template_id TEXT REFERENCES mensagens_templates(id) ON DELETE SET NULL,
  saudacao TEXT,
  corpo TEXT NOT NULL,
  assunto TEXT,
  link_tipo TEXT NOT NULL DEFAULT 'portal',
  link_oferta_url TEXT,
  link_oferta_texto TEXT,
  conceder_dias_gratis INTEGER,
  agendado_para TEXT NOT NULL, -- AAAA-MM-DD HH:MM:SS, UTC (mesmo formato de datetime('now'))
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviado | cancelado | erro
  resultado_json TEXT, -- snapshot de `resultados` depois de processado (email automático ou whatsapp concluído manualmente)
  criado_por TEXT REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  processado_em TEXT
);

CREATE INDEX IF NOT EXISTS idx_alunos_status ON alunos(status);
CREATE INDEX IF NOT EXISTS idx_alunos_categoria ON alunos(categoria);
CREATE INDEX IF NOT EXISTS idx_alunos_indicado_por ON alunos(indicado_por_aluno_id);
CREATE INDEX IF NOT EXISTS idx_matriculas_aluno ON matriculas(aluno_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_turma_data ON agendamentos(turma_id, data_aula);
CREATE INDEX IF NOT EXISTS idx_cobrancas_status ON cobrancas(status);
CREATE INDEX IF NOT EXISTS idx_cobrancas_aluno ON cobrancas(aluno_id);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_aluno ON avaliacoes_fisicas(aluno_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_codigo_acesso ON alunos(codigo_acesso);
-- Parcial (so quando preenchido) porque a maioria dos alunos ainda nao tem
-- biometria_id - e agora que ele tambem serve de senha do portal, precisa
-- ser unico de verdade pra nunca duas pessoas caírem no mesmo login/cartao.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_biometria_id ON alunos(biometria_id) WHERE biometria_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acessos_catraca_aluno ON acessos_catraca(aluno_id);
CREATE INDEX IF NOT EXISTS idx_mensagens_agendadas_status_data ON mensagens_agendadas(status, agendado_para);
CREATE INDEX IF NOT EXISTS idx_pagamentos_cobranca_cobranca ON pagamentos_cobranca(cobranca_id);
CREATE INDEX IF NOT EXISTS idx_anamnese_respostas_anamnese ON anamnese_respostas(anamnese_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_usuario ON usuarios(usuario);
CREATE INDEX IF NOT EXISTS idx_treinos_aluno ON treinos(aluno_id);
CREATE INDEX IF NOT EXISTS idx_treino_exercicios_treino ON treino_exercicios(treino_id);
-- Trava em nível de banco contra corrida entre execuções sobrepostas de
-- gerarCobrancasRecorrentes (ex.: dois reinícios do servidor muito próximos)
-- -- a checagem em código já evita isso no caminho normal, esse índice é o
-- reforço que faz o segundo INSERT falhar/ser ignorado em vez de duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobrancas_recorrencia_matricula_vencimento ON cobrancas(matricula_id, vencimento) WHERE provedor = 'recorrencia';
-- Chaves de idempotencia da migracao do Secullum: com estes indices, rodar
-- scripts/migrar-secullum-v2.js mais de uma vez (ex.: apos uma interrupcao)
-- nunca mais cria linhas duplicadas para a mesma pessoa/plano/matricula/conta
-- - o script consulta esses indices antes de inserir e reaproveita o id
-- existente em vez de gerar um novo uuid.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_secullum_id ON alunos(secullum_id) WHERE secullum_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_planos_secullum_id ON planos(secullum_id) WHERE secullum_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_matriculas_secullum_id ON matriculas(secullum_id) WHERE secullum_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobrancas_secullum_numero ON cobrancas(secullum_numero) WHERE secullum_numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_concessoes_acesso_aluno ON concessoes_acesso(aluno_id);
CREATE INDEX IF NOT EXISTS idx_concessoes_acesso_validade ON concessoes_acesso(aluno_id, valido_ate);
CREATE INDEX IF NOT EXISTS idx_mensagens_enviadas_aluno ON mensagens_enviadas(aluno_id);
CREATE INDEX IF NOT EXISTS idx_mensagens_enviadas_criado_em ON mensagens_enviadas(criado_em);
