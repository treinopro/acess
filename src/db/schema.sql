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
  provedor TEXT NOT NULL, -- mercadopago (único suportado; "manual" também aparece p/ contas sem gateway) | infinitepay/valores antigos podem existir em cobrancas históricas
  provedor_referencia TEXT, -- id/slug da cobranca no provedor
  metodo_pagamento TEXT, -- pix | credit_card | boleto
  descricao TEXT,
  vencimento TEXT,
  pago_em TEXT,
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

CREATE INDEX IF NOT EXISTS idx_alunos_status ON alunos(status);
CREATE INDEX IF NOT EXISTS idx_matriculas_aluno ON matriculas(aluno_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_turma_data ON agendamentos(turma_id, data_aula);
CREATE INDEX IF NOT EXISTS idx_cobrancas_status ON cobrancas(status);
CREATE INDEX IF NOT EXISTS idx_cobrancas_aluno ON cobrancas(aluno_id);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_aluno ON avaliacoes_fisicas(aluno_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_codigo_acesso ON alunos(codigo_acesso);
CREATE INDEX IF NOT EXISTS idx_acessos_catraca_aluno ON acessos_catraca(aluno_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_cobranca_cobranca ON pagamentos_cobranca(cobranca_id);
CREATE INDEX IF NOT EXISTS idx_anamnese_respostas_anamnese ON anamnese_respostas(anamnese_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_usuario ON usuarios(usuario);
CREATE INDEX IF NOT EXISTS idx_treinos_aluno ON treinos(aluno_id);
CREATE INDEX IF NOT EXISTS idx_treino_exercicios_treino ON treino_exercicios(treino_id);
