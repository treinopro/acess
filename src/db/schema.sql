-- Schema inicial do sistema de gestao de alunos
-- Compativel com SQLite / libSQL (Turso)

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
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
  objetivo TEXT,
  observacoes TEXT,
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
  provedor TEXT NOT NULL, -- mercadopago | infinitepay
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

CREATE INDEX IF NOT EXISTS idx_alunos_status ON alunos(status);
CREATE INDEX IF NOT EXISTS idx_matriculas_aluno ON matriculas(aluno_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_turma_data ON agendamentos(turma_id, data_aula);
CREATE INDEX IF NOT EXISTS idx_cobrancas_status ON cobrancas(status);
CREATE INDEX IF NOT EXISTS idx_cobrancas_aluno ON cobrancas(aluno_id);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_aluno ON avaliacoes_fisicas(aluno_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_codigo_acesso ON alunos(codigo_acesso);
CREATE INDEX IF NOT EXISTS idx_acessos_catraca_aluno ON acessos_catraca(aluno_id);
