// Cadastro remoto pelo celular do próprio aluno — aberto ao escanear o QR
// "Usar seu cel" na tela inicial do totem (ver terminal.html/terminal.js).
// Roda o MESMO fluxo de auto-cadastro do totem (POST /api/terminal/auto-cadastro
// + polling de status), só que direto no navegador do celular: o aluno
// preenche os dados e paga sem precisar ocupar o totem físico. Quando o
// pagamento é confirmado, a matrícula já é ativada e a entrada liberada —
// a tela final mostra o QR pessoal pra usar na catraca a partir de agora.
//
// IMPORTANTE: mesmo TERMINAL_TOKEN do totem (troque junto com o valor em
// public/terminal.js e no .env do servidor — ver README, seção do totem).
// Esse token já é público em terminal.js hoje (visível a quem inspeciona o
// código do totem), então reaproveitá-lo aqui não é uma regressão de
// segurança nova.
const TERMINAL_TOKEN = 'w7bN3qXeR9mKpL2vJ8tYd5cA6sZ0hU4gF1oQnE7iBxW';

const FACE_MODELS_URL = 'vendor/face-api/weights';

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    ...opcoes,
    headers: {
      'Content-Type': 'application/json',
      'X-Terminal-Token': TERMINAL_TOKEN,
      ...(opcoes.headers || {}),
    },
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || dados.motivo || 'Erro na requisição.');
  return dados;
}

function mostrarTela(id) {
  document.querySelectorAll('.tela').forEach((t) => t.classList.remove('ativa'));
  document.getElementById(id).classList.add('ativa');
}

function formatarMoeda(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ---------------- Passo 1: formulário ----------------

async function carregarPlanos() {
  const select = document.getElementById('cadastro-plano');
  select.innerHTML = '<option value="">Carregando planos...</option>';
  try {
    const planos = await api('/api/terminal/planos');
    select.innerHTML = planos.length
      ? planos.map((p) => `<option value="${p.id}">${p.nome} — ${formatarMoeda(p.valor_centavos)}</option>`).join('')
      : '<option value="">Nenhum plano disponível</option>';
  } catch (err) {
    select.innerHTML = '<option value="">Não foi possível carregar os planos</option>';
  }
}

let cadastroCpfAtual = null;

document.getElementById('btn-cadastro-continuar').addEventListener('click', async () => {
  const nome = document.getElementById('cadastro-nome').value.trim();
  const cpf = document.getElementById('cadastro-cpf').value.trim();
  const telefone = document.getElementById('cadastro-telefone').value.trim();
  const planoId = document.getElementById('cadastro-plano').value;
  const erroEl = document.getElementById('cadastro-form-erro');
  erroEl.textContent = '';

  if (!nome || !cpf || !planoId) {
    erroEl.textContent = 'Preencha nome, CPF e escolha um plano.';
    return;
  }

  const botao = document.getElementById('btn-cadastro-continuar');
  botao.disabled = true;
  try {
    const resp = await api('/api/terminal/auto-cadastro', {
      method: 'POST',
      body: JSON.stringify({ nome, cpf, telefone: telefone || null, plano_id: planoId }),
    });
    cadastroCpfAtual = cpf;
    mostrarPagamento(resp);
  } catch (err) {
    erroEl.textContent = err.message;
  } finally {
    botao.disabled = false;
  }
});

// ---------------- Passo 2: pagamento ----------------

let cadastroPollTimer = null;

function mostrarPagamento(resp) {
  mostrarTela('tela-pagamento');
  document.getElementById('cadastro-pagamento-valor').textContent = `Valor: ${formatarMoeda(resp.valor_centavos)}`;
  document.getElementById('cadastro-status-pagamento').textContent = 'Aguardando pagamento...';

  const alvo = document.getElementById('qrcode-cadastro-pagamento');
  alvo.innerHTML = '';
  const btnCopiarPix = document.getElementById('btn-copiar-pix');
  const btnAbrirPagamento = document.getElementById('btn-abrir-pagamento');
  const instrucaoEl = document.getElementById('cadastro-pagamento-instrucao');
  btnCopiarPix.classList.add('oculto');
  btnAbrirPagamento.classList.add('oculto');
  btnAbrirPagamento.onclick = null;

  if (resp.qr_code_pix_imagem || resp.qr_code_pix) {
    // Mercado Pago (Pix): num celular não dá pra "escanear a própria tela", então
    // o jeito prático é copiar o código e colar no app do banco — por isso o
    // botão "Copiar código Pix" é a ação principal aqui. O QR fica de apoio
    // (útil se quem for pagar for outra pessoa, com outro celular).
    if (resp.qr_code_pix_imagem) {
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${resp.qr_code_pix_imagem}`;
      img.style.width = '200px';
      img.style.height = '200px';
      img.style.borderRadius = '12px';
      alvo.appendChild(img);
    } else {
      // eslint-disable-next-line no-new
      new QRCode(alvo, { text: resp.qr_code_pix, width: 200, height: 200, colorDark: '#0f172a', colorLight: '#ffffff' });
    }
    instrucaoEl.textContent = 'Copie o código Pix abaixo e cole no app do seu banco para pagar. A tela avança sozinha assim que o pagamento for confirmado.';

    if (resp.qr_code_pix) {
      btnCopiarPix.classList.remove('oculto');
      btnCopiarPix.onclick = async () => {
        try {
          await navigator.clipboard.writeText(resp.qr_code_pix);
          btnCopiarPix.textContent = 'Código copiado!';
          setTimeout(() => { btnCopiarPix.textContent = 'Copiar código Pix'; }, 2000);
        } catch {
          alert('Não foi possível copiar automaticamente. Código Pix:\n' + resp.qr_code_pix);
        }
      };
    }
  } else if (resp.link_pagamento) {
    // InfinitePay: já estamos no celular, então em vez de gerar um QR pra uma
    // URL (que exigiria outra câmera pra ler), abrimos o link de pagamento
    // direto num botão — é a mesma tela de checkout que o totem mostraria via QR.
    instrucaoEl.textContent = 'Toque no botão abaixo para pagar. A tela avança sozinha assim que o pagamento for confirmado.';
    btnAbrirPagamento.classList.remove('oculto');
    btnAbrirPagamento.onclick = () => window.open(resp.link_pagamento, '_blank');
  }

  iniciarPollCadastro(resp.cobranca_id);
}

function iniciarPollCadastro(cobrancaId) {
  pararPollCadastro();
  const statusEl = document.getElementById('cadastro-status-pagamento');
  cadastroPollTimer = setInterval(async () => {
    try {
      const resp = await api(`/api/terminal/auto-cadastro/status/${cobrancaId}`);
      if (resp.pago) {
        pararPollCadastro();
        mostrarSucesso(resp);
      }
    } catch (err) {
      statusEl.textContent = `Erro ao consultar pagamento: ${err.message}`;
    }
  }, 4000);
}

function pararPollCadastro() {
  if (cadastroPollTimer) {
    clearInterval(cadastroPollTimer);
    cadastroPollTimer = null;
  }
}

// ---------------- Passo 3: sucesso ----------------

function mostrarSucesso(resp) {
  mostrarTela('tela-sucesso');
  document.getElementById('cadastro-sucesso-saudacao').textContent = resp.autorizado
    ? `Pagamento confirmado! Bem-vindo(a), ${resp.aluno_nome || ''}. Sua entrada já foi liberada.`
    : `Pagamento confirmado, mas houve um problema ao liberar a catraca: ${resp.motivo || ''}. Procure a recepção.`;

  const alvo = document.getElementById('qrcode-cadastro-sucesso');
  alvo.innerHTML = '';
  // eslint-disable-next-line no-new
  new QRCode(alvo, { text: resp.codigo_acesso, width: 200, height: 200, colorDark: '#0f172a', colorLight: '#ffffff' });
}

// ---------------- Passo opcional: reconhecimento facial pelo celular ----------------

let streamAtual = null;
let modelosFaciaisCarregados = false;

async function carregarModelosFaciais() {
  if (modelosFaciaisCarregados) return;
  await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
  modelosFaciaisCarregados = true;
}

document.getElementById('btn-cadastro-facial').addEventListener('click', async () => {
  mostrarTela('tela-facial');
  const video = document.getElementById('video-cadastro-facial');
  const statusEl = document.getElementById('status-cadastro-facial');

  try {
    statusEl.textContent = 'Carregando...';
    await carregarModelosFaciais();
    streamAtual = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    video.srcObject = streamAtual;
    await video.play();
    statusEl.textContent = 'Posicione seu rosto no centro da câmera...';
  } catch (err) {
    statusEl.textContent = `Erro: ${err.message}`;
    return;
  }

  const tick = async () => {
    const deteccao = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (deteccao) {
      streamAtual.getTracks().forEach((t) => t.stop());
      try {
        await api('/api/terminal/vincular/facial', {
          method: 'POST',
          body: JSON.stringify({ cpf: cadastroCpfAtual, descriptor: Array.from(deteccao.descriptor) }),
        });
        statusEl.textContent = 'Rosto cadastrado com sucesso! Pode fechar esta página e ir até a catraca.';
      } catch (err2) {
        statusEl.textContent = `Erro ao cadastrar: ${err2.message}`;
      }
      return;
    }
    setTimeout(tick, 400);
  };
  tick();
});

// ---------------- Inicialização ----------------

carregarPlanos();
