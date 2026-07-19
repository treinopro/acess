const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const dbOffline = require('../db/clientOffline');
const { autenticar } = require('../middleware/auth');
const acessoTerminal = require('../services/acessoTerminal.service');
const catracaGateway = require('../services/catracaGateway.service');
const dbResiliente = require('../services/dbResiliente.service');
const filaCadastroOffline = require('../services/filaCadastroOffline.service');
const emailBoasVindas = require('../services/emailBoasVindas.service');

const router = express.Router();
router.use(autenticar);

const alunoSchema = z.object({
  nome: z.string().min(2),
  email: z.string().email().optional().nullable(),
  telefone: z.string().optional().nullable(),
  cpf: z.string().optional().nullable(),
  data_nascimento: z.string().optional().nullable(),
  foto_url: z.string().url().optional().nullable(),
  observacoes: z.string().optional().nullable(),
  biometria_id: z.string().optional().nullable(),
  // 'nativo' = treino cadastrado neste sistema | 'app_externo' = aluno usa outro app de treino.
  treino_modo: z.enum(['nativo', 'app_externo']).optional().nullable(),
  // Categoria da pessoa (2026-07 — ver schema.sql/acessoTerminal.service.js).
  // colaborador/bolsista têm acesso livre; visitante tem limite de acessos;
  // aluno/professor seguem a regra normal de mensalidade. Editável aqui pelo
  // admin (ex.: promover um cadastro de "aluno" pra "professor"/"colaborador").
  categoria: z.enum(['aluno', 'professor', 'visitante', 'colaborador', 'bolsista']).optional().nullable(),
});

const anamneseSchema = z.object({
  historico_saude: z.string().optional().nullable(),
  restricoes: z.string().optional().nullable(),
  peso_kg: z.number().positive().optional().nullable(),
  altura_cm: z.number().positive().optional().nullable(),
  observacoes_medicas: z.string().optional().nullable(),
});

const avaliacaoSchema = z.object({
  data_avaliacao: z.string(),
  peso_kg: z.number().positive().optional().nullable(),
  altura_cm: z.number().positive().optional().nullable(),
  percentual_gordura: z.number().positive().optional().nullable(),
  medida_cintura_cm: z.number().positive().optional().nullable(),
  medida_quadril_cm: z.number().positive().optional().nullable(),
  medida_peito_cm: z.number().positive().optional().nullable(),
  medida_braco_cm: z.number().positive().optional().nullable(),
  medida_coxa_cm: z.number().positive().optional().nullable(),
  objetivo: z.string().optional().nullable(),
  observacoes: z.string().optional().nullable(),
});

// ---------------- Importar / exportar em CSV ----------------
// Sem dependência externa de propósito (nenhuma lib de CSV instalada) — o parser/gerador
// abaixo é minimalista mas cobre o essencial (campos com vírgula/aspas/quebra de linha).

function paraCsvCampo(valor) {
  const str = valor === null || valor === undefined ? '' : String(valor);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function gerarCsv(linhas, colunas) {
  const cabecalho = colunas.join(',');
  const corpo = linhas.map((linha) => colunas.map((col) => paraCsvCampo(linha[col])).join(',')).join('\n');
  return `${cabecalho}\n${corpo}`;
}

function parseCsv(texto) {
  const linhas = [];
  let campo = '';
  let linhaAtual = [];
  let dentroAspas = false;
  const chars = texto.replace(/\r\n/g, '\n');

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (dentroAspas) {
      if (c === '"') {
        if (chars[i + 1] === '"') { campo += '"'; i++; } else { dentroAspas = false; }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      dentroAspas = true;
    } else if (c === ',') {
      linhaAtual.push(campo); campo = '';
    } else if (c === '\n') {
      linhaAtual.push(campo); campo = '';
      linhas.push(linhaAtual); linhaAtual = [];
    } else {
      campo += c;
    }
  }
  if (campo.length || linhaAtual.length) { linhaAtual.push(campo); linhas.push(linhaAtual); }
  if (!linhas.length) return [];

  const cabecalho = linhas[0].map((h) => h.trim());
  return linhas.slice(1)
    .filter((l) => l.some((v) => v !== ''))
    .map((l) => {
      const obj = {};
      cabecalho.forEach((h, idx) => { obj[h] = l[idx] !== undefined ? l[idx] : ''; });
      return obj;
    });
}

const COLUNAS_CSV_ALUNOS = ['nome', 'email', 'telefone', 'cpf', 'data_nascimento', 'status', 'observacoes'];

// GET /api/alunos/exportar?incluir_inativos=true — exporta os alunos em CSV.
// Por padrão só os ativos; passe incluir_inativos=true (checkbox "mostrar inativos"
// na tela) pra exportar todo mundo. Baixado sem nenhum aluno cadastrado ainda,
// serve como modelo em branco (só o cabeçalho) pra preencher no Excel/Sheets.
router.get('/exportar', async (req, res, next) => {
  try {
    const incluirInativos = req.query.incluir_inativos === 'true' || req.query.incluir_inativos === '1';
    const sql = incluirInativos
      ? 'SELECT * FROM alunos ORDER BY nome'
      : "SELECT * FROM alunos WHERE status = 'ativo' ORDER BY nome";
    const result = await db.execute(sql);
    const csv = gerarCsv(result.rows, COLUNAS_CSV_ALUNOS);
    const nomeArquivo = `alunos-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(`﻿${csv}`); // BOM — abre certinho com acentos no Excel
  } catch (err) {
    next(err);
  }
});

// POST /api/alunos/importar { csv: "<texto csv>" }
// Casa por CPF (se informado) ou e-mail pra decidir entre atualizar um aluno existente
// ou criar um novo. Linhas sem nome são ignoradas e reportadas em "erros".
router.post('/importar', async (req, res, next) => {
  try {
    const { csv } = z.object({ csv: z.string().min(1) }).parse(req.body);
    const linhas = parseCsv(csv);

    let criados = 0;
    let atualizados = 0;
    const erros = [];

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      const nome = (linha.nome || '').trim();
      if (!nome) { erros.push(`Linha ${i + 2}: sem nome, ignorada.`); continue; }

      const cpf = (linha.cpf || '').trim() || null;
      const email = (linha.email || '').trim() || null;

      let existente = null;
      if (cpf) {
        const r = await db.execute({ sql: 'SELECT id FROM alunos WHERE cpf = ?', args: [cpf] });
        existente = r.rows[0] || null;
      }
      if (!existente && email) {
        const r = await db.execute({ sql: 'SELECT id FROM alunos WHERE email = ?', args: [email] });
        existente = r.rows[0] || null;
      }

      const dados = {
        nome,
        email,
        telefone: (linha.telefone || '').trim() || null,
        cpf,
        data_nascimento: (linha.data_nascimento || '').trim() || null,
        observacoes: (linha.observacoes || '').trim() || null,
      };
      const statusLido = (linha.status || '').trim();
      const statusValido = ['ativo', 'inativo', 'trancado', 'inadimplente'].includes(statusLido) ? statusLido : null;

      try {
        if (existente) {
          await db.execute({
            sql: `UPDATE alunos SET nome = ?, email = ?, telefone = ?, cpf = ?, data_nascimento = ?, observacoes = ?
                  WHERE id = ?`,
            args: [dados.nome, dados.email, dados.telefone, dados.cpf, dados.data_nascimento, dados.observacoes, existente.id],
          });
          if (statusValido) {
            await db.execute({ sql: 'UPDATE alunos SET status = ? WHERE id = ?', args: [statusValido, existente.id] });
          }
          atualizados++;
        } else {
          const id = uuid();
          await db.execute({
            sql: `INSERT INTO alunos (id, nome, email, telefone, cpf, data_nascimento, observacoes, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [id, dados.nome, dados.email, dados.telefone, dados.cpf, dados.data_nascimento, dados.observacoes, statusValido || 'ativo'],
          });
          criados++;
        }
      } catch (errLinha) {
        erros.push(`Linha ${i + 2} (${nome}): ${errLinha.message}`);
      }
    }

    res.json({ ok: true, criados, atualizados, erros });
  } catch (err) {
    next(err);
  }
});

// GET /api/alunos?status=ativo&busca=texto&incluir_inativos=true — busca por nome ou ID
// (parcial, case-insensitive). Por padrão só retorna alunos com status='ativo'; passe
// incluir_inativos=true (checkbox "mostrar inativos" na tela) pra ver todos os status,
// ou status=<algo> pra filtrar por um status específico (tem prioridade sobre o padrão).
//
// Modo totem offline-resiliente (MODO_TOTEM_OFFLINE=true): se o Turso não
// responder, cai pro cache local (local.db, sincronizado a cada poucos
// minutos — ver syncOfflineCache.js), pra a recepção continuar conseguindo
// consultar cadastro mesmo sem internet. Fora desse modo, comportamento
// idêntico ao de sempre (sempre Turso, sem fallback).
router.get('/', async (req, res, next) => {
  try {
    const { status, busca, incluir_inativos: incluirInativos } = req.query;
    const condicoes = [];
    const args = [];

    if (status) {
      condicoes.push('status = ?'); args.push(status);
    } else if (!(incluirInativos === 'true' || incluirInativos === '1')) {
      condicoes.push("status = 'ativo'");
    }
    if (busca) {
      condicoes.push('(nome LIKE ? OR id LIKE ?)');
      args.push(`%${busca}%`, `%${busca}%`);
    }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const sql = `SELECT * FROM alunos ${where} ORDER BY nome`;
    const result = await dbResiliente.comFallback(
      'buscarAlunos',
      () => db.execute({ sql, args }),
      () => dbOffline.execute({ sql, args }),
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Pendências de sincronização (modo totem offline-resiliente) — edições de
// cadastro e pagamentos que foram feitos offline e, ao tentar sincronizar,
// encontraram o registro diferente do que estava quando a edição foi feita
// (ver filaCadastroOffline.service.js). Ficam aqui esperando o admin decidir
// manualmente qual valor manter. Vem ANTES de "GET /:id" de propósito —
// senão "/pendencias-sincronizacao" seria capturado por essa rota genérica
// como se fosse um ID de aluno.
// ---------------------------------------------------------------------------

// GET /api/alunos/pendencias-sincronizacao — lista tudo que está na fila
// local (tanto os já resolvidos automaticamente na próxima sincronização
// quanto os que travaram em conflito, aguardando decisão manual).
router.get('/pendencias-sincronizacao', async (req, res, next) => {
  try {
    res.json(filaCadastroOffline.listarPendentes());
  } catch (err) {
    next(err);
  }
});

// POST /api/alunos/pendencias-sincronizacao/:pendenciaId/resolver { decisao: 'aplicar' | 'descartar' }
// 'aplicar' = usa o valor editado offline mesmo assim, sobrescrevendo o que
// está no Turso agora. 'descartar' = mantém o que já está no Turso, joga fora
// a edição/pagamento feito offline.
router.post('/pendencias-sincronizacao/:pendenciaId/resolver', async (req, res, next) => {
  try {
    const { decisao } = z.object({ decisao: z.enum(['aplicar', 'descartar']) }).parse(req.body);
    const resultado = await filaCadastroOffline.resolverPendencia(req.params.pendenciaId, decisao);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/alunos/:id — mesmo fallback offline da busca acima.
router.get('/:id', async (req, res, next) => {
  try {
    const result = await dbResiliente.comFallback(
      'buscarAlunoPorId',
      () => db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [req.params.id] }),
      () => dbOffline.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [req.params.id] }),
    );
    if (!result.rows[0]) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/alunos/:id/status-acesso — mesma regra usada pra liberar a catraca
// (verificarAutorizacaoAluno), exposta pro painel mostrar "Liberado/Bloqueado"
// sem duplicar a lógica (usado na tela de Pagamento Rápido).
router.get('/:id/status-acesso', async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    const { autorizado, motivo } = await acessoTerminal.verificarAutorizacaoAluno(result.rows[0]);
    res.json({ liberado: autorizado, motivo });
  } catch (err) {
    next(err);
  }
});

// POST /api/alunos
router.post('/', async (req, res, next) => {
  try {
    const dados = alunoSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO alunos (id, nome, email, telefone, cpf, data_nascimento, foto_url, observacoes, biometria_id, categoria)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.nome, dados.email || null, dados.telefone || null, dados.cpf || null,
        dados.data_nascimento || null, dados.foto_url || null, dados.observacoes || null, dados.biometria_id || null,
        dados.categoria || 'aluno'],
    });
    // E-mail de boas-vindas automático (2026-07): se o cadastro já tem e-mail
    // e o Gmail está configurado, manda em segundo plano (best-effort — nunca
    // atrasa nem quebra a resposta do cadastro em si; se falhar, quem cadastrou
    // continua podendo mandar manualmente depois pela tela de Recuperação de
    // Clientes). Ver src/services/emailBoasVindas.service.js.
    if (dados.email) {
      emailBoasVindas.enviarBoasVindasSeguro({ id, nome: dados.nome, email: dados.email }).catch(() => {});
    }
    res.status(201).json({ id, ...dados });
  } catch (err) {
    next(err);
  }
});

// Lê do local.db (cache — pode estar desatualizado, é só o que temos offline)
// os valores ATUAIS de um conjunto de colunas de um registro, pra usar como
// "valor anterior conhecido" numa pendência da fila de cadastro. Se a leitura
// do cache falhar por qualquer motivo, devolve um objeto vazio — pior caso,
// o flush() trata como "divergiu" e pede confirmação manual em vez de
// aplicar sozinho, o que é o lado seguro de errar aqui.
async function snapshotOffline(tabela, id, colunas) {
  try {
    const result = await dbOffline.execute({ sql: `SELECT ${colunas.join(', ')} FROM ${tabela} WHERE id = ?`, args: [id] });
    return result.rows[0] || {};
  } catch {
    return {};
  }
}

// 2026-07-14: as pendências de sincronização mostravam só o id bruto do
// registro (ex.: "conta e780aa0c-2016-43b4-..."), sem nenhum jeito de saber
// de qual aluno se tratava — obrigando a caçar no banco manualmente pra
// identificar quem era. Esse helper busca o nome no cache local (mesmo
// "melhor esforço, nunca quebra" do snapshotOffline acima) só pra exibição.
async function nomeAlunoOffline(alunoId) {
  const linha = await snapshotOffline('alunos', alunoId, ['nome']);
  return linha.nome || null;
}

// Dispara o e-mail de boas-vindas quando o e-mail do aluno é ADICIONADO ou
// TROCADO pelo PUT genérico abaixo (2026-07-19 — correção de bug: o botão
// "+ Novo aluno" do painel cria o registro em branco via POST /api/alunos,
// SEM e-mail — o gatilho automático que já existia em POST só dispara quando
// o e-mail já vem preenchido naquele momento — e o e-mail de verdade só é
// preenchido depois, na aba "Dados pessoais" do perfil, que salva por PUT.
// Sem este gatilho aqui, todo aluno cadastrado pelo painel (o fluxo mais
// comum) nunca recebia o e-mail automático.
//
// IMPORTANTE: dispara só quando o e-mail muda de verdade (era vazio e virou
// algo, ou trocou de valor) — NÃO a cada clique em "Salvar dados" com o mesmo
// e-mail de sempre, senão qualquer edição de telefone/observações reenviaria
// o convite. Quem chama (PUT abaixo) já compara valor antigo x novo antes de
// chamar esta função; o `AND status = 'enviado'` aqui é só uma segunda trava
// de segurança (evita duplicar caso a mesma chamada seja disparada 2x).
async function dispararBoasVindasSeNecessario(alunoId) {
  try {
    const jaEnviado = await db.execute({
      sql: `SELECT id FROM mensagens_enviadas WHERE aluno_id = ? AND assunto = ? AND status = 'enviado' LIMIT 1`,
      args: [alunoId, emailBoasVindas.ASSUNTO_BOAS_VINDAS],
    });
    if (jaEnviado.rows[0]) return;

    const alunoResult = await db.execute({ sql: 'SELECT nome, email FROM alunos WHERE id = ?', args: [alunoId] });
    const aluno = alunoResult.rows[0];
    if (!aluno || !aluno.email) return;

    await emailBoasVindas.enviarBoasVindasSeguro({ id: alunoId, nome: aluno.nome, email: aluno.email });
  } catch {
    // Best-effort de propósito — nunca deve quebrar a resposta do PUT.
  }
}

// PUT /api/alunos/:id
//
// Modo totem offline-resiliente: se o Turso não responder, a edição não é
// perdida — entra na fila local (filaCadastroOffline.service.js) com um
// "retrato" de como os campos editados estavam no cache local no momento da
// tentativa. Quando a internet voltar, só aplica automaticamente se ninguém
// tiver mexido nesses campos por outro caminho nesse meio tempo; senão, fica
// esperando o admin decidir no painel ("Pendências de sincronização").
router.put('/:id', async (req, res, next) => {
  try {
    const dados = alunoSchema.partial().parse(req.body);
    const campos = Object.keys(dados);
    if (campos.length === 0) return res.status(400).json({ erro: 'Nenhum campo informado.' });

    // Precisa do e-mail ANTIGO antes de aplicar o UPDATE, pra só disparar o
    // e-mail de boas-vindas quando ele realmente mudar (ver
    // dispararBoasVindasSeNecessario acima) — não a cada "Salvar dados" com o
    // mesmo e-mail de sempre. Só busca quando 'email' está de fato sendo
    // enviado neste PUT (evita uma consulta à toa nos outros casos).
    let emailMudou = false;
    if (campos.includes('email') && dados.email) {
      const anterior = await db.execute({ sql: 'SELECT email FROM alunos WHERE id = ?', args: [req.params.id] });
      emailMudou = (anterior.rows[0]?.email || null) !== dados.email;
    }

    async function aplicarOnline() {
      const sets = campos.map((c) => `${c} = ?`).join(', ');
      const args = [...campos.map((c) => dados[c]), req.params.id];
      await db.execute({ sql: `UPDATE alunos SET ${sets} WHERE id = ?`, args });
    }

    if (!dbResiliente.MODO_TOTEM_OFFLINE) {
      await aplicarOnline();
    } else {
      try {
        await dbResiliente.comTimeout(aplicarOnline(), dbResiliente.timeoutAtual());
        dbResiliente.registrarRecuperacaoSeNecessario();
      } catch (err) {
        dbResiliente.logAlertaOffline('editar aluno', err);
        const valoresAnterioresConhecidos = await snapshotOffline('alunos', req.params.id, campos);
        const alunoNome = await nomeAlunoOffline(req.params.id);
        filaCadastroOffline.registrar({
          tipo: 'update_campo',
          tabela: 'alunos',
          registroId: req.params.id,
          campos: dados,
          valoresAnterioresConhecidos,
          alunoNome,
          descricaoResumo: alunoNome
            ? `Editar dados de ${alunoNome} (${campos.join(', ')})`
            : `Editar dados do aluno ${req.params.id} (${campos.join(', ')})`,
          criadoPor: req.usuario?.email || null,
        });
        // Este endpoint genérico pode alterar biometria_id/categoria junto
        // com o resto (categoria afeta a regra de autorização — ver
        // verificarAutorizacaoAluno) — best-effort, não bloqueia a resposta.
        if (campos.includes('biometria_id') || campos.includes('categoria')) acessoTerminal.notificarAgenteAtualizacaoAluno(req.params.id);
        return res.status(202).json({
          ok: true, enfileirado: true,
          aviso: 'Sem conexão com o Turso agora — alteração guardada e será sincronizada automaticamente quando a internet voltar.',
        });
      }
    }

    // Este endpoint genérico pode alterar biometria_id/categoria junto com o
    // resto — best-effort, não bloqueia a resposta (ver notificarAgenteAtualizacaoAluno).
    if (campos.includes('biometria_id') || campos.includes('categoria')) acessoTerminal.notificarAgenteAtualizacaoAluno(req.params.id);
    // Ver dispararBoasVindasSeNecessario acima — cobre o caso (mais comum no
    // painel admin) de o e-mail ser adicionado/trocado aqui, não no cadastro
    // inicial. Só quando o e-mail muda de verdade (ver `emailMudou` acima) —
    // best-effort, não bloqueia a resposta.
    if (emailMudou) dispararBoasVindasSeNecessario(req.params.id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alunos/:id/status  { status: 'ativo' | 'inativo' | 'trancado' | 'inadimplente' }
// Mesmo mecanismo de fila/conflito do PUT acima, aplicado só ao campo status.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const status = z.enum(['ativo', 'inativo', 'trancado', 'inadimplente']).parse(req.body.status);

    async function aplicarOnline() {
      await db.execute({ sql: 'UPDATE alunos SET status = ? WHERE id = ?', args: [status, req.params.id] });
    }

    if (!dbResiliente.MODO_TOTEM_OFFLINE) {
      await aplicarOnline();
    } else {
      try {
        await dbResiliente.comTimeout(aplicarOnline(), dbResiliente.timeoutAtual());
        dbResiliente.registrarRecuperacaoSeNecessario();
      } catch (err) {
        dbResiliente.logAlertaOffline('alterar status do aluno', err);
        const valoresAnterioresConhecidos = await snapshotOffline('alunos', req.params.id, ['status']);
        const alunoNome = await nomeAlunoOffline(req.params.id);
        filaCadastroOffline.registrar({
          tipo: 'update_campo',
          tabela: 'alunos',
          registroId: req.params.id,
          campos: { status },
          valoresAnterioresConhecidos,
          alunoNome,
          descricaoResumo: alunoNome
            ? `Alterar status de ${alunoNome} para "${status}"`
            : `Alterar status do aluno ${req.params.id} para "${status}"`,
          criadoPor: req.usuario?.email || null,
        });
        acessoTerminal.notificarAgenteAtualizacaoAluno(req.params.id);
        return res.status(202).json({
          ok: true, enfileirado: true,
          aviso: 'Sem conexão com o Turso agora — alteração guardada e será sincronizada automaticamente quando a internet voltar.',
        });
      }
    }

    // Best-effort, não bloqueia a resposta — atualiza o cache local do
    // agente da catraca (Fase 1 do modo offline/resiliente) sem esperar o
    // próximo pull periódico dele.
    acessoTerminal.notificarAgenteAtualizacaoAluno(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alunos/:id/biometria  { biometria_id }
// Ponto de integração com leitores biométricos/catracas: o dispositivo (ou o
// software dele) cadastra o template no leitor e envia de volta um ID/hash de
// referência, que é o que guardamos aqui — não armazenamos o template em si.
router.patch('/:id/biometria', async (req, res, next) => {
  try {
    const biometriaId = z.string().min(1).parse(req.body.biometria_id);
    await db.execute({
      sql: 'UPDATE alunos SET biometria_id = ? WHERE id = ?',
      args: [biometriaId, req.params.id],
    });
    acessoTerminal.notificarAgenteAtualizacaoAluno(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/biometria', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE alunos SET biometria_id = NULL WHERE id = ?', args: [req.params.id] });
    // biometria_id acabou de virar NULL — notificarAgenteAtualizacaoAluno não
    // vai encontrar mais nada pra mandar (checa aluno.biometria_id), então o
    // registro antigo só some do cache do agente no próximo pull periódico
    // completo (substituirTudo). Sem risco: um registro "sobrando" no cache
    // só ajuda a liberar mais um pouco, nunca bloqueia (mesma filosofia
    // fail-open de todo este sistema).
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/alunos/biometria/capturar-catraca — usado pelo botão "Capturar pela
// catraca" na aba Biometria & acesso do cadastro do aluno. Pede pro agente local
// aguardar a PRÓXIMA leitura de digital na catraca (até ~25s) e devolve o id lido,
// SEM salvar em nenhum aluno ainda — quem salva é o admin, clicando em "Salvar ID
// biométrico" depois de conferir o valor preenchido automaticamente no campo.
// Não tem relação com autenticarTerminal/TERMINAL_TOKEN (isso é só pra dispositivos
// de campo) — aqui quem chama é o próprio painel admin autenticado (JWT).
router.post('/biometria/capturar-catraca', async (req, res, next) => {
  try {
    const resultado = await catracaGateway.capturarProximaBiometria({});
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alunos/:id/codigo-acesso — gera (ou reaproveita) o código estável
// usado no QR "meu acesso" pessoal do aluno para o totem. Usar com
// ?regenerar=1 para invalidar o código atual e gerar um novo (ex.: celular
// perdido/comprometido).
router.patch('/:id/codigo-acesso', async (req, res, next) => {
  try {
    if (req.query.regenerar) {
      const novoCodigo = acessoTerminal.gerarCodigoAcesso();
      await db.execute({ sql: 'UPDATE alunos SET codigo_acesso = ? WHERE id = ?', args: [novoCodigo, req.params.id] });
      return res.json({ codigo_acesso: novoCodigo });
    }
    const codigo = await acessoTerminal.garantirCodigoAcesso(req.params.id);
    res.json({ codigo_acesso: codigo });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/alunos/:id/face — remove o descritor facial (permite recadastrar no totem)
router.delete('/:id/face', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE alunos SET face_descriptor = NULL WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/alunos/:id/face { descriptor } — cadastra o rosto direto pelo painel
// admin (câmera do computador da recepção), sem precisar levar o aluno ao totem.
router.put('/:id/face', async (req, res, next) => {
  try {
    const { descriptor } = z.object({ descriptor: z.array(z.number()).min(16) }).parse(req.body);
    await acessoTerminal.salvarFaceDescriptor(req.params.id, descriptor);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/alunos/:id — exclusão definitiva, com limpeza explícita dos
// registros dependentes (não contamos com ON DELETE CASCADE do SQLite/libSQL
// porque em conexões remotas ao Turso o pragma foreign_keys nem sempre persiste).
router.delete('/:id', async (req, res, next) => {
  try {
    const aluno = await db.execute({ sql: 'SELECT id FROM alunos WHERE id = ?', args: [req.params.id] });
    if (!aluno.rows[0]) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    const tabelasDependentes = ['checkins', 'agendamentos', 'cobrancas', 'matriculas', 'anamneses', 'avaliacoes_fisicas'];
    for (const tabela of tabelasDependentes) {
      await db.execute({ sql: `DELETE FROM ${tabela} WHERE aluno_id = ?`, args: [req.params.id] });
    }
    await db.execute({ sql: 'DELETE FROM alunos WHERE id = ?', args: [req.params.id] });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- Perfil agregado ----------------

// GET /api/alunos/:id/perfil — tudo que a tela de perfil do aluno precisa em uma chamada só.
//
// Modo totem offline-resiliente: se o Turso não responder, cai pro cache
// local (local.db), mas só consegue mostrar aluno/matrículas/cobranças (as
// tabelas espelhadas — ver syncOfflineCache.js). Anamnese, avaliações físicas
// e agendamentos NÃO são espelhados (dados menos urgentes de consultar numa
// emergência de falta de internet) — voltam vazios nesse modo, com
// `modo_offline: true` na resposta pro painel avisar o admin que os dados
// podem estar incompletos/desatualizados.
router.get('/:id/perfil', async (req, res, next) => {
  try {
    const alunoId = req.params.id;
    let modoOffline = false;

    async function buscarOnline() {
      const aluno = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [alunoId] });
      if (!aluno.rows[0]) return null;

      const [anamnese, avaliacoes, matriculas, agendamentos, cobrancas] = await Promise.all([
        db.execute({ sql: 'SELECT * FROM anamneses WHERE aluno_id = ? ORDER BY criado_em DESC LIMIT 1', args: [alunoId] }),
        db.execute({ sql: 'SELECT * FROM avaliacoes_fisicas WHERE aluno_id = ? ORDER BY data_avaliacao DESC', args: [alunoId] }),
        db.execute({
          sql: `SELECT m.*, p.nome as plano_nome FROM matriculas m JOIN planos p ON p.id = m.plano_id
                WHERE m.aluno_id = ? ORDER BY m.data_inicio DESC`,
          args: [alunoId],
        }),
        db.execute({
          sql: `SELECT ag.*, t.nome as turma_nome FROM agendamentos ag JOIN turmas t ON t.id = ag.turma_id
                WHERE ag.aluno_id = ? ORDER BY ag.data_aula DESC LIMIT 15`,
          args: [alunoId],
        }),
        db.execute({ sql: 'SELECT * FROM cobrancas WHERE aluno_id = ? ORDER BY criado_em DESC', args: [alunoId] }),
      ]);

      return {
        aluno: aluno.rows[0],
        anamnese: anamnese.rows[0] || null,
        avaliacoes: avaliacoes.rows,
        matriculas: matriculas.rows,
        agendamentos: agendamentos.rows,
        cobrancas: cobrancas.rows,
      };
    }

    async function buscarOffline() {
      modoOffline = true;
      const aluno = await dbOffline.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [alunoId] });
      if (!aluno.rows[0]) return null;

      const [matriculas, cobrancas] = await Promise.all([
        dbOffline.execute({
          sql: `SELECT m.*, p.nome as plano_nome FROM matriculas m JOIN planos p ON p.id = m.plano_id
                WHERE m.aluno_id = ? ORDER BY m.data_inicio DESC`,
          args: [alunoId],
        }),
        dbOffline.execute({ sql: 'SELECT * FROM cobrancas WHERE aluno_id = ? ORDER BY criado_em DESC', args: [alunoId] }),
      ]);

      return {
        aluno: aluno.rows[0],
        anamnese: null,
        avaliacoes: [],
        matriculas: matriculas.rows,
        agendamentos: [],
        cobrancas: cobrancas.rows,
      };
    }

    const resultado = await dbResiliente.comFallback('buscarPerfilAluno', buscarOnline, buscarOffline);
    if (!resultado) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    res.json({ ...resultado, modo_offline: modoOffline });
  } catch (err) {
    next(err);
  }
});

// ---------------- Anamnese (dado sensível — ver LGPD no README) ----------------

// PUT /api/alunos/:id/anamnese — cria ou atualiza a anamnese (1 por aluno)
router.put('/:id/anamnese', async (req, res, next) => {
  try {
    const dados = anamneseSchema.parse(req.body);
    const alunoId = req.params.id;

    const existente = await db.execute({
      sql: 'SELECT id FROM anamneses WHERE aluno_id = ? ORDER BY criado_em DESC LIMIT 1',
      args: [alunoId],
    });

    if (existente.rows[0]) {
      await db.execute({
        sql: `UPDATE anamneses SET historico_saude = ?, restricoes = ?, peso_kg = ?, altura_cm = ?, observacoes_medicas = ?
              WHERE id = ?`,
        args: [dados.historico_saude || null, dados.restricoes || null, dados.peso_kg || null,
          dados.altura_cm || null, dados.observacoes_medicas || null, existente.rows[0].id],
      });
      return res.json({ ok: true, id: existente.rows[0].id });
    }

    const id = uuid();
    await db.execute({
      sql: `INSERT INTO anamneses (id, aluno_id, historico_saude, restricoes, peso_kg, altura_cm, observacoes_medicas)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, alunoId, dados.historico_saude || null, dados.restricoes || null,
        dados.peso_kg || null, dados.altura_cm || null, dados.observacoes_medicas || null],
    });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// ---------------- Avaliações físicas (histórico de evolução) ----------------

// POST /api/alunos/:id/avaliacoes
router.post('/:id/avaliacoes', async (req, res, next) => {
  try {
    const dados = avaliacaoSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO avaliacoes_fisicas
            (id, aluno_id, data_avaliacao, peso_kg, altura_cm, percentual_gordura,
             medida_cintura_cm, medida_quadril_cm, medida_peito_cm, medida_braco_cm, medida_coxa_cm, objetivo, observacoes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.id, dados.data_avaliacao, dados.peso_kg || null, dados.altura_cm || null,
        dados.percentual_gordura || null, dados.medida_cintura_cm || null, dados.medida_quadril_cm || null,
        dados.medida_peito_cm || null, dados.medida_braco_cm || null, dados.medida_coxa_cm || null,
        dados.objetivo || null, dados.observacoes || null],
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// GET /api/alunos/:id/avaliacoes
router.get('/:id/avaliacoes', async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM avaliacoes_fisicas WHERE aluno_id = ? ORDER BY data_avaliacao DESC',
      args: [req.params.id],
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/alunos/avaliacoes/:avaliacaoId
router.delete('/avaliacoes/:avaliacaoId', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM avaliacoes_fisicas WHERE id = ?', args: [req.params.avaliacaoId] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
