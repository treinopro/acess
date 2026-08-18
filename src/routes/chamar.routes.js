/**
 * "Chamar instrutor" via tag NFC colada em cada aparelho (2026-08). O aluno
 * encosta o celular na tag, o navegador abre esta URL sozinho (nenhum app
 * precisa estar instalado — é o comportamento padrão de uma tag NFC gravada
 * com uma URL, tanto Android quanto iPhone reconhecem), e este endpoint
 * dispara o aviso pro instrutor via Telegram (ver
 * services/notificarInstrutor.service.js) e devolve uma página de
 * confirmação simples pro aluno.
 *
 * Rota pública de propósito, sem TERMINAL_TOKEN nem login — mesmo padrão já
 * usado em GET /api/terminal/meu-acesso/:codigo: a posse física da tag (só
 * quem está na academia, encostado no aparelho, consegue tocá-la) já é a
 * prova, não tem dado sensível de aluno envolvido aqui.
 *
 * Fica FORA do prefixo /api de propósito — é o link exato que vai gravado em
 * cada tag NFC, mais curto de digitar/gravar sem o /api no meio.
 */

const express = require('express');
const equipamentos = require('../config/equipamentos');
const notificarInstrutor = require('../services/notificarInstrutor.service');
const { criarLimitador } = require('../middleware/rateLimit');

const router = express.Router();

// Generoso o bastante pro uso normal (várias pessoas em aparelhos diferentes
// no mesmo minuto), mas trava automação/scripts batendo na rota direto.
const limitador = criarLimitador({
  janelaMs: 60 * 1000,
  maximo: 20,
  mensagem: 'Muitos chamados seguidos. Aguarde um instante.',
});

function paginaResposta({ titulo, mensagem, cor }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f172a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;padding:20px}
  .caixa{background:#1e293b;border-radius:16px;padding:32px 28px;max-width:380px;text-align:center;
    border-top:4px solid ${cor}}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#cbd5e1;font-size:15px;line-height:1.6;margin:0}
</style></head><body>
  <div class="caixa">
    <h1>${titulo}</h1>
    <p>${mensagem}</p>
  </div>
</body></html>`;
}

// GET /chamar/:equipamentoId
router.get('/chamar/:equipamentoId', limitador, async (req, res) => {
  const { equipamentoId } = req.params;
  const nome = equipamentos[equipamentoId];

  if (!nome) {
    return res.status(404).send(paginaResposta({
      titulo: 'Aparelho não encontrado',
      mensagem: 'Esta tag não está cadastrada no sistema. Procure a recepção, por favor.',
      cor: '#ef4444',
    }));
  }

  try {
    const resultado = await notificarInstrutor.enviarChamado({ equipamentoId, equipamentoNome: nome });

    if (!resultado.enviado && resultado.motivo === 'cooldown') {
      return res.send(paginaResposta({
        titulo: 'Instrutor já a caminho',
        mensagem: `Alguém já chamou o instrutor para o <strong>${nome}</strong> há pouco. Ele já está vindo!`,
        cor: '#f59e0b',
      }));
    }

    res.send(paginaResposta({
      titulo: 'Instrutor chamado! 🔔',
      mensagem: `Aguarde um instante, o instrutor foi avisado sobre o <strong>${nome}</strong>.`,
      cor: '#10b981',
    }));
  } catch (err) {
    console.error(`[chamar-instrutor] erro ao notificar (equipamento=${equipamentoId}):`, err.message);
    res.status(500).send(paginaResposta({
      titulo: 'Não consegui chamar',
      mensagem: 'Peça ajuda diretamente à recepção, por favor.',
      cor: '#ef4444',
    }));
  }
});

module.exports = router;
