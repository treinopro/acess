// Totem/terminal de auto atendimento — identificação de alunos já cadastrados
// (CPF, QR pessoal do celular, reconhecimento facial contínuo) e vinculação
// inicial de método de acesso para quem já existia no sistema antes do totem.
//
// IMPORTANTE: troque o valor abaixo pelo mesmo TERMINAL_TOKEN configurado no
// .env do servidor. Como o aluno não faz login, este token é o que autentica
// o totem perante a API — mantenha o dispositivo fisicamente controlado.
const TERMINAL_TOKEN = '533910a1b2ff8e90e62194b1b2f61c1e641e724e9d00b2d4f50e96bbce3e9e63';

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

// ---------------- Aviso sonoro no totem (2026-07) ----------------
// Toca automaticamente a cada identificação (CPF, QR ou facial): frase falada
// ("voz") ou beep(s) curto(s), configurável por situação em Configurações >
// Aviso sonoro no totem (ver config.routes.js, chave "som_totem"). Padrões
// abaixo valem até a config carregar (ou se a busca falhar por algum motivo).
//
// ATENÇÃO com a opção "voz": o totem roda numa rede sem saída pra internet
// (ver comentário dos modelos de rosto acima). O navegador às vezes precisa
// de uma "voz de rede" pra sintetizar fala em português — se o tablet não
// tiver uma voz pt-BR instalada localmente (Android: Ajustes > Acessibilidade
// > Conversão de texto em voz > baixar o pacote de voz em português), a fala
// pode simplesmente não sair nenhum som, sem erro nenhum aparecendo. "Beep"
// não depende disso — é só um tom curto gerado na hora, sempre funciona.
let configSomTotem = {
  primeiroAcesso: { tipo: 'voz', texto: 'Bom treino!' },
  acessoLiberado: { tipo: 'beep', beeps: 1 },
  acessoNegado: { tipo: 'beep', beeps: 2 },
};

async function carregarConfigSomTotem() {
  try {
    const config = await api('/api/config');
    if (config.som_totem) {
      const somConfig = typeof config.som_totem === 'string' ? JSON.parse(config.som_totem) : config.som_totem;
      configSomTotem = { ...configSomTotem, ...somConfig };
    }
  } catch {
    // Fica com os padrões acima se a busca da config pública falhar.
  }
}
carregarConfigSomTotem();

let audioCtxSom = null;
function tocarBeep(vezes = 1) {
  try {
    audioCtxSom = audioCtxSom || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtxSom;
    for (let i = 0; i < vezes; i++) {
      const inicio = ctx.currentTime + i * 0.35;
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      // Envelope curto (sobe e desce rápido) em vez de ligar/desligar seco —
      // evita o "clique" de estouro que um beep sem fade costuma ter.
      ganho.gain.setValueAtTime(0.0001, inicio);
      ganho.gain.exponentialRampToValueAtTime(0.3, inicio + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.18);
      osc.connect(ganho);
      ganho.connect(ctx.destination);
      osc.start(inicio);
      osc.stop(inicio + 0.2);
    }
  } catch {
    // Web Audio pode falhar em navegadores muito antigos — o aviso sonoro é
    // só um reforço, nunca deve travar o fluxo normal do totem por causa disso.
  }
}

function falarTexto(texto) {
  try {
    if (!('speechSynthesis' in window) || !texto) return;
    speechSynthesis.cancel(); // corta qualquer fala anterior ainda tocando, evita acumular fila
    const fala = new SpeechSynthesisUtterance(texto);
    fala.lang = 'pt-BR';
    speechSynthesis.speak(fala);
  } catch {
    // idem — nunca deve travar o totem por causa do aviso sonoro
  }
}

function tocarAvisoSonoro(situacao) {
  if (!situacao || situacao.tipo === 'nenhum') return;
  if (situacao.tipo === 'voz') falarTexto(situacao.texto);
  else if (situacao.tipo === 'beep') tocarBeep(situacao.beeps || 1);
}

// ---------------- Fonte da câmera: webcam USB (via app "USB Camera" no tablet) ----------------
// O totem passou a usar uma webcam USB plugada no tablet em vez da câmera
// embutida, porque o Android do tablet não expõe a webcam USB pra API padrão
// de câmera do navegador (getUserMedia) — só o app dedicado enxerga o
// dispositivo USB diretamente. Contornamos isso usando o servidor de rede
// (modo "IP Camera") desse app, que publica a imagem como um stream MJPEG
// comum, consumível por uma tag <img> normal.
//
// Usamos 127.0.0.1 (localhost) em vez do IP da rede Wi-Fi de propósito: como
// o navegador que mostra essa página roda no PRÓPRIO tablet que tem a
// webcam plugada, o loopback funciona sempre, mesmo que o IP do tablet mude
// ao trocar de rede Wi-Fi na academia. Testado e confirmado funcionando.
//
// O app "USB Camera" exige login (usuário/senha) e não tem opção de
// desativar isso. Tentamos colocar a senha direto na URL, mas o navegador
// bloqueia esse formato (usuário:senha@host) para recursos carregados
// sozinhos pela página vindos de outro endereço — e mesmo se não bloqueasse,
// ainda faltaria CORS pra leitura de pixels (QR/rosto) funcionar.
//
// Por isso a porta 8081 (direto do app) NÃO é usada aqui. Em vez disso, um
// proxy local roda no próprio tablet via Termux (script
// scripts/totem/proxy_webcam.py, ver README) na porta 9000: ele se autentica
// com o app por trás dos panos (scripts não têm essas restrições do
// navegador) e republica o vídeo sem senha e com cabeçalho CORS liberado.
// Esse proxy precisa estar rodando pro totem funcionar.
//
// REVERTIDO em 11/07/2026: depois de meses tentando webcam USB (primeiro via
// app terceiro + proxy Termux, depois via app Android nativo com plugin UVC
// direto), o Logcat do app nativo confirmou que o problema de fundo era
// físico — a porta USB-OTG do tablet não sustenta a energia que a webcam
// pede durante o streaming e cai sozinha a cada poucos segundos (visto como
// "connected=false/no-power" no log do sistema Android). Sem hardware extra
// (um hub USB alimentado) isso não tem solução só por software. Voltamos a
// usar a câmera embutida do tablet (getUserMedia) — mais simples e sem esse
// ponto de falha. Todo o trabalho da webcam USB (app nativo Capacitor,
// plugin UVC, proxy Python/Termux) ficou arquivado em
// totem-app-scaffold/totem-app/ (ver README.md lá) caso valha retomar no
// futuro com um hub alimentado.
const USAR_WEBCAM_USB = false;
const USB_WEBCAM_URL = 'http://127.0.0.1:9000/video';

// ---------------- Tela cheia (esconde a barra de endereço/UI do navegador) ----------------
// A API de tela cheia do navegador só pode ser ativada depois de uma
// interação da pessoa (toque na tela) — é uma regra de segurança, não dá
// pra forçar isso sozinho assim que a página carrega. Por isso escutamos o
// primeiro toque/clique em qualquer lugar da tela e aí sim pedimos tela
// cheia. Se o tablet estiver aberto via ícone salvo na tela inicial (veja
// manifest-totem.json), já abre praticamente sem UI do navegador.
//
// Importante: isso esconde a barra de endereço do navegador, mas não
// substitui um "modo quiosque" de verdade — quem estiver no tablet ainda
// consegue sair arrastando a barra do Android ou usando o botão voltar. Pra
// travar o tablet de vez nessa tela, use o recurso nativo do Android
// "Fixar app" (Configurações > Segurança > Fixar app) ou um app de quiosque
// como o "Fully Kiosk Browser".
function pedirTelaCheia() {
  const el = document.documentElement;
  const pedir = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
  if (pedir) pedir.call(el).catch(() => {});
}

// 2026-07: antes, QUALQUER clique/toque na página (inclusive dentro da caixa
// de digitar CPF, ou nos botões) já disparava o pedido de tela cheia — na
// prática isso fazia a tela entrar em tela cheia "sozinha" bem na hora em que
// alguém só queria clicar num campo ou botão pra usar o totem, parecendo um
// acidente. Agora ignora cliques/toques em campos de formulário, botões e
// links — só entra em tela cheia a partir de um toque numa área neutra da
// tela (o vídeo da câmera, o fundo). Também ignora toque com mais de um dedo,
// que é o gesto reservado pra abrir o destravar do modo quiosque (ver mais
// abaixo).
function ativarTelaCheiaNoPrimeiroToque() {
  const ativar = (ev) => {
    if (ev.touches && ev.touches.length > 1) return;
    if (ev.target && ev.target.closest && ev.target.closest('input, select, textarea, button, a')) return;
    pedirTelaCheia();
    document.removeEventListener('click', ativar);
    document.removeEventListener('touchstart', ativar);
  };
  document.addEventListener('click', ativar);
  document.addEventListener('touchstart', ativar);
}
ativarTelaCheiaNoPrimeiroToque();

// Se a tela cheia for encerrada por algum motivo (ex.: gesto do Android),
// volta a escutar o próximo toque pra pedir de novo.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) ativarTelaCheiaNoPrimeiroToque();
});

// ---------------- Modo quiosque: impedir voltar/mudar de página (2026-07) ----------------
// Pedido do dono do sistema: no tablet do totem, ninguém deve conseguir sair
// da tela usando o gesto/botão de "voltar" nem trocar de página. Isso é feito
// armadilhando o histórico do navegador: sempre que alguém tenta voltar, a
// página empurra o mesmo estado de novo, cancelando a navegação.
//
// LIMITE IMPORTANTE (deixando isso bem claro): isso trava o gesto/botão de
// "voltar" e alguns atalhos de teclado, mas NÃO impede alguém de digitar
// outro endereço na barra do navegador ou usar o menu do próprio navegador —
// isso só dá pra travar de verdade com um app de quiosque de verdade (tipo
// "Fully Kiosk Browser") ou fixando o app no Android ("Fixar app", ver
// comentário da tela cheia acima). Ainda assim, cobre o caso mais comum de
// alguém arrastar a borda da tela ou apertar "voltar" sem querer/de propósito.
let quiosqueDestravado = false;

function armarArmadilhaHistorico() {
  history.pushState({ quiosque: true }, '', location.href);
}
armarArmadilhaHistorico();

window.addEventListener('popstate', () => {
  if (quiosqueDestravado) return;
  armarArmadilhaHistorico();
});

// Bloqueia atalhos de teclado comuns de navegação (Alt+Seta, Backspace fora
// de campo de texto) — só faz diferença pra quem usa o totem com teclado
// físico (ex.: notebook em vez de tablet), mas não custa ter também no tablet.
document.addEventListener('keydown', (ev) => {
  if (quiosqueDestravado) return;
  const alvoEhCampoDeTexto = ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA');
  const tentandoVoltar = (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight'))
    || (ev.key === 'Backspace' && !alvoEhCampoDeTexto);
  if (tentandoVoltar) ev.preventDefault();
});

// ---------------- Destravar o modo quiosque (gesto/atalho secreto) ----------------
// Em tela touch: toque com DOIS dedos em qualquer lugar mostra o campo de
// senha (pedido explícito do dono do sistema). Sem touch (notebook, sem tela
// sensível ao toque): o atalho de teclado Ctrl+Shift+L mostra direto a opção
// de destravar, sem pedir senha — quem está mexendo pelo teclado já está
// fisicamente no PC/recepção, não é o público geral que usa o tablet.
//
// TROQUE a senha abaixo por uma só sua (mesma ideia do TERMINAL_TOKEN lá em
// cima) antes de usar isso de verdade — não deixe o valor padrão.
const SENHA_DESTRAVAR_QUIOSQUE = 'academia2026';

function mostrarOverlayDestravar({ pedirSenha }) {
  const overlay = document.getElementById('overlay-destravar-quiosque');
  const campoSenha = document.getElementById('destravar-quiosque-senha');
  const erroEl = document.getElementById('destravar-quiosque-erro');
  erroEl.textContent = '';
  campoSenha.value = '';
  campoSenha.classList.toggle('oculto', !pedirSenha);
  document.getElementById('btn-destravar-quiosque-confirmar').dataset.pedeSenha = pedirSenha ? '1' : '';
  overlay.classList.remove('oculto');
  if (pedirSenha) campoSenha.focus();
}

// 2026-07: antes, o overlay abria IMEDIATAMENTE em qualquer toque com 2 pontos
// de contato, em qualquer lugar da tela — inclusive em cima de botões normais.
// Em touchscreen, um toque comum (dedo largo, leve arrasto, toque com a lateral
// do dedo) às vezes é lido como 2 pontos de contato por uma fração de segundo,
// então um clique normal em "Quero me cadastrar" ou qualquer outro botão podia
// abrir o bloqueio sem ninguém ter feito o gesto de propósito. Agora exige
// segurar os 2 dedos por ~700ms antes de abrir — tempo suficiente pra ignorar
// esse ruído do toque, mas ainda rápido o bastante pra quem sabe o gesto e faz
// de propósito. Solta antes da hora, tira um dedo, ou move os dedos (arrasta)
// e o temporizador é cancelado.
const SEGURAR_DOIS_DEDOS_MS = 700;
const LIMITE_ARRASTO_PX = 20;
let temporizadorDoisDedos = null;
let pontoInicialDoisDedos = null;

function cancelarTemporizadorDoisDedos() {
  clearTimeout(temporizadorDoisDedos);
  temporizadorDoisDedos = null;
  pontoInicialDoisDedos = null;
}

document.addEventListener('touchstart', (ev) => {
  if (ev.touches && ev.touches.length === 2) {
    ev.preventDefault();
    cancelarTemporizadorDoisDedos();
    pontoInicialDoisDedos = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    temporizadorDoisDedos = setTimeout(() => {
      temporizadorDoisDedos = null;
      mostrarOverlayDestravar({ pedirSenha: true });
    }, SEGURAR_DOIS_DEDOS_MS);
  } else if (ev.touches && ev.touches.length !== 2) {
    // Terceiro dedo apareceu, ou já tinha só 1 — não é mais o gesto esperado.
    cancelarTemporizadorDoisDedos();
  }
});

document.addEventListener('touchmove', (ev) => {
  if (!temporizadorDoisDedos || !pontoInicialDoisDedos || !ev.touches || !ev.touches[0]) return;
  const dx = ev.touches[0].clientX - pontoInicialDoisDedos.x;
  const dy = ev.touches[0].clientY - pontoInicialDoisDedos.y;
  if (Math.sqrt(dx * dx + dy * dy) > LIMITE_ARRASTO_PX) cancelarTemporizadorDoisDedos();
});

document.addEventListener('touchend', cancelarTemporizadorDoisDedos);
document.addEventListener('touchcancel', cancelarTemporizadorDoisDedos);

document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && ev.shiftKey && (ev.key === 'L' || ev.key === 'l')) {
    mostrarOverlayDestravar({ pedirSenha: false });
  }
});

document.getElementById('btn-destravar-quiosque-cancelar').addEventListener('click', () => {
  document.getElementById('overlay-destravar-quiosque').classList.add('oculto');
});

document.getElementById('btn-destravar-quiosque-confirmar').addEventListener('click', (ev) => {
  const pedeSenha = ev.currentTarget.dataset.pedeSenha === '1';
  if (pedeSenha) {
    const campoSenha = document.getElementById('destravar-quiosque-senha');
    if (campoSenha.value !== SENHA_DESTRAVAR_QUIOSQUE) {
      document.getElementById('destravar-quiosque-erro').textContent = 'Senha incorreta.';
      return;
    }
  }
  quiosqueDestravado = true;
  if (document.fullscreenElement) {
    const sair = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
    if (sair) {
      try { Promise.resolve(sair.call(document)).catch(() => {}); } catch { /* alguns navegadores não retornam Promise aqui */ }
    }
  }
  document.getElementById('overlay-destravar-quiosque').classList.add('oculto');
});

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
let elementoWebcamUsbAtual = null;

async function iniciarCamera(videoEl) {
  pararCamera();

  if (USAR_WEBCAM_USB) {
    elementoWebcamUsbAtual = videoEl;
    // crossOrigin = 'anonymous': pede a imagem em modo CORS. O proxy local
    // (porta 9000) responde com Access-Control-Allow-Origin liberado, então
    // isso faz o canvas NÃO ficar "contaminado" — sem isso, drawImage/
    // getImageData (usados pra ler QR code e rosto) travariam com erro de
    // segurança mesmo com a imagem aparecendo normal na tela.
    videoEl.crossOrigin = 'anonymous';

    // App nativo Android (Capacitor + plugin "UsbWebcam" — ver pasta
    // android-native-plugin/ no scaffold do totem-app): fala direto com a
    // webcam USB via USB Host API do Android, sem precisar do app "USB
    // Camera" de terceiros nem do proxy Python via Termux. Ver
    // native-usb-webcam-bridge.js. Tem prioridade sobre o fluxo MJPEG abaixo
    // quando disponível — o fallback MJPEG continua existindo de propósito,
    // pra esta mesma página seguir funcionando num Chrome comum (sem o app
    // nativo instalado) durante a transição.
    if (window.NativeUsbWebcam && window.NativeUsbWebcam.disponivel()) {
      await window.NativeUsbWebcam.iniciar((base64) => {
        videoEl.src = `data:image/jpeg;base64,${base64}`;
      });
      return;
    }

    await new Promise((resolve, reject) => {
      videoEl.onload = () => resolve();
      videoEl.onerror = () => reject(new Error(
        'Não foi possível conectar à webcam USB. Verifique se o proxy local (Termux, scripts/totem/proxy_webcam.py) e o app "USB Camera" estão rodando no tablet.'
      ));
      // cache-bust: garante que cada início de câmera abre uma conexão nova
      // com o stream, em vez de reaproveitar algo preso de uma tentativa anterior.
      videoEl.src = `${USB_WEBCAM_URL}?t=${Date.now()}`;
    });
    return;
  }

  // Resolução baixa de propósito: reconhecimento facial e leitura de QR não
  // precisam de HD (a pessoa fica perto da câmera), e pedir uma resolução
  // menor reduz bastante o processamento de cada quadro — sem isso, câmeras
  // que abrem em resolução alta por padrão deixavam a detecção lenta a
  // ponto de travar o navegador.
  streamAtual = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
  });
  videoEl.srcObject = streamAtual;
  await videoEl.play();
}

function pararCamera() {
  if (streamAtual) {
    streamAtual.getTracks().forEach((t) => t.stop());
    streamAtual = null;
  }
  if (elementoWebcamUsbAtual) {
    elementoWebcamUsbAtual.src = '';
    elementoWebcamUsbAtual = null;
  }
  if (window.NativeUsbWebcam && window.NativeUsbWebcam.disponivel()) {
    window.NativeUsbWebcam.parar().catch(() => {});
  }
}

// Abstrai as diferenças entre <video> (getUserMedia) e <img> (stream MJPEG da
// webcam USB) pro resto do código (leitura de QR + reconhecimento facial) não
// precisar saber qual dos dois modos está ativo.
function elementoCameraPronto(el) {
  return USAR_WEBCAM_USB
    ? (el.complete && el.naturalWidth > 0)
    : (el.readyState === el.HAVE_ENOUGH_DATA);
}

function larguraCamera(el) {
  return USAR_WEBCAM_USB ? el.naturalWidth : el.videoWidth;
}

function alturaCamera(el) {
  return USAR_WEBCAM_USB ? el.naturalHeight : el.videoHeight;
}

// ---------------- Motor de cálculo do TensorFlow.js (usado por dentro do face-api) ----------------
// O face-api roda a rede neural em cima do TensorFlow.js, que escolhe um
// "backend" (motor de cálculo) sozinho. Se o navegador do tablet não tiver
// WebGL disponível/habilitado (comum em tablets mais simples), o TensorFlow.js
// cai pro backend "cpu" — que faz a conta na CPU, de forma síncrona, e
// TRAVA a página inteira (cliques, animação, tudo) durante cada detecção.
// É exatamente o sintoma relatado: a imagem da câmera continua fluida (ela é
// atualizada pelo próprio navegador, fora do JavaScript), mas a página para
// de responder bem na hora de tentar reconhecer o rosto.
//
// Aqui forçamos o backend "webgl" (usa a GPU do aparelho) explicitamente
// antes de carregar os modelos — isso deixa cada detecção ordens de
// magnitude mais rápida quando o aparelho tem WebGL disponível (praticamente
// todo Android tem). Se por algum motivo não tiver, o TensorFlow.js volta
// sozinho pro "cpu" (não quebra, só continua lento).
let motorTensorflowAtivo = 'desconhecido';

async function prepararMotorTensorflow() {
  try {
    if (faceapi.tf && typeof faceapi.tf.setBackend === 'function') {
      await faceapi.tf.setBackend('webgl');
      await faceapi.tf.ready();
    }
  } catch (err) {
    // Se "webgl" não estiver disponível, deixa o TensorFlow.js decidir
    // sozinho (cai pro "cpu") — não é um erro fatal, só mais lento.
  }
  motorTensorflowAtivo = (faceapi.tf && faceapi.tf.getBackend && faceapi.tf.getBackend()) || 'desconhecido';
}

// ---------------- Modelos de reconhecimento facial ----------------

let modelosFaciaisCarregados = false;
let modelosFaciaisCarregando = null;

async function carregarModelosFaciais() {
  if (modelosFaciaisCarregados) return;
  if (modelosFaciaisCarregando) return modelosFaciaisCarregando;
  modelosFaciaisCarregando = (async () => {
    await prepararMotorTensorflow();
    await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
    modelosFaciaisCarregados = true;
  })();
  return modelosFaciaisCarregando;
}

// inputSize menor (padrão do face-api é 416) = a rede analisa uma versão
// bem menor de cada quadro, o que acelera MUITO a detecção com uma perda de
// precisão pequena — mais que suficiente pra alguém posicionado perto da
// câmera, que é o caso do totem. Foi esse ajuste (junto com a resolução
// menor da câmera) que resolveu o travamento/lentidão do reconhecimento.
// Reduzido de 224 pra 160 depois de constatar que o travamento acontece
// justamente durante o processamento (não no vídeo em si) — valor menor
// diminui ainda mais o tempo que cada detecção trava a página, sobretudo em
// aparelhos sem aceleração por GPU disponível pro TensorFlow.js.
const OPCOES_DETECTOR_FACIAL = new faceapi.TinyFaceDetectorOptions({ inputSize: 160 });

// CAUSA do travamento do navegador durante o reconhecimento (2026-07,
// confirmado pelo usuário: "quando não tem ninguém na frente da câmera volta
// a ficar fluida"): a detecção "barata" (TinyFaceDetector sozinho, só achando
// a CAIXA onde está um rosto) já é rápida mesmo sem GPU — por isso fica
// fluido sem ninguém na frente (o pipeline nem passa dessa etapa). Quem trava
// é a etapa SEGUINTE, que só roda quando uma caixa de rosto é encontrada:
// calcular os 68 pontos de referência (landmarks) e depois o descritor de
// 128 números usado pra reconhecer quem é a pessoa — as duas bem mais
// pesadas. Enquanto a pessoa demora a ficar bem posicionada (ângulo ruim, se
// mexendo, parcialmente fora do quadro), essa etapa pesada repetia a cada
// tick (INTERVALO_ESCANEAMENTO_MS = 600ms) achando a caixa de novo e tentando
// de novo — travando a página em sequência.
//
// Mantendo tudo que já ajudava antes (inputSize 160, resolução reduzida do
// quadro — ver LARGURA_MAX_PROCESSAMENTO abaixo), este cooldown separa as
// duas etapas: todo tick roda só a detecção barata; a etapa pesada
// (landmarks + descritor) só roda de novo depois de passar esse tanto de
// tempo desde a última tentativa, mesmo que uma caixa de rosto continue
// aparecendo em todo tick. Não piora o reconhecimento de quem já está parado
// corretamente (a 1ª tentativa já costuma funcionar e não passa pelo
// cooldown de novo, porque processarResultadoInicio pausa o loop) — só evita
// repetir a parte pesada em sequência enquanto a pessoa ainda está chegando.
const INTERVALO_MINIMO_RECONHECIMENTO_PESADO_MS = 1200;
let ultimaTentativaReconhecimentoPesadoEm = 0;

async function detectarRosto(fonte) {
  return faceapi
    .detectSingleFace(fonte, OPCOES_DETECTOR_FACIAL)
    .withFaceLandmarks()
    .withFaceDescriptor();
}

// Só a etapa barata (acha a caixa do rosto, sem landmarks/descritor) — usada
// pra decidir SE vale a pena pagar o custo da etapa pesada (ver cooldown
// acima).
async function temRostoNoQuadro(fonte) {
  const caixa = await faceapi.detectSingleFace(fonte, OPCOES_DETECTOR_FACIAL);
  return Boolean(caixa);
}

// ---------------- Limite de resolução de processamento ----------------
// A câmera embutida (getUserMedia) já é pedida em 640x480 (ver iniciarCamera),
// mas a webcam USB (stream MJPEG do app "USB Camera") manda a resolução que
// o app estiver configurado pra mandar — não existe uma API do navegador pra
// "pedir" uma resolução menor de um <img>, como dá pra fazer com getUserMedia.
// Se o quadro vier grande, decodificar QR e rodar a rede neural de rosto em
// cima dele é o que trava o navegador (foi exatamente o travamento que
// continuava só no tablet com a webcam USB, mesmo já limitando getUserMedia).
//
// Por isso todo processamento (QR + rosto) passa por este canvas único,
// redimensionado pra no máximo LARGURA_MAX_PROCESSAMENTO de largura antes de
// analisar — não importa a resolução da fonte original. A imagem exibida na
// tela pro aluno continua na resolução cheia (o <img>/<video> não é afetado).
const LARGURA_MAX_PROCESSAMENTO = 480;
const canvasProcessamento = document.createElement('canvas');
const ctxProcessamento = canvasProcessamento.getContext('2d', { willReadFrequently: true });

function desenharQuadroProcessamento(el) {
  const largura = larguraCamera(el);
  const altura = alturaCamera(el);
  const escala = Math.min(1, LARGURA_MAX_PROCESSAMENTO / largura);
  canvasProcessamento.width = Math.max(1, Math.round(largura * escala));
  canvasProcessamento.height = Math.max(1, Math.round(altura * escala));
  ctxProcessamento.drawImage(el, 0, 0, canvasProcessamento.width, canvasProcessamento.height);
  return canvasProcessamento;
}

// ---------------- Tela inicial: escaneamento contínuo (rosto + QR) ----------------

let escaneamentoAtivo = false;
let escaneamentoTimer = null;

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
  // "(motor: webgl)" ou "(motor: cpu)" — diagnóstico visível na própria tela do
  // totem, sem precisar de depuração remota. Se aparecer "cpu" em vez de
  // "webgl", é sinal de que o navegador do aparelho não tem aceleração por
  // GPU disponível pro TensorFlow.js, e é isso que causa a travada durante
  // cada tentativa de reconhecimento facial.
  statusEl.textContent = `Aproxime-se para reconhecimento facial, ou mostre o QR do seu celular... (motor: ${motorTensorflowAtivo})`;
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

  if (!elementoCameraPronto(video)) {
    agendarProximoTick();
    return;
  }

  // Um único quadro reduzido (ver LARGURA_MAX_PROCESSAMENTO) serve tanto pra
  // achar QR quanto pra reconhecimento facial — evita decodificar/analisar a
  // resolução nativa da fonte, que é o que travava o tablet com a webcam USB.
  const quadro = desenharQuadroProcessamento(video);

  // 1) tenta achar um QR code no quadro atual (celular do aluno)
  const imageData = ctxProcessamento.getImageData(0, 0, quadro.width, quadro.height);
  const qr = window.jsQR(imageData.data, quadro.width, quadro.height);

  if (qr && qr.data) {
    processarResultadoInicio(() => api('/api/terminal/acesso/codigo', {
      method: 'POST',
      body: JSON.stringify({ codigo_acesso: qr.data }),
    }));
    return;
  }

  // 2) senão, tenta reconhecimento facial no mesmo quadro — ver cooldown em
  // INTERVALO_MINIMO_RECONHECIMENTO_PESADO_MS: só paga o custo pesado
  // (landmarks + descritor) quando vale a pena, não em todo tick.
  let deteccao = null;
  let rostoPresente = false;
  try {
    rostoPresente = await temRostoNoQuadro(quadro);
  } catch {
    // ignora erro pontual da detecção barata (ex.: frame instável)
  }

  if (rostoPresente) {
    const agora = Date.now();
    if (agora - ultimaTentativaReconhecimentoPesadoEm >= INTERVALO_MINIMO_RECONHECIMENTO_PESADO_MS) {
      ultimaTentativaReconhecimentoPesadoEm = agora;
      try {
        deteccao = await detectarRosto(quadro);
      } catch {
        // ignora erros pontuais da etapa pesada (frame mudou/instável nesse
        // meio tempo) e segue tentando no próximo tick
      }
    }
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

// "Indicar visitante/amigo" (2026-07): vai direto pro formulário de cadastro
// (pulando a escolha "usar celular"/"pagar aqui", que não fazem sentido pra
// um cadastro gratuito) já com o plano "Visitante" pré-selecionado — ver
// PLANO_VISITANTE_ID acima e o branch correspondente em
// POST /api/terminal/auto-cadastro (terminal.routes.js).
document.getElementById('btn-ir-visitante').addEventListener('click', () => {
  pararEscaneamentoContinuo();
  resetCadastro(PLANO_VISITANTE_ID);
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

// ---------------- Resultado (overlay sobre a própria câmera, com auto-retorno) ----------------
// A câmera NUNCA para aqui — o resultado (liberado/negado) aparece como um
// overlay por cima do vídeo, que continua rodando por trás. Se o motivo da
// negação for mensalidade em atraso, oferece "Pagar contas em atraso" com o
// CPF já preenchido, sem fechar sozinho tão rápido (dá tempo da pessoa clicar).

async function processarResultado(chamada, { aoVoltar } = {}) {
  const overlay = document.getElementById('overlay-resultado');
  const btnPagarContas = document.getElementById('btn-overlay-pagar-contas');
  const vencEl = document.getElementById('overlay-vencimento');

  overlay.classList.remove('liberado', 'negado');
  overlay.classList.add('visivel');
  btnPagarContas.classList.add('oculto');
  btnPagarContas.onclick = null;
  document.getElementById('overlay-icone').textContent = '⏳';
  document.getElementById('overlay-titulo').textContent = 'Verificando...';
  document.getElementById('overlay-msg').textContent = '';
  vencEl.classList.add('oculto');
  vencEl.classList.remove('vencido');
  vencEl.textContent = '';

  let cpfParaContas = null;
  let labelBotaoContas = 'Pagar contas em atraso';

  try {
    const r = await chamada();
    if (r.autorizado) {
      overlay.classList.add('liberado');
      document.body.classList.add('tela-flash-liberado');
      document.getElementById('overlay-icone').textContent = '✅';
      document.getElementById('overlay-titulo').textContent = `Bem-vindo(a), ${r.aluno_nome || ''}!`;
      document.getElementById('overlay-msg').textContent = 'Acesso liberado. Pode entrar.';
      // Aviso sonoro (2026-07): "Bom treino" só no primeiro acesso liberado do
      // dia (calculado no servidor, ver acessoTerminal.service.js); nos
      // seguintes, o aviso normal de "acesso liberado" (voz ou beep, conforme
      // configurado em Configurações > Aviso sonoro no totem).
      tocarAvisoSonoro(r.primeiro_acesso_hoje ? configSomTotem.primeiroAcesso : configSomTotem.acessoLiberado);
    } else {
      overlay.classList.add('negado');
      document.body.classList.add('tela-flash-negado');
      document.getElementById('overlay-icone').textContent = '⛔';
      document.getElementById('overlay-titulo').textContent = 'Acesso negado';
      document.getElementById('overlay-msg').textContent = r.motivo || 'Procure a recepção.';
      tocarAvisoSonoro(configSomTotem.acessoNegado);
      if (r.cpf && /atraso/i.test(r.motivo || '')) {
        cpfParaContas = r.cpf;
      }
    }

    // Aviso de vencimento (2026-07): mostrado tanto liberado quanto negado —
    // "faltam N dias" (âmbar, ainda no prazo) ou "vencido há N dias"
    // (vermelho). Também oferece pagar na hora pelo totem mesmo quando o
    // acesso já foi liberado normalmente (ex.: vence em 2 dias, ainda em dia
    // hoje) — não só no caso já coberto acima de acesso negado por atraso.
    if (r.aviso_vencimento) {
      vencEl.textContent = r.aviso_vencimento.mensagem;
      vencEl.classList.toggle('vencido', r.aviso_vencimento.vencido);
      vencEl.classList.remove('oculto');
      if (r.cpf && !cpfParaContas) {
        cpfParaContas = r.cpf;
        labelBotaoContas = r.aviso_vencimento.vencido ? 'Pagar contas em atraso' : 'Pagar agora';
      }
    }
  } catch (err) {
    overlay.classList.add('negado');
    document.body.classList.add('tela-flash-negado');
    document.getElementById('overlay-icone').textContent = '⚠️';
    document.getElementById('overlay-titulo').textContent = 'Não foi possível verificar';
    document.getElementById('overlay-msg').textContent = err.message;
    tocarAvisoSonoro(configSomTotem.acessoNegado);
  }

  const fecharOverlay = () => {
    overlay.classList.remove('visivel');
    document.body.classList.remove('tela-flash-liberado', 'tela-flash-negado');
    btnPagarContas.classList.add('oculto');
    document.getElementById('input-cpf').value = '';
    if (aoVoltar) aoVoltar();
  };

  if (cpfParaContas) {
    // Fica visível mais tempo (o triplo) já que agora tem uma ação disponível
    // — mas ainda fecha sozinho se ninguém interagir, pra não travar a fila.
    btnPagarContas.textContent = labelBotaoContas;
    btnPagarContas.classList.remove('oculto');
    let fechamentoAutomatico;
    btnPagarContas.onclick = () => {
      clearTimeout(fechamentoAutomatico);
      overlay.classList.remove('visivel');
      document.body.classList.remove('tela-flash-liberado', 'tela-flash-negado');
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
    // Mesma proteção do escaneamento contínuo: espera o quadro estar pronto e
    // processa numa cópia reduzida (ver LARGURA_MAX_PROCESSAMENTO), pra não
    // travar com a resolução nativa da webcam USB; e não deixa um erro
    // pontual de detecção (frame instável) parar o loop de vez.
    if (!elementoCameraPronto(video)) {
      setTimeout(tick, 400);
      return;
    }
    const quadro = desenharQuadroProcessamento(video);
    // Mesmo cooldown do escaneamento contínuo (ver
    // INTERVALO_MINIMO_RECONHECIMENTO_PESADO_MS): só roda a etapa pesada
    // (landmarks + descritor) quando a barata já achou uma caixa de rosto, e
    // no máximo uma vez a cada intervalo — evita travar enquanto a pessoa
    // ainda está se posicionando pro cadastro.
    let deteccao = null;
    let rostoPresente = false;
    try {
      rostoPresente = await temRostoNoQuadro(quadro);
    } catch {
      // ignora erro pontual da detecção barata
    }
    if (rostoPresente) {
      const agora = Date.now();
      if (agora - ultimaTentativaReconhecimentoPesadoEm >= INTERVALO_MINIMO_RECONHECIMENTO_PESADO_MS) {
        ultimaTentativaReconhecimentoPesadoEm = agora;
        try {
          deteccao = await detectarRosto(quadro);
        } catch {
          // ignora erro pontual e segue tentando
        }
      }
    }
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

// Sentinela do "plano Visitante" — mesmo valor de PLANO_VISITANTE_ID em
// terminal.routes.js/portal.routes.js. Usado aqui só pra decidir se o
// resultado do cadastro segue pro pagamento (aluno normal) ou direto pro
// sucesso (visitante, sem Pix/matrícula).
const PLANO_VISITANTE_ID = 'visitante';

function resetCadastro(planoPreSelecionado) {
  pararPollCadastro();
  cadastroCpfAtual = null;
  document.getElementById('cadastro-nome').value = '';
  document.getElementById('cadastro-cpf').value = '';
  document.getElementById('cadastro-telefone').value = '';
  document.getElementById('cadastro-email').value = '';
  document.getElementById('cadastro-data-nascimento').value = '';
  document.getElementById('cadastro-indicado-cpf').value = '';
  document.getElementById('cadastro-form-erro').textContent = '';
  document.getElementById('cadastro-form-titulo').textContent = planoPreSelecionado === PLANO_VISITANTE_ID
    ? 'Cadastro do visitante/amigo — acesso gratuito, sem matrícula.'
    : '';
  document.getElementById('painel-cadastro-form').classList.remove('oculto');
  document.getElementById('painel-cadastro-pagamento').classList.add('oculto');
  document.getElementById('painel-cadastro-sucesso').classList.add('oculto');
  document.getElementById('painel-cadastro-facial').classList.add('oculto');
  document.getElementById('btn-copiar-pix').classList.add('oculto');
  carregarPlanosCadastro(planoPreSelecionado);
}

async function carregarPlanosCadastro(planoPreSelecionado) {
  const select = document.getElementById('cadastro-plano');
  select.innerHTML = '<option value="">Carregando planos...</option>';
  try {
    const planos = await api('/api/terminal/planos');
    select.innerHTML = planos.length
      ? planos.map((p) => `<option value="${p.id}">${p.nome} — ${formatarMoedaCadastro(p.valor_centavos)}</option>`).join('')
      : '<option value="">Nenhum plano disponível</option>';
    if (planoPreSelecionado && planos.some((p) => p.id === planoPreSelecionado)) {
      select.value = planoPreSelecionado;
    }
  } catch (err) {
    select.innerHTML = '<option value="">Não foi possível carregar os planos</option>';
  }
}

document.getElementById('btn-cadastro-continuar').addEventListener('click', async () => {
  const nome = document.getElementById('cadastro-nome').value.trim();
  const cpf = document.getElementById('cadastro-cpf').value.trim();
  const telefone = document.getElementById('cadastro-telefone').value.trim();
  const email = document.getElementById('cadastro-email').value.trim();
  const dataNascimento = document.getElementById('cadastro-data-nascimento').value;
  const planoId = document.getElementById('cadastro-plano').value;
  const indicadoPorCpf = document.getElementById('cadastro-indicado-cpf').value.trim();
  const erroEl = document.getElementById('cadastro-form-erro');
  erroEl.textContent = '';

  if (!nome || !cpf || !telefone || !email || !dataNascimento || !planoId) {
    erroEl.textContent = 'Preencha nome, CPF, telefone, e-mail, data de nascimento e escolha um plano.';
    return;
  }

  try {
    const resp = await api('/api/terminal/auto-cadastro', {
      method: 'POST',
      body: JSON.stringify({
        nome,
        cpf,
        telefone,
        email,
        data_nascimento: dataNascimento,
        plano_id: planoId,
        indicado_por_cpf: indicadoPorCpf || null,
      }),
    });

    cadastroCpfAtual = cpf;

    // Fluxo "visitante" (2026-07): sem Pix/matrícula — o próprio POST já
    // devolve o cadastro concluído, então pula direto pro sucesso.
    if (resp.visitante) {
      await mostrarSucessoCadastroVisitante(resp);
      return;
    }

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

// Sucesso do cadastro de VISITANTE (2026-07) — sem Pix/matrícula, então não
// passa pelo poll de pagamento. Busca (ou gera, se ainda não tiver) o QR
// pessoal do visitante pelo mesmo endpoint usado em "Primeira vez no totem",
// pra ele já sair daqui com seu acesso pra próximas visitas dentro do limite
// (ver acessoTerminal.limiteAcessosVisitanteEm/configuracoes.visitante_limite_acessos).
async function mostrarSucessoCadastroVisitante(resp) {
  document.getElementById('painel-cadastro-form').classList.add('oculto');
  document.getElementById('painel-cadastro-sucesso').classList.remove('oculto');
  document.getElementById('cadastro-sucesso-saudacao').textContent = `Cadastro de visitante concluído! Bem-vindo(a), ${resp.aluno_nome || ''}. Procure a recepção ou aproxime-se da catraca para liberar sua entrada.`;

  const alvo = document.getElementById('qrcode-cadastro-sucesso');
  alvo.innerHTML = '';
  try {
    const codigo = await api(`/api/terminal/vincular/codigo?cpf=${encodeURIComponent(cadastroCpfAtual)}`);
    // eslint-disable-next-line no-new
    new QRCode(alvo, { text: codigo.codigo_acesso, width: 200, height: 200, colorDark: '#0f172a', colorLight: '#ffffff' });
  } catch {
    // Best-effort: se não conseguir gerar o QR agora, o visitante ainda
    // consegue entrar por CPF/reconhecimento facial normalmente — não
    // trava o fluxo de cadastro por causa disso.
  }
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
