/**
 * Recuperação de clientes / prevenção de evasão (2026-07).
 *
 * Reúne tudo que ajuda a identificar alunos em risco de cancelamento e agir
 * antes que isso aconteça: lista de "dias sem acesso" (quem parou de
 * frequentar), aniversariantes do mês (gatilho natural pra reengajar),
 * modelos de mensagem reutilizáveis, envio por e-mail (Gmail SMTP + Senha de
 * App, ver src/services/email.service.js) ou geração de link do WhatsApp
 * (SEMPRE manual — o admin clica e manda ele mesmo, não há disparo
 * automático), e concessão de acesso especial/gratuito (ex: "5 dias grátis
 * pra retomar aos treinos" — ver acessoTerminal.service.js).
 *
 * Tudo aqui é admin-only (rotas de gestão, não de autoatendimento do aluno).
 */
const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db/client');
const { autenticar, apenasAdmin } = require('../middleware/auth');
const acessoTerminal = require('../services/acessoTerminal.service');
const emailService = require('../services/email.service');

const router = express.Router();
router.use(autenticar, apenasAdmin);

const templateSchema = z.object({
  nome: z.string().min(2),
  saudacao: z.string().min(1).default('Olá {nome}!'),
  corpo: z.string().min(1),
  link_tipo: z.enum(['portal', 'oferta', 'nenhum']).default('portal'),
  link_oferta_url: z.string().url().optional().nullable(),
  link_oferta_texto: z.string().optional().nullable(),
  // Cap em 90 dias: valor alto o bastante pra qualquer oferta razoável, baixo
  // o bastante pra um erro de digitação (ex: 900 em vez de 90) não conceder
  // acesso gratuito por quase 2 anos sem ninguém perceber.
  conceder_dias_gratis: z.number().int().min(1).max(90).optional().nullable(),
  ativo: z.boolean().optional(),
});

const enviarSchema = z.object({
  aluno_ids: z.array(z.string().min(1)).min(1),
  canal: z.enum(['email', 'whatsapp']),
  template_id: z.string().optional().nullable(),
  saudacao: z.string().optional().nullable(),
  corpo: z.string().optional().nullable(),
  assunto: z.string().optional().nullable(),
  link_tipo: z.enum(['portal', 'oferta', 'nenhum']).optional(),
  link_oferta_url: z.string().url().optional().nullable(),
  link_oferta_texto: z.string().optional().nullable(),
  conceder_dias_gratis: z.number().int().min(1).max(90).optional().nullable(),
});

const concederAcessoSchema = z.object({
  aluno_id: z.string().min(1),
  dias: z.number().int().min(1).max(90),
  motivo: z.string().optional().nullable(),
});

function primeiroNome(nomeCompleto) {
  return String(nomeCompleto || '').trim().split(/\s+/)[0] || nomeCompleto;
}

function obterOrigin(req) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).trim();
  return base.replace(/\/+$/, '');
}

function montarLinkPortal(aluno, origin) {
  if (aluno.codigo_acesso) return `${origin}/meu-acesso.html?codigo=${aluno.codigo_acesso}`;
  return `${origin}/portal.html`;
}

// 2026-07: além de {nome} (já existia, só na saudação), agora {senha} também
// é aceito em saudação OU corpo — usado pelo modelo seed "Boas-vindas /
// Cadastro facial" (ver seedMensagensTemplates em migrate.js) pra reenviar em
// massa o mesmo convite do e-mail automático de cadastro (ver
// emailBoasVindas.service.js), incluindo a senha de acesso ao portal de cada
// aluno. Só busca/gera essa senha (ver POST /enviar abaixo) quando o texto
// realmente usa {senha} — não teria sentido gerar um código novo pra quem
// nunca vai ver essa informação.
function substituirVariaveis(texto, { nome, senha }) {
  return String(texto || '')
    .replace(/\{nome\}/g, primeiroNome(nome))
    .replace(/\{senha\}/g, senha || '');
}

function usaVariavelSenha(saudacao, corpo) {
  return /\{senha\}/.test(String(saudacao || '')) || /\{senha\}/.test(String(corpo || ''));
}

// 2026-07-19 (correção de bug — "null dias sem acesso" na tela): o SQLite
// grava datas via `datetime('now')` como "AAAA-MM-DD HH:MM:SS" (sem 'Z' nem
// deslocamento), mas alguns registros de acessos_catraca vêm de outro caminho
// — a fila de reenvio do modo offline-resiliente (ver
// registrarAcessoIdempotenteEm em acessoTerminal.service.js), que grava
// `criado_em` no formato ISO-8601 completo (`new Date().toISOString()`, já
// com 'T' e 'Z'). O cálculo de dias-sem-acesso abaixo simplesmente
// acrescentava um 'Z' extra sem checar se a string já tinha fuso — pra uma
// data já em ISO-8601 isso gera "...000ZZ" (Z duplicado), uma data inválida
// (NaN), que o JSON.stringify silenciosamente vira `null` na resposta —
// exibido na tela como o texto literal "null dias sem acesso" em vez de um
// número. Mesmo problema (e mesma lógica de correção) já resolvido do lado do
// front-end em parseDataHoraServidor (public/app.js) — replicado aqui.
function parseDataHoraFlexivel(str) {
  if (!str) return null;
  const texto = String(str);
  const temFusoExplicito = /[zZ]|[+-]\d{2}:?\d{2}$/.test(texto);
  const pareceDataHoraSemFuso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(texto);
  const normalizado = pareceDataHoraSemFuso && !temFusoExplicito ? `${texto.replace(' ', 'T')}Z` : texto;
  return new Date(normalizado);
}

function montarMensagem({
  aluno, saudacao, corpo, linkTipo, linkOfertaUrl, linkOfertaTexto, origin, senha,
}) {
  const variaveis = { nome: aluno.nome, senha };
  const saudacaoFinal = substituirVariaveis(saudacao || 'Olá {nome}!', variaveis);
  const corpoFinal = substituirVariaveis(corpo, variaveis);
  let linkLinha = '';
  if (linkTipo === 'portal') {
    linkLinha = montarLinkPortal(aluno, origin);
  } else if (linkTipo === 'oferta' && linkOfertaUrl) {
    linkLinha = linkOfertaTexto ? `${linkOfertaTexto}: ${linkOfertaUrl}` : linkOfertaUrl;
  }
  const partes = [saudacaoFinal, corpoFinal || ''].filter(Boolean);
  if (linkLinha) partes.push(linkLinha);
  return partes.join('\n\n');
}

// Assume Brasil (55) quando o telefone cadastrado só tem DDD + número
// (formato mais comum aqui). Se já vier com 12+ dígitos, assume que o código
// do país já está incluído e não mexe.
function normalizarTelefoneWhatsapp(telefone) {
  if (!telefone) return null;
  const digitos = String(telefone).replace(/\D/g, '');
  if (!digitos) return null;
  return digitos.length >= 12 ? digitos : `55${digitos}`;
}

// GET /api/recuperacao/status — pro front saber se o e-mail está configurado
// (GMAIL_USER/GMAIL_APP_PASSWORD) antes de deixar escolher o canal "e-mail".
router.get('/status', (req, res) => {
  res.json({ email_configurado: emailService.emailConfigurado() });
});

// GET /api/recuperacao/dias-sem-acesso?busca=&incluir_inativos=&dias_minimo=
// Lista TODOS os alunos (mesmo quem nunca teve nenhum acesso registrado —
// diferente de /api/terminal/acessos/ultimo-por-aluno, que só traz quem já
// acessou pelo menos uma vez) com há quantos dias não aparece, se está em
// atraso e se já tem uma concessão de acesso especial ativa.
router.get('/dias-sem-acesso', async (req, res, next) => {
  try {
    const { busca, incluir_inativos: incluirInativos, dias_minimo: diasMinimoRaw } = req.query;
    const diasMinimo = diasMinimoRaw !== undefined && diasMinimoRaw !== '' ? Number(diasMinimoRaw) : null;

    const condicoes = [];
    const args = [];
    if (!(incluirInativos === 'true' || incluirInativos === '1')) condicoes.push("a.status = 'ativo'");
    if (busca) { condicoes.push('a.nome LIKE ?'); args.push(`%${busca}%`); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const hojeISO = new Date().toISOString().slice(0, 10);

    const result = await db.execute({
      sql: `SELECT a.id as aluno_id, a.nome, a.telefone, a.email, a.status, a.criado_em, a.codigo_acesso,
              (SELECT MAX(ac.criado_em) FROM acessos_catraca ac WHERE ac.aluno_id = a.id AND ac.resultado = 'liberado') as ultimo_acesso,
              EXISTS(SELECT 1 FROM cobrancas c WHERE c.aluno_id = a.id AND c.matricula_id IS NOT NULL AND (
                c.status = 'atrasado' OR (c.status = 'pendente' AND c.vencimento IS NOT NULL AND c.vencimento < date('now'))
              )) as em_atraso,
              EXISTS(SELECT 1 FROM matriculas m WHERE m.aluno_id = a.id AND m.status = 'ativa' AND (m.data_fim IS NULL OR m.data_fim >= date('now'))) as matricula_ativa,
              EXISTS(SELECT 1 FROM concessoes_acesso ca WHERE ca.aluno_id = a.id AND ca.valido_ate >= ?) as concessao_ativa
            FROM alunos a
            ${where}`,
      args: [hojeISO, ...args],
    });

    const agoraMs = Date.now();
    const linhas = result.rows
      .map((linha) => {
        const baseParaDias = linha.ultimo_acesso || linha.criado_em;
        const dataBase = baseParaDias ? parseDataHoraFlexivel(baseParaDias) : null;
        const dias = dataBase && !Number.isNaN(dataBase.getTime())
          ? Math.floor((agoraMs - dataBase.getTime()) / 86400000)
          : null;
        return {
          ...linha,
          nunca_acessou: !linha.ultimo_acesso,
          dias_sem_acesso: dias,
        };
      })
      .filter((linha) => diasMinimo === null || (linha.dias_sem_acesso !== null && linha.dias_sem_acesso >= diasMinimo))
      .sort((a, b) => (b.dias_sem_acesso ?? -1) - (a.dias_sem_acesso ?? -1));

    res.json(linhas);
  } catch (err) {
    next(err);
  }
});

// GET /api/recuperacao/aniversariantes?mes=&dia=&incluir_inativos=
// Sem `mes`, usa o mês corrente. Passando `dia` além do mês, filtra pro dia
// exato (usado pro aviso "aniversariantes de hoje").
router.get('/aniversariantes', async (req, res, next) => {
  try {
    const { mes, dia, incluir_inativos: incluirInativos } = req.query;
    const mesNum = mes ? Number(mes) : (new Date().getUTCMonth() + 1);

    const condicoes = ['a.data_nascimento IS NOT NULL', "CAST(strftime('%m', a.data_nascimento) AS INTEGER) = ?"];
    const args = [mesNum];
    if (!(incluirInativos === 'true' || incluirInativos === '1')) condicoes.push("a.status = 'ativo'");
    if (dia) { condicoes.push("CAST(strftime('%d', a.data_nascimento) AS INTEGER) = ?"); args.push(Number(dia)); }
    const where = `WHERE ${condicoes.join(' AND ')}`;

    const result = await db.execute({
      sql: `SELECT a.id as aluno_id, a.nome, a.telefone, a.email, a.data_nascimento, a.status,
              CAST(strftime('%d', a.data_nascimento) AS INTEGER) as dia_aniversario
            FROM alunos a
            ${where}
            ORDER BY dia_aniversario ASC`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------------- Modelos de mensagem ----------------

router.get('/templates', async (req, res, next) => {
  try {
    const result = await db.execute('SELECT * FROM mensagens_templates ORDER BY criado_em DESC');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/templates', async (req, res, next) => {
  try {
    const dados = templateSchema.parse(req.body);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO mensagens_templates (id, nome, saudacao, corpo, link_tipo, link_oferta_url, link_oferta_texto, conceder_dias_gratis, ativo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.nome, dados.saudacao, dados.corpo, dados.link_tipo,
        dados.link_oferta_url || null, dados.link_oferta_texto || null,
        dados.conceder_dias_gratis || null, dados.ativo === false ? 0 : 1],
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

router.put('/templates/:id', async (req, res, next) => {
  try {
    const dados = templateSchema.parse(req.body);
    const result = await db.execute({
      sql: `UPDATE mensagens_templates SET nome=?, saudacao=?, corpo=?, link_tipo=?, link_oferta_url=?, link_oferta_texto=?, conceder_dias_gratis=?, ativo=?
            WHERE id=?`,
      args: [dados.nome, dados.saudacao, dados.corpo, dados.link_tipo,
        dados.link_oferta_url || null, dados.link_oferta_texto || null,
        dados.conceder_dias_gratis || null, dados.ativo === false ? 0 : 1, req.params.id],
    });
    if (result.rowsAffected === 0) return res.status(404).json({ erro: 'Modelo não encontrado.' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.delete('/templates/:id', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM mensagens_templates WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- Envio (e-mail real via SMTP | link do WhatsApp manual) ----------------

// POST /api/recuperacao/enviar
// Envia (e-mail) ou gera o link (WhatsApp) para um ou vários alunos de uma
// vez. Se `conceder_dias_gratis` vier preenchido (direto no corpo ou herdado
// do modelo escolhido), cria também uma concessão de acesso especial POR
// ALUNO — só depois que o envio/geração de link daquele aluno específico deu
// certo (nunca concede acesso se o e-mail falhou pra alguém no meio do lote).
router.post('/enviar', async (req, res, next) => {
  try {
    const dados = enviarSchema.parse(req.body);

    let template = null;
    if (dados.template_id) {
      const r = await db.execute({ sql: 'SELECT * FROM mensagens_templates WHERE id = ?', args: [dados.template_id] });
      template = r.rows[0] || null;
    }

    const saudacao = dados.saudacao ?? template?.saudacao ?? 'Olá {nome}!';
    const corpo = dados.corpo ?? template?.corpo;
    if (!corpo) return res.status(400).json({ erro: 'Informe o corpo da mensagem ou escolha um modelo com corpo preenchido.' });

    const linkTipo = dados.link_tipo ?? template?.link_tipo ?? 'portal';
    const linkOfertaUrl = dados.link_oferta_url ?? template?.link_oferta_url ?? null;
    const linkOfertaTexto = dados.link_oferta_texto ?? template?.link_oferta_texto ?? null;
    const concederDias = dados.conceder_dias_gratis ?? template?.conceder_dias_gratis ?? null;
    const assunto = dados.assunto || 'Sentimos sua falta na Academia Superação!';

    if (dados.canal === 'email' && !emailService.emailConfigurado()) {
      return res.status(400).json({ erro: 'Envio de e-mail não configurado no servidor. Defina GMAIL_USER e GMAIL_APP_PASSWORD (ver .env.example) e reinicie/faça o redeploy.' });
    }

    const origin = obterOrigin(req);
    const hojeISO = new Date().toISOString().slice(0, 10);
    const resultados = [];
    const concessoesCriadas = [];
    const precisaSenha = usaVariavelSenha(saudacao, corpo);

    for (const alunoId of dados.aluno_ids) {
      // eslint-disable-next-line no-await-in-loop
      const r = await db.execute({ sql: 'SELECT * FROM alunos WHERE id = ?', args: [alunoId] });
      const aluno = r.rows[0];
      if (!aluno) { resultados.push({ aluno_id: alunoId, ok: false, erro: 'Aluno não encontrado.' }); continue; }

      // Só busca/gera a senha de acesso (código sequencial, ver
      // acessoTerminal.atribuirCodigoAluno) quando o modelo realmente usa
      // {senha} — evita gerar/gravar código pra quem nunca vai ver essa info.
      // eslint-disable-next-line no-await-in-loop
      const senha = precisaSenha ? await acessoTerminal.atribuirCodigoAluno(aluno.id) : null;

      const mensagem = montarMensagem({
        aluno, saudacao, corpo, linkTipo, linkOfertaUrl, linkOfertaTexto, origin, senha,
      });
      let envioOk = false;

      if (dados.canal === 'email') {
        if (!aluno.email) {
          resultados.push({
            aluno_id: alunoId, nome: aluno.nome, ok: false, erro: 'Aluno sem e-mail cadastrado.',
          });
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await emailService.enviarEmail({ para: aluno.email, assunto, texto: mensagem });
          envioOk = true;
          // eslint-disable-next-line no-await-in-loop
          await db.execute({
            sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, template_id, assunto, mensagem, destino, status, criado_por)
                  VALUES (?, ?, 'email', ?, ?, ?, ?, 'enviado', ?)`,
            args: [uuid(), alunoId, dados.template_id || null, assunto, mensagem, aluno.email, req.usuario.id],
          });
          resultados.push({
            aluno_id: alunoId, nome: aluno.nome, ok: true, canal: 'email', destino: aluno.email,
          });
        } catch (err) {
          // eslint-disable-next-line no-await-in-loop
          await db.execute({
            sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, template_id, assunto, mensagem, destino, status, erro, criado_por)
                  VALUES (?, ?, 'email', ?, ?, ?, ?, 'erro', ?, ?)`,
            args: [uuid(), alunoId, dados.template_id || null, assunto, mensagem, aluno.email, err.message, req.usuario.id],
          });
          resultados.push({
            aluno_id: alunoId, nome: aluno.nome, ok: false, erro: err.message,
          });
        }
      } else {
        const telefone = normalizarTelefoneWhatsapp(aluno.telefone);
        if (!telefone) {
          resultados.push({
            aluno_id: alunoId, nome: aluno.nome, ok: false, erro: 'Aluno sem telefone cadastrado.',
          });
          continue;
        }
        const link = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;
        envioOk = true;
        // eslint-disable-next-line no-await-in-loop
        await db.execute({
          sql: `INSERT INTO mensagens_enviadas (id, aluno_id, canal, template_id, mensagem, destino, status, criado_por)
                VALUES (?, ?, 'whatsapp', ?, ?, ?, 'link_gerado', ?)`,
          args: [uuid(), alunoId, dados.template_id || null, mensagem, aluno.telefone, req.usuario.id],
        });
        resultados.push({
          aluno_id: alunoId, nome: aluno.nome, ok: true, canal: 'whatsapp', link,
        });
      }

      if (envioOk && concederDias) {
        const validoAte = new Date(Date.now() + (concederDias - 1) * 86400000).toISOString().slice(0, 10);
        const concessaoId = uuid();
        // eslint-disable-next-line no-await-in-loop
        await db.execute({
          sql: `INSERT INTO concessoes_acesso (id, aluno_id, dias, valido_de, valido_ate, motivo, criado_por)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [concessaoId, alunoId, concederDias, hojeISO, validoAte,
            `Concedido junto com mensagem de recuperação (${dados.canal})`, req.usuario.id],
        });
        concessoesCriadas.push({ aluno_id: alunoId, dias: concederDias, valido_ate: validoAte });
        // Best-effort: atualiza o cache do agente local da catraca na hora,
        // sem esperar o próximo pull periódico (ver notificarAgenteAtualizacaoAluno).
        acessoTerminal.notificarAgenteAtualizacaoAluno(alunoId).catch(() => {});
      }
    }

    res.json({ resultados, concessoes_criadas: concessoesCriadas });
  } catch (err) {
    next(err);
  }
});

// ---------------- Concessão de acesso especial (avulsa, sem enviar mensagem) ----------------

router.post('/conceder-acesso', async (req, res, next) => {
  try {
    const dados = concederAcessoSchema.parse(req.body);
    const r = await db.execute({ sql: 'SELECT id, nome FROM alunos WHERE id = ?', args: [dados.aluno_id] });
    const aluno = r.rows[0];
    if (!aluno) return res.status(404).json({ erro: 'Aluno não encontrado.' });

    const hojeISO = new Date().toISOString().slice(0, 10);
    const validoAte = new Date(Date.now() + (dados.dias - 1) * 86400000).toISOString().slice(0, 10);
    const id = uuid();
    await db.execute({
      sql: `INSERT INTO concessoes_acesso (id, aluno_id, dias, valido_de, valido_ate, motivo, criado_por)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, dados.aluno_id, dados.dias, hojeISO, validoAte, dados.motivo || null, req.usuario.id],
    });
    acessoTerminal.notificarAgenteAtualizacaoAluno(dados.aluno_id).catch(() => {});

    return res.status(201).json({
      id, aluno_id: dados.aluno_id, aluno_nome: aluno.nome, dias: dados.dias, valido_de: hojeISO, valido_ate: validoAte,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/concessoes', async (req, res, next) => {
  try {
    const { aluno_id: alunoId } = req.query;
    const condicoes = [];
    const args = [];
    if (alunoId) { condicoes.push('ca.aluno_id = ?'); args.push(alunoId); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const result = await db.execute({
      sql: `SELECT ca.*, a.nome as aluno_nome FROM concessoes_acesso ca
            JOIN alunos a ON a.id = ca.aluno_id
            ${where} ORDER BY ca.criado_em DESC LIMIT 200`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------------- Todos os ativos (2026-07) ----------------
// GET /api/recuperacao/todos-ativos?busca=&categoria=
// Audiência para o envio em massa do convite padrão de boas-vindas/portal —
// pensada pro caso descrito pelo dono do sistema: reenviar o link do Portal
// do Aluno (+ senha) pra quem ainda não fez o cadastro facial, sem precisar ir
// aluno por aluno. Devolve TODOS os cadastros com status='ativo' (inclui
// visitantes de propósito — ver categoria abaixo), pro admin escolher no
// composer da tela (mesmo POST /enviar usado pela recuperação por
// dias-sem-acesso, só que com outro público de origem). Filtro por categoria
// opcional, útil pra excluir visitantes desse envio específico se o admin
// quiser mandar só pra aluno/professor/colaborador/bolsista.
router.get('/todos-ativos', async (req, res, next) => {
  try {
    const { busca, categoria } = req.query;
    const condicoes = ["a.status = 'ativo'"];
    const args = [];
    if (busca) { condicoes.push('a.nome LIKE ?'); args.push(`%${busca}%`); }
    if (categoria) { condicoes.push('a.categoria = ?'); args.push(categoria); }
    const where = `WHERE ${condicoes.join(' AND ')}`;

    const result = await db.execute({
      sql: `SELECT a.id as aluno_id, a.nome, a.email, a.telefone, a.categoria, a.criado_em,
              (a.face_descriptor IS NOT NULL) as tem_rosto_cadastrado
            FROM alunos a
            ${where}
            ORDER BY a.nome ASC`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------------- Relatório de visitantes (2026-07) ----------------
// GET /api/recuperacao/visitantes?busca=&indicado_por_aluno_id=
// Cada visitante (categoria='visitante'), quantos acessos liberados ele já
// usou (contra o limite configurável — ver acessoTerminal.service.js /
// configuracoes.visitante_limite_acessos), e quem indicou (se veio de
// indicação de um aluno). Também entra nesse mecanismo de recuperação pra
// campanha de "vire aluno" (usa o mesmo POST /enviar de sempre).
router.get('/visitantes', async (req, res, next) => {
  try {
    const { busca, indicado_por_aluno_id: indicadoPorAlunoId } = req.query;
    const condicoes = ["a.categoria = 'visitante'"];
    const args = [];
    if (busca) { condicoes.push('a.nome LIKE ?'); args.push(`%${busca}%`); }
    if (indicadoPorAlunoId) { condicoes.push('a.indicado_por_aluno_id = ?'); args.push(indicadoPorAlunoId); }
    const where = `WHERE ${condicoes.join(' AND ')}`;

    const [visitantesResult, limite] = await Promise.all([
      db.execute({
        sql: `SELECT a.id as aluno_id, a.nome, a.telefone, a.email, a.criado_em,
                a.indicado_por_aluno_id, ind.nome as indicado_por_nome,
                (SELECT COUNT(*) FROM acessos_catraca ac WHERE ac.aluno_id = a.id AND ac.resultado = 'liberado') as acessos_usados
              FROM alunos a
              LEFT JOIN alunos ind ON ind.id = a.indicado_por_aluno_id
              ${where}
              ORDER BY a.criado_em DESC`,
        args,
      }),
      acessoTerminal.limiteAcessosVisitanteEm(db),
    ]);

    const visitantes = visitantesResult.rows.map((v) => ({
      ...v,
      limite_acessos: limite,
      limite_atingido: v.acessos_usados >= limite,
    }));

    res.json(visitantes);
  } catch (err) {
    next(err);
  }
});

// GET /api/recuperacao/visitantes/indicadores?mes=
// Ranking "quantos visitantes cada aluno indicou" no mês informado (padrão: o
// mês corrente), pro admin controlar/conferir o limite mensal por aluno
// (configuracoes.indicacao_limite_mensal) sem precisar contar na mão.
router.get('/visitantes/indicadores', async (req, res, next) => {
  try {
    const { mes } = req.query; // formato esperado: 'YYYY-MM' — padrão mês corrente
    const mesFiltro = /^\d{4}-\d{2}$/.test(mes || '') ? mes : new Date().toISOString().slice(0, 7);
    const limiteMensal = await acessoTerminal.limiteIndicacoesMensalEm(db);

    const result = await db.execute({
      sql: `SELECT ind.id as aluno_id, ind.nome as aluno_nome, COUNT(a.id) as indicacoes_no_mes
            FROM alunos a
            JOIN alunos ind ON ind.id = a.indicado_por_aluno_id
            WHERE a.categoria = 'visitante' AND strftime('%Y-%m', a.criado_em) = ?
            GROUP BY ind.id, ind.nome
            ORDER BY indicacoes_no_mes DESC`,
      args: [mesFiltro],
    });

    const linhas = result.rows.map((linha) => ({
      ...linha,
      limite_mensal: limiteMensal,
      limite_atingido: linha.indicacoes_no_mes >= limiteMensal,
    }));

    res.json({ mes: mesFiltro, limite_mensal: limiteMensal, indicadores: linhas });
  } catch (err) {
    next(err);
  }
});

// ---------------- Histórico de mensagens enviadas ----------------

router.get('/historico', async (req, res, next) => {
  try {
    const { aluno_id: alunoId, canal } = req.query;
    const condicoes = [];
    const args = [];
    if (alunoId) { condicoes.push('m.aluno_id = ?'); args.push(alunoId); }
    if (canal) { condicoes.push('m.canal = ?'); args.push(canal); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const result = await db.execute({
      sql: `SELECT m.*, a.nome as aluno_nome FROM mensagens_enviadas m
            JOIN alunos a ON a.id = m.aluno_id
            ${where} ORDER BY m.criado_em DESC LIMIT 300`,
      args,
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
