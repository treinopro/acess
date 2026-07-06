// Totem/terminal de auto atendimento — identificação de alunos já cadastrados
// (CPF, QR pessoal do celular, reconhecimento facial contínuo) e vinculação
// inicial de método de acesso para quem já existia no sistema antes do totem.
//
// IMPORTANTE: troque o valor abaixo pelo mesmo TERMINAL_TOKEN configurado no
// .env do servidor. Como o aluno não faz login, este token é o que autentica
// o totem perante a API — mantenha o dispositivo fisicamente controlado.
const TERMINAL_TOKEN = 'w7bN3qXeR9mKpL2vJ8tYd5cA6sZ0hU4gF1oQnE7iBxW';

// URL dos modelos do face-api.js — hospedados localmente em public/vendor/,
// já que o totem roda numa rede sem internet. Ver README (seção do totem)
// para o comando que baixa esses arquivos uma vez, num PC com internet.
const FACE_MODELS_URL = 'vendor/face-api/weights';

// Quanto tempo (ms) a tela de resultado fica visível antes de voltar sozinha
// a escanear. Curto o suficiente para não travar a fila, longo o bastante
// pra pessoa ler a mensagem.
const DURACAO_RESULTADO_MS = 3000;

// Intervalo (ms) entre tentativas de detecção no loop contínuo da tela inicial.
const INTERVALO_ESCANEAMENTO_MS = 600;

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

// ---------------- Câmera (compartilhada entre todas as telas) ----------------

let streamAtual = null;

async function iniciarCamera(videoEl) {
  pararCamera();
  streamAtual = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  videoEl.srcObject = streamAtual;
  await videoEl.play();
}

function pararCamera() {
  if (streamAtual) {
    streamAtual.getTracks().forEach((t) => t.stop());
    streamAtual = null;
  }
}

// ---------------- Modelos de reconhecimento facial ----------------

let modelosFaciaisCarregados = false;
let modelosFaciaisCarregando = null;

async function carregarModelosFaciais() {
  if (modelosFaciaisCarregados) return;
  if (modelosFaciaisCarregando) return modelosFaciaisCarregando;
  modelosFaciaisCarregando = (async () => {
    await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
    modelosFaciaisCarregados = true;
  })();
  return modelosFaciaisCarregando;
}

async function detectarRosto(video) {
  return faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
}

// ---------------- Tela inicial: escaneamento contínuo (rosto + QR) ----------------

let escaneamentoAtivo = false;
let escaneamentoTimer = null;
const canvasEscaneamento = document.createElement('canvas');
const ctxEscaneamento = canvasEscaneamento.getContext('2d');

async function iniciarEscaneamentoContinuo() {
  const video = document.getElementById('video-inicio');
  const statusEl = document.getElementById('status-inicio');

  escaneamentoAtivo = true;
  statusEl.textContent = 'Carregando reconhecimento facial...';

  try {
    await iniciarCamera(video);
    await carregarModelosFaciais();
  } catch (err) {
    statusEl.textContent = `Não foi possível preparar a câmera: ${err.message}`;
    return;
  }

  if (!escaneamentoAtivo) return; // usuário já navegou pra outra tela enquanto carregava
  statusEl.textContent = 'Aproxime-se para reconhecimento facial, ou mostre o QR do seu celular...';
  agendarProximoTick();
}

function pararEscaneamentoContinuo() {
  escaneamentoAtivo = false;
  if (escaneamentoTimer) {
    clearTimeout(escaneamentoTimer);
    escaneamentoTimer = null;
  }
  pararCamera();
}

function agendarProximoTick() {
  if (!escaneamentoAtivo) return;
  escaneamentoTimer = setTimeout(tickEscaneamento, INTERVALO_ESCANEAMENTO_MS);
}

async function tickEscaneamento() {
  if (!escaneamentoAtivo) return;
  const video = document.getElementById('video-inicio');

  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    agendarProximoTick();
    return;
  }

  // 1) tenta achar um QR code no quadro atual (celular do aluno)
  canvasEscaneamento.width = video.videoWidth;
  canvasEscaneamento.height = video.videoHeight;
  ctxEscaneamento.drawImage(video, 0, 0, canvasEscaneamento.width, canvasEscaneamento.height);
  const imageData = ctxEscaneamento.getImageData(0, 0, canvasEscaneamento.width, canvasEscaneamento.height);
  const qr = window.jsQR(imageData.data, canvasEscaneamento.width, canvasEscaneamento.height);

  if (qr && qr.data) {
    processarResultadoInicio(() => api('/api/terminal/acesso/codigo', {
      method: 'POST',
      body: JSON.stringify({ codigo_acesso: qr.data }),
    }));
    return;
  }

  // 2) senão, tenta reconhecimento facial no mesmo quadro
  let deteccao = null;
  try {
    deteccao = await detectarRosto(video);
  } catch {
    // ignora erros pontuais de detecção (ex.: frame instável) e segue tentando
  }

  if (!escaneamentoAtivo) return; // pode ter navegado durante o await

  if (deteccao) {
    const descriptor = Array.from(deteccao.descriptor);
    processarResultadoInicio(() => api('/api/terminal/acesso/facial', {
      method: 'POST',
      body: JSON.stringify({ descriptor }),
    }));
    return;
  }

  agendarProximoTick();
}

// Variante de processarResultado usada pela tela inicial: ao terminar de
// mostrar o resultado, retoma o escaneamento contínuo automaticamente (em vez
// de esperar alguém clicar) — assim, se chegar outra pessoa na sequência, o
// totem já está tentando reconhecer ela.
async function processarResultadoInicio(chamada) {
  pararEscaneamentoContinuo();
  await processarResultado(chamada, { aoVoltar: () => iniciarEscaneamentoContinuo() });
}

// ---------------- Navegação entre telas ----------------

document.getElementById('btn-ir-vincular').addEventListener('click', () => {
  pararEscaneamentoContinuo();
  resetVincular();
  mostrarTela('tela-vincular');
});

document.getElementById('btn-ir-cadastro').addEventListener('click', () => {
  pararEscaneamentoContinuo();
  resetCadastro();
  mostrarTela('tela-cadastro');
});

document.getElementById('btn-voltar-2').addEventListener('click', () => {
  pararCamera();
  mostrarTela('tela-inicio');
  iniciarEscaneamentoContinuo();
});

document.getElementById('btn-voltar-3').addEventListener('click', () => {
  pararPollCadastro();
  pararCamera();
  mostrarTela('tela-inicio');
  iniciarEscaneamentoContinuo();
});

// ---------------- Resultado (tela final, com auto-retorno) ----------------

async function processarResultado(chamada, { aoVoltar } = {}) {
  pararCamera();
  mostrarTela('tela-resultado');
  const tela = document.getElementById('tela-resultado');
  tela.classList.remove('liberado', 'negado');
  document.getElementById('resultado-icone').textContent = '⏳';
  document.getElementById('resultado-titulo').textContent = 'Verificando...';
  document.getElementById('resultado-msg').textContent = '';

  try {
    const r = await chamada();
    if (r.autorizado) {
      tela.classList.add('liberado');
      document.getElementById('resultado-icone').textContent = '✅';
      document.getElementById('resultado-titulo').textContent = `Bem-vindo(a), ${r.aluno_nome || ''}!`;
      document.getElementById('resultado-msg').textContent = 'Acesso liberado. Pode entrar.';
    } else {
      tela.classList.add('negado');
      document.getElementById('resultado-icone').textContent = '⛔';
      document.getElementById('resultado-titulo').textContent = 'Acesso negado';
      document.getElementById('resultado-msg').textContent = r.motivo || 'Procure a recepção.';
    }
  } catch (err) {
    tela.classList.add('negado');
    document.getElementById('resultado-icone').textContent = '⚠️';
    document.getElementById('resultado-titulo').textContent = 'Não foi possível verificar';
    document.getElementById('resultado-msg').textContent = err.message;
  }

  setTimeout(() => {
    document.getElementById('input-cpf').value = '';
    mostrarTela('tela-inicio');
    if (aoVoltar) aoVoltar();
  }, DURACAO_RESULTADO_MS);
}

// ---------------- Identificação por CPF (sempre disponível na tela inicial) ----------------

document.getElementById('btn-confirmar-cpf').addEventListener('click', () => {
  const cpf = document.getElementById('input-cpf').value.trim();
  if (!cpf) return;
  pararEscaneamentoContinuo();
  processarResultado(
    () => api('/api/terminal/acesso/cpf', { method: 'POST', body: JSON.stringify({ cpf }) }),
    { aoVoltar: () => iniciarEscaneamentoContinuo() },
  );
});

// ---------------- Vincular acesso (aluno existente, primeira vez no totem) ----------------

let cpfVincularAtual = null;

function resetVincular() {
  cpfVincularAtual = null;
  document.getElementById('input-cpf-vincular').value = '';
  document.getElementById('painel-vincular-cpf').classList.remove('oculto');
  document.getElementById('painel-vincular-opcoes').classList.add('oculto');
  document.getElementById('painel-vincular-facial').classList.add('oculto');
}

document.getElementById('btn-buscar-vincular').addEventListener('click', async () => {
  const cpf = document.getElementById('input-cpf-vincular').value.trim();
  if (!cpf) return;
  try {
    const resp = await api(`/api/terminal/vincular/codigo?cpf=${encodeURIComponent(cpf)}`);
    cpfVincularAtual = cpf;
    document.getElementById('vincular-saudacao').textContent = `Olá, ${resp.aluno_nome}! Este é o seu QR pessoal:`;
    document.getElementById('painel-vincular-cpf').classList.add('oculto');
    document.getElementById('painel-vincular-opcoes').classList.remove('oculto');
    const alvo = document.getElementById('qrcode-vincular');
    alvo.innerHTML = '';
    // eslint-disable-next-line no-new
    new QRCode(alvo, { text: resp.codigo_acesso, width: 200, height: 200, colorDark: '#0f172a', colorLight: '#ffffff' });
  } catch (err) {
    document.getElementById('vincular-saudacao').textContent = '';
    alert(err.message);
  }
});

// Lógica de cadastro facial compartilhada entre "vincular" (aluno já existia)
// e o passo final do auto cadastro novo — ambos só diferem no CPF usado e no
// que fazer ao concluir.
async function iniciarCadastroFacial({ video, statusEl, cpf, aoConcluir }) {
  try {
    statusEl.textContent = 'Carregando...';
    await carregarModelosFaciais();
    await iniciarCamera(video);
    statusEl.textContent = 'Posicione seu rosto no centro da câmera...';
  } catch (err) {
    statusEl.textContent = `Erro: ${err.message}`;
    return;
  }

  const tick = async () => {
    const deteccao = await detectarRosto(video);
    if (deteccao) {
      pararCamera();
      try {
        await api('/api/terminal/vincular/facial', {
          method: 'POST',
          body: JSON.stringify({ cpf, descriptor: Array.from(deteccao.descriptor) }),
        });
        statusEl.textContent = 'Rosto cadastrado com sucesso!';
        setTimeout(() => { if (aoConcluir) aoConcluir(); }, 3000);
      } catch (err2) {
        statusEl.textContent = `Erro ao cadastrar: ${err2.message}`;
      }
      return;
    }
    setTimeout(tick, 400);
  };
  tick();
}

document.getElementById('btn-cadastrar-facial-vincular').addEventListener('click', async () => {
  document.getElementById('painel-vincular-opcoes').classList.add('oculto');
  document.getElementById('painel-vincular-facial').classList.remove('oculto');
  await iniciarCadastroFacial({
    video: document.getElementById('video-vincular-facial'),
    statusEl: document.getElementById('status-vincular-facial'),
    cpf: cpfVincularAtual,
    aoConcluir: () => { mostrarTela('tela-inicio'); iniciarEscaneamentoContinuo(); },
  });
});

// ---------------- Auto cadastro (aluno novo): dados+plano -> pagamento -> sucesso ----------------

let cadastroPollTimer = null;
let cadastroCpfAtual = null;

function formatarMoedaCadastro(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function resetCadastro() {
  pararPollCadastro();
  cadastroCpfAtual = null;
  document.getElementById('cadastro-nome').value = '';
  document.getElementById('cadastro-cpf').value = '';
  document.getElementById('cadastro-telefone').value = '';
  document.getElementById('cadastro-form-erro').textContent = '';
  document.getElementById('painel-cadastro-form').classList.remove('oculto');
  document.getElementById('painel-cadastro-pagamento').classList.add('oculto');
  document.getElementById('painel-cadastro-sucesso').classList.add('oculto');
  document.getElementById('painel-cadastro-facial').classList.add('oculto');
  document.getElementById('btn-copiar-pix').classList.add('oculto');
  carregarPlanosCadastro();
}

async function carregarPlanosCadastro() {
  const select = document.getElementById('cadastro-plano');
  select.innerHTML = '<option value="">Carregando planos...</option>';
  try {
    const planos = await api('/api/terminal/planos');
    select.innerHTML = planos.length
      ? planos.map((p) => `<option value="${p.id}">${p.nome} — ${formatarMoedaCadastro(p.valor_centavos)}</option>`).join('')
      : '<option value="">Nenhum plano disponível</option>';
  } catch (err) {
    select.innerHTML = '<option value="">Não foi possível carregar os planos</option>';
  }
}

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

  try {
    const resp = await api('/api/terminal/auto-cadastro', {
      method: 'POST',
      body: JSON.stringify({ nome, cpf, telefone: telefone || null, plano_id: planoId }),
    });
    cadastroCpfAtual = cpf;
    document.getElementById('painel-cadastro-form').classList.add('oculto');
    document.getElementById('painel-cadastro-pagamento').classList.remove('oculto');
    document.getElementById('cadastro-pagamento-valor').textContent = `Valor: ${formatarMoedaCadastro(resp.valor_centavos)}`;
    document.getElementById('cadastro-status-pagamento').textContent = 'Aguardando pagamento...';

    const alvo = document.getElementById('qrcode-cadastro-pagamento');
    alvo.innerHTML = '';
    const btnCopiarPix = document.getElementById('btn-copiar-pix');
    const instrucaoEl = document.getElementById('cadastro-pagamento-instrucao');

    if (resp.qr_code_pix_imagem) {
      // Mercado Pago: Pix direto — o QR já vem pronto (imagem), sem redirecionar
      // pra nenhuma tela externa. Mostra também o código copia-e-cola.
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${resp.qr_code_pix_imagem}`;
      img.style.width = '220px';
      img.style.height = '220px';
      img.style.borderRadius = '12px';
      alvo.appendChild(img);
      instrucaoEl.textContent = 'Escaneie o QR com o app do seu banco (Pix) para pagar. A tela avança sozinha assim que o pagamento for confirmado.';

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
      } else {
        btnCopiarPix.classList.add('oculto');
      }
    } else if (resp.qr_code_pix) {
      // Mercado Pago: a API não devolveu a imagem pronta (comum em modo de
      // teste), mas devolveu o código Pix (copia-e-cola) em texto — geramos
      // o QR no próprio totem a partir desse texto. É um QR Pix de verdade
      // (não aponta pra link nenhum), então o app do banco lê normalmente.
      // eslint-disable-next-line no-new
      new QRCode(alvo, { text: resp.qr_code_pix, width: 220, height: 220, colorDark: '#0f172a', colorLight: '#ffffff' });
      instrucaoEl.textContent = 'Escaneie o QR com o app do seu banco (Pix) para pagar. A tela avança sozinha assim que o pagamento for confirmado.';

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
    } else {
      // InfinitePay: link de checkout — o QR aponta pra URL, o aluno escaneia
      // com a câmera normal do celular (não é um QR Pix em si).
      // eslint-disable-next-line no-new
      new QRCode(alvo, { text: resp.link_pagamento, width: 220, height: 220, colorDark: '#0f172a', colorLight: '#ffffff' });
      instrucaoEl.textContent = 'Escaneie com a câmera do seu celular para pagar. A tela avança sozinha assim que o pagamento for confirmado.';
      btnCopiarPix.classList.add('oculto');
    }

    iniciarPollCadastro(resp.cobranca_id);
  } catch (err) {
    erroEl.textContent = err.message;
  }
});

function iniciarPollCadastro(cobrancaId) {
  pararPollCadastro();
  const statusEl = document.getElementById('cadastro-status-pagamento');
  cadastroPollTimer = setInterval(async () => {
    try {
      const resp = await api(`/api/terminal/auto-cadastro/status/${cobrancaId}`);
      if (resp.pago) {
        pararPollCadastro();
        mostrarSucessoCadastro(resp);
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

function mostrarSucessoCadastro(resp) {
  document.getElementById('painel-cadastro-pagamento').classList.add('oculto');
  document.getElementById('painel-cadastro-sucesso').classList.remove('oculto');
  document.getElementById('cadastro-sucesso-saudacao').textContent = resp.autorizado
    ? `Pagamento confirmado! Bem-vindo(a), ${resp.aluno_nome || ''}. Sua entrada já foi liberada.`
    : `Pagamento confirmado, mas houve um problema ao liberar a catraca: ${resp.motivo || ''}. Procure a recepção.`;

  const alvo = document.getElementById('qrcode-cadastro-sucesso');
  alvo.innerHTML = '';
  // eslint-disable-next-line no-new
  new QRCode(alvo, { text: resp.codigo_acesso, width: 200, height: 200, colorDark: '#0f172a', colorLight: '#ffffff' });
}

document.getElementById('btn-cadastro-facial').addEventListener('click', async () => {
  document.getElementById('painel-cadastro-sucesso').classList.add('oculto');
  document.getElementById('painel-cadastro-facial').classList.remove('oculto');
  await iniciarCadastroFacial({
    video: document.getElementById('video-cadastro-facial'),
    statusEl: document.getElementById('status-cadastro-facial'),
    cpf: cadastroCpfAtual,
    aoConcluir: () => { mostrarTela('tela-inicio'); iniciarEscaneamentoContinuo(); },
  });
});

document.getElementById('btn-cadastro-concluir').addEventListener('click', () => {
  mostrarTela('tela-inicio');
  iniciarEscaneamentoContinuo();
});

// ---------------- Inicialização ----------------

iniciarEscaneamentoContinuo();
