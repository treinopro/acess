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

// Só pausa o LOOP de detecção (QR/rosto) — a câmera continua ligada e visível.
// Usada durante o overlay de resultado (liberado/negado), que fica por cima
// do próprio vídeo em vez de trocar de tela.
function pausarDeteccaoContinua() {
  escaneamentoAtivo = false;
  if (escaneamentoTimer) {
    clearTimeout(escaneamentoTimer);
    escaneamentoTimer = null;
  }
}

// Retoma o loop sem reiniciar a câmera (ela nunca foi parada).
function retomarDeteccaoContinua() {
  escaneamentoAtivo = true;
  agendarProximoTick();
}

// Parada completa (câmera + loop) — usada só ao navegar de verdade para outra
// tela (vincular, cadastro, pagar contas), que tem seu próprio elemento de vídeo.
function pararEscaneamentoContinuo() {
  pausarDeteccaoContinua();
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
  pausarDeteccaoContinua();
  await processarResultado(chamada, { aoVoltar: () => retomarDeteccaoContinua() });
}

// ---------------- Navegação entre telas ----------------

document.getElementById('btn-ir-vincular').addEventListener('click', () => {
  pararEscaneamentoContinuo();
  resetVincular();
  mostrarTela('tela-vincular');
});

document.getElementById('btn-ir-cadastro').addEventListener('click', () => {
  pararEscaneamentoContinuo();
  resetCadastroOpcao();
  mostrarTela('tela-cadastro-opcao');
});

// ---------------- Escolha de cadastro: usar o celular (QR) ou fazer aqui no totem ----------------
// "Usar seu cel": gera um QR para a mesma URL pública do cadastro-mobile.html —
// o aluno preenche os dados e paga direto no celular dele, sem ocupar o totem.
// "Pagar aqui": segue o fluxo de sempre, preenchido na tela do próprio totem.

function resetCadastroOpcao() {
  document.getElementById('opcao-cadastro-botoes').classList.remove('oculto');
  document.getElementById('painel-cadastro-qr-celular').classList.add('oculto');
}

document.getElementById('btn-cadastro-usar-celular').addEventListener('click', () => {
  document.getElementById('opcao-cadastro-botoes').classList.add('oculto');
  document.getElementById('painel-cadastro-qr-celular').classList.remove('oculto');
  const alvo = document.getElementById('qrcode-cadastro-celular');
  alvo.innerHTML = '';
  // eslint-disable-next-line no-new
  new QRCode(alvo, {
    text: `${window.location.origin}/cadastro-mobile.html`,
    width: 200, height: 200, colorDark: '#0f172a', colorLight: '#ffffff',
  });
});

document.getElementById('btn-cadastro-celular-voltar').addEventListener('click', resetCadastroOpcao);

document.getElementById('btn-cadastro-pagar-aqui').addEventListener('click', () => {
  resetCadastro();
  mostrarTela('tela-cadastro');
});

document.getElementById('btn-voltar-cadastro-opcao').addEventListener('click', () => {
  mostrarTela('tela-inicio');
  iniciarEscaneamentoContinuo();
});

document.getElementById('btn-ir-contas').addEventListener('click', () => {
  pararEscaneamentoContinuo();
  resetContas();
  mostrarTela('tela-contas');
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

// ---------------- Resultado (overlay sobre a própria câmera, com auto-retorno) ----------------
// A câmera NUNCA para aqui — o resultado (liberado/negado) aparece como um
// overlay por cima do vídeo, que continua rodando por trás. Se o motivo da
// negação for mensalidade em atraso, oferece "Pagar contas em atraso" com o
// CPF já preenchido, sem fechar sozinho tão rápido (dá tempo da pessoa clicar).

async function processarResultado(chamada, { aoVoltar } = {}) {
  const overlay = document.getElementById('overlay-resultado');
  const btnPagarContas = document.getElementById('btn-overlay-pagar-contas');

  overlay.classList.remove('liberado', 'negado');
  overlay.classList.add('visivel');
  btnPagarContas.classList.add('oculto');
  btnPagarContas.onclick = null;
  document.getElementById('overlay-icone').textContent = '⏳';
  document.getElementById('overlay-titulo').textContent = 'Verificando...';
  document.getElementById('overlay-msg').textContent = '';

  let cpfParaContas = null;

  try {
    const r = await chamada();
    if (r.autorizado) {
      overlay.classList.add('liberado');
      document.getElementById('overlay-icone').textContent = '✅';
      document.getElementById('overlay-titulo').textContent = `Bem-vindo(a), ${r.aluno_nome || ''}!`;
      document.getElementById('overlay-msg').textContent = 'Acesso liberado. Pode entrar.';
    } else {
      overlay.classList.add('negado');
      document.getElementById('overlay-icone').textContent = '⛔';
      document.getElementById('overlay-titulo').textContent = 'Acesso negado';
      document.getElementById('overlay-msg').textContent = r.motivo || 'Procure a recepção.';
      if (r.cpf && /atraso/i.test(r.motivo || '')) {
        cpfParaContas = r.cpf;
      }
    }
  } catch (err) {
    overlay.classList.add('negado');
    document.getElementById('overlay-icone').textContent = '⚠️';
    document.getElementById('overlay-titulo').textContent = 'Não foi possível verificar';
    document.getElementById('overlay-msg').textContent = err.message;
  }

  const fecharOverlay = () => {
    overlay.classList.remove('visivel');
    btnPagarContas.classList.add('oculto');
    document.getElementById('input-cpf').value = '';
    if (aoVoltar) aoVoltar();
  };

  if (cpfParaContas) {
    // Fica visível mais tempo (o triplo) já que agora tem uma ação disponível
    // — mas ainda fecha sozinho se ninguém interagir, pra não travar a fila.
    btnPagarContas.classList.remove('oculto');
    let fechamentoAutomatico;
    btnPagarContas.onclick = () => {
      clearTimeout(fechamentoAutomatico);
      overlay.classList.remove('visivel');
      btnPagarContas.classList.add('oculto');
      pararEscaneamentoContinuo();
      abrirTelaContasComCpf(cpfParaContas);
    };
    fechamentoAutomatico = setTimeout(fecharOverlay, DURACAO_RESULTADO_MS * 3);
    return;
  }

  setTimeout(fecharOverlay, DURACAO_RESULTADO_MS);
}

// ---------------- Identificação por CPF (sempre disponível na tela inicial) ----------------

document.getElementById('btn-confirmar-cpf').addEventListener('click', () => {
  const cpf = document.getElementById('input-cpf').value.trim();
  if (!cpf) return;
  pausarDeteccaoContinua();
  processarResultado(
    () => api('/api/terminal/acesso/cpf', { method: 'POST', body: JSON.stringify({ cpf }) }),
    { aoVoltar: () => retomarDeteccaoContinua() },
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
      instrucaoEl.textContent = 'Não foi possível gerar o pagamento. Procure a recepção.';
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

// ---------------- Pagar contas em atraso (consulta por CPF) ----------------
// Acessível pelo menu principal OU pelo botão que aparece no overlay de
// "Acesso negado - mensalidades em atraso". Uma única transação Pix pode
// cobrir várias contas selecionadas de uma vez (ver POST /contas/pagar).

let contasCpfAtual = null;
let contasSelecionadas = {}; // cobranca_id -> valor_centavos
let contasPollTimer = null;

function resetContas() {
  pararPollContas();
  contasCpfAtual = null;
  contasSelecionadas = {};
  document.getElementById('input-cpf-contas').value = '';
  document.getElementById('contas-cpf-erro').textContent = '';
  document.getElementById('painel-contas-cpf').classList.remove('oculto');
  document.getElementById('painel-contas-lista').classList.add('oculto');
  document.getElementById('painel-contas-pagamento').classList.add('oculto');
  document.getElementById('painel-contas-comprovante').classList.add('oculto');
  document.getElementById('btn-copiar-pix-contas').classList.add('oculto');
}

// Chamada pelo botão "Pagar contas em atraso" do overlay de acesso negado —
// já entra direto na tela com o CPF preenchido e a busca disparada.
function abrirTelaContasComCpf(cpf) {
  resetContas();
  mostrarTela('tela-contas');
  document.getElementById('input-cpf-contas').value = cpf;
  buscarContas();
}

async function buscarContas() {
  const cpf = document.getElementById('input-cpf-contas').value.trim();
  const erroEl = document.getElementById('contas-cpf-erro');
  erroEl.textContent = '';
  if (!cpf) return;

  try {
    const resp = await api('/api/terminal/contas/consultar', { method: 'POST', body: JSON.stringify({ cpf }) });
    if (!resp.contas.length) {
      erroEl.textContent = 'Nenhuma conta em aberto encontrada para este CPF.';
      return;
    }
    contasCpfAtual = cpf;
    document.getElementById('contas-lista-saudacao').textContent = `Olá, ${resp.aluno_nome}! Selecione as contas que deseja pagar:`;
    renderizarListaContas(resp.contas);
    document.getElementById('painel-contas-cpf').classList.add('oculto');
    document.getElementById('painel-contas-lista').classList.remove('oculto');
  } catch (err) {
    erroEl.textContent = err.message;
  }
}

document.getElementById('btn-buscar-contas').addEventListener('click', buscarContas);

function renderizarListaContas(contas) {
  contasSelecionadas = {};
  const alvo = document.getElementById('lista-contas');
  alvo.innerHTML = contas.map((c) => `
    <label class="item-conta">
      <input type="checkbox" data-id="${c.id}" data-valor="${c.valor_centavos}" checked />
      <div class="info">
        <div class="desc">${c.descricao || 'Conta'}</div>
        <div class="venc">${c.vencimento ? `Vencimento: ${c.vencimento.split('-').reverse().join('/')}` : ''}</div>
      </div>
      <div class="valor">${formatarMoedaCadastro(c.valor_centavos)}</div>
    </label>
  `).join('');

  contas.forEach((c) => { contasSelecionadas[c.id] = c.valor_centavos; });

  alvo.querySelectorAll('input[type=checkbox]').forEach((chk) => {
    chk.addEventListener('change', () => {
      if (chk.checked) contasSelecionadas[chk.dataset.id] = Number(chk.dataset.valor);
      else delete contasSelecionadas[chk.dataset.id];
      atualizarTotalContas();
    });
  });

  atualizarTotalContas();
}

function atualizarTotalContas() {
  const total = Object.values(contasSelecionadas).reduce((a, b) => a + b, 0);
  document.getElementById('contas-total-valor').textContent = formatarMoedaCadastro(total);
  document.getElementById('btn-gerar-pix-contas').disabled = total <= 0;
}

document.getElementById('btn-gerar-pix-contas').addEventListener('click', async () => {
  const ids = Object.keys(contasSelecionadas);
  if (!ids.length) return;

  try {
    // liberar_acesso: true porque este é o totem físico da academia — o mesmo
    // clique que quita a conta também tenta abrir a catraca em seguida.
    const resp = await api('/api/terminal/contas/pagar', {
      method: 'POST',
      body: JSON.stringify({ cpf: contasCpfAtual, cobranca_ids: ids, liberar_acesso: true }),
    });

    document.getElementById('painel-contas-lista').classList.add('oculto');
    document.getElementById('painel-contas-pagamento').classList.remove('oculto');
    document.getElementById('contas-pagamento-valor').textContent = `Valor: ${formatarMoedaCadastro(resp.valor_centavos)}`;
    document.getElementById('contas-status-pagamento').textContent = 'Aguardando pagamento...';

    const alvo = document.getElementById('qrcode-contas-pagamento');
    alvo.innerHTML = '';
    const btnCopiarPix = document.getElementById('btn-copiar-pix-contas');

    if (resp.qr_code_pix_imagem) {
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${resp.qr_code_pix_imagem}`;
      img.style.width = '220px';
      img.style.height = '220px';
      img.style.borderRadius = '12px';
      alvo.appendChild(img);
    } else if (resp.qr_code_pix) {
      // eslint-disable-next-line no-new
      new QRCode(alvo, { text: resp.qr_code_pix, width: 220, height: 220, colorDark: '#0f172a', colorLight: '#ffffff' });
    }

    if (resp.qr_code_pix) {
      btnCopiarPix.classList.remove('oculto');
      btnCopiarPix.onclick = async () => {
        try {
          await navigator.clipboard.writeText(resp.qr_code_pix);
          btnCopiarPix.textContent = 'Código copiado!';
          setTimeout(() => { btnCopiarPix.textContent = 'Copiar código Pix'; }, 2000);
        } catch {
          alert(`Não foi possível copiar automaticamente. Código Pix:\n${resp.qr_code_pix}`);
        }
      };
    } else {
      btnCopiarPix.classList.add('oculto');
    }

    iniciarPollContas(resp.pagamento_id);
  } catch (err) {
    alert(err.message);
  }
});

function iniciarPollContas(pagamentoId) {
  pararPollContas();
  const statusEl = document.getElementById('contas-status-pagamento');
  contasPollTimer = setInterval(async () => {
    try {
      const resp = await api(`/api/terminal/contas/status/${pagamentoId}`);
      if (resp.pago) {
        pararPollContas();
        mostrarComprovanteContas(resp);
      }
    } catch (err) {
      statusEl.textContent = `Erro ao consultar pagamento: ${err.message}`;
    }
  }, 4000);
}

function pararPollContas() {
  if (contasPollTimer) {
    clearInterval(contasPollTimer);
    contasPollTimer = null;
  }
}

function mostrarComprovanteContas(resp) {
  document.getElementById('painel-contas-pagamento').classList.add('oculto');
  document.getElementById('painel-contas-comprovante').classList.remove('oculto');

  const acessoMsg = resp.autorizado === true
    ? ' Sua entrada já foi liberada.'
    : resp.autorizado === false
      ? ` Não foi possível liberar a catraca automaticamente: ${resp.motivo || ''}. Procure a recepção.`
      : '';
  document.getElementById('contas-comprovante-saudacao').textContent = `Pagamento aprovado, ${resp.aluno_nome || ''}!${acessoMsg}`;

  // resp.pago_em é um ISO datetime completo (com hora) — usar getters locais
  // (getDate/getHours/...) em vez de toLocaleDateString evita depender de
  // configuração de timezone do navegador do totem.
  const agora = new Date(resp.pago_em);
  const dataFormatada = `${String(agora.getDate()).padStart(2, '0')}/${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()} `
    + `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

  const linhasItens = (resp.itens || []).map((it) => `
    <div class="linha"><span>${it.descricao || 'Conta'}</span><span>${formatarMoedaCadastro(it.valor_centavos)}</span></div>
  `).join('');

  document.getElementById('comprovante-itens').innerHTML = `
    <div class="linha"><span>Data</span><span>${dataFormatada}</span></div>
    ${linhasItens}
    <div class="linha"><span>Total pago</span><span>${formatarMoedaCadastro(resp.valor_centavos)}</span></div>
  `;
}

document.getElementById('btn-contas-concluir').addEventListener('click', () => {
  mostrarTela('tela-inicio');
  iniciarEscaneamentoContinuo();
});

document.getElementById('btn-voltar-4').addEventListener('click', () => {
  pararPollContas();
  pararCamera();
  mostrarTela('tela-inicio');
  iniciarEscaneamentoContinuo();
});

// ---------------- Inicialização ----------------

iniciarEscaneamentoContinuo();
