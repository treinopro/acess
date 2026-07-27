// Mecanismo ÚNICO de reconhecimento facial, compartilhado pelo totem, pelo
// portal remoto e pelo cadastro pelo celular. 2026-07-27: até então só o
// totem tinha o cadastro guiado (liveness, estilo Face ID do iPhone) — o
// portal e o cadastro pelo celular cadastravam o rosto na primeira detecção
// "crua" (sem liveness, sem checagem de qualidade), o que fazia o mecanismo
// divergir entre os três lugares e produzia descritores de qualidade bem
// mais baixa quando o cadastro era feito fora do totem. Ver também a
// checagem de qualidade no reconhecimento do dia a dia mais abaixo, que
// ataca o segundo problema relatado (rosto parcial/de lado sendo confundido
// com outro aluno).

const FACE_MODELS_URL = 'vendor/face-api/weights';

// ---------------- Motor de cálculo do TensorFlow.js ----------------
let motorTensorflowAtivo = 'desconhecido';
async function prepararMotorTensorflow() {
  try {
    if (faceapi.tf && typeof faceapi.tf.setBackend === 'function') {
      await faceapi.tf.setBackend('webgl');
      await faceapi.tf.ready();
    }
  } catch {
    // sem WebGL disponível, o TensorFlow.js cai pro backend "cpu" sozinho —
    // mais lento, mas não é um erro fatal.
  }
  motorTensorflowAtivo = (faceapi.tf && faceapi.tf.getBackend && faceapi.tf.getBackend()) || 'desconhecido';
}

let modelosFaciaisCarregados = false;
let modelosFaciaisCarregando = null;
async function carregarModelosFaciais() {
  if (modelosFaciaisCarregados) return;
  if (modelosFaciaisCarregando) return modelosFaciaisCarregando;
  modelosFaciaisCarregando = (async () => {
    await prepararMotorTensorflow();
    await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
    // faceRecognitionNet do face-api NÃO é mais carregado — o embedding
    // usado pra cadastro/reconhecimento agora é o SFace (ver
    // facial-sface.js); os 68 landmarks aqui continuam servindo pra pose
    // (liveness) e pro alinhamento que o SFace precisa.
    await carregarSessaoSFace();
    modelosFaciaisCarregados = true;
  })();
  return modelosFaciaisCarregando;
}

// inputSize menor (padrão do face-api é 416) = a rede analisa uma versão bem
// menor de cada quadro — muito mais rápido, com perda de precisão pequena o
// bastante pra alguém posicionado perto da câmera (totem, celular ou webcam
// do notebook). Mesma calibração em todo lugar que usa este módulo.
const OPCOES_DETECTOR_FACIAL = new faceapi.TinyFaceDetectorOptions({ inputSize: 160 });

// Não pede mais .withFaceDescriptor() — o embedding usado de verdade agora
// vem do SFace (obterEmbeddingSFace, em facial-sface.js), que só precisa dos
// landmarks (pra alinhar o recorte 112x112). Evita gastar o forward pass do
// antigo faceRecognitionNet à toa em todo quadro.
async function detectarRostoComLandmarks(fonte) {
  return faceapi.detectSingleFace(fonte, OPCOES_DETECTOR_FACIAL).withFaceLandmarks();
}

// Só a etapa barata (acha a caixa do rosto, sem landmarks/descritor) — usada
// pra decidir se vale a pena pagar o custo da etapa pesada.
async function temRostoNoQuadro(fonte) {
  const caixa = await faceapi.detectSingleFace(fonte, OPCOES_DETECTOR_FACIAL);
  return Boolean(caixa);
}

function mediaPontosFaciais(pontos) {
  const soma = pontos.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: soma.x / pontos.length, y: soma.y / pontos.length };
}

// Estima a pose (giro horizontal, inclinação vertical, tamanho aparente do
// rosto no quadro) a partir dos 68 pontos de referência do face-api —
// aproximação leve o bastante pra rodar em tempo real, longe da precisão de
// um modelo 3D de pose, mas suficiente tanto pra guiar o cadastro (relativo
// à própria pessoa) quanto pra filtrar reconhecimentos de baixa confiança
// (limiares absolutos, ver qualidadeDeteccaoParaReconhecimento abaixo).
function calcularPoseFacial(deteccao) {
  const pts = deteccao.landmarks.positions;
  const jawEsq = pts[0];
  const jawDir = pts[16];
  const baseNariz = pts[33];
  const queixo = pts[8];
  const olhoEsq = mediaPontosFaciais(pts.slice(36, 42));
  const olhoDir = mediaPontosFaciais(pts.slice(42, 48));

  const larguraRosto = Math.hypot(jawDir.x - jawEsq.x, jawDir.y - jawEsq.y) || 1;
  const meioJawX = (jawEsq.x + jawDir.x) / 2;
  const yaw = (baseNariz.x - meioJawX) / larguraRosto;

  const linhaOlhosY = (olhoEsq.y + olhoDir.y) / 2;
  const alturaRosto = Math.abs(queixo.y - linhaOlhosY) || 1;
  const pitch = (baseNariz.y - linhaOlhosY) / alturaRosto;

  return { yaw, pitch, tamanho: larguraRosto };
}

// ---------------- Checagem de qualidade no reconhecimento do dia a dia ----------------
// 2026-07-27: o escaneamento contínuo do totem mandava QUALQUER rosto
// detectado direto pro reconhecimento — inclusive um rosto parcial, de lado
// ou muito longe, que ainda assim passa pelo TinyFaceDetector e gera um
// descritor "válido", só que pouco confiável. Foi assim que aconteceu o caso
// relatado (mostrando só a parte de cima da cabeça, o sistema reconheceu
// outro aluno): o problema não é só o limiar de distância entre descritores
// (FACE_MATCH_THRESHOLD, ver acessoTerminal.service.js) — um descritor
// gerado a partir de um enquadramento ruim já não é confiável pra comparar
// com ninguém. Esta checagem roda ANTES de mandar qualquer descritor pro
// servidor comparar; se não passar, o quadro é descartado e a pessoa
// continua sendo escaneada normalmente (sem travar, sem pedir nada demais de
// quem já está bem posicionado).
const CONFIANCA_MINIMA_DETECCAO = 0.7;
const LARGURA_MINIMA_ROSTO_FRACAO = 0.16; // rosto precisa ocupar pelo menos ~16% da largura do quadro
const PROPORCAO_MIN_CAIXA_ROSTO = 0.6; // largura/altura da caixa — um rosto de verdade fica nessa faixa
const PROPORCAO_MAX_CAIXA_ROSTO = 1.35;
const YAW_MAXIMO_RECONHECIMENTO = 0.32; // limiar absoluto (sem calibração por pessoa, ao contrário do cadastro guiado)
const PITCH_MAXIMO_RECONHECIMENTO = 0.32;

function qualidadeDeteccaoParaReconhecimento(deteccao, larguraQuadro) {
  const caixa = deteccao.detection ? deteccao.detection.box : deteccao.box;
  const score = deteccao.detection ? deteccao.detection.score : deteccao.score;

  if (typeof score === 'number' && score < CONFIANCA_MINIMA_DETECCAO) {
    return { ok: false, motivo: 'confianca_baixa' };
  }
  if (!caixa || !larguraQuadro) return { ok: true, motivo: null }; // sem info suficiente pra recusar, deixa passar

  if (caixa.width / larguraQuadro < LARGURA_MINIMA_ROSTO_FRACAO) {
    return { ok: false, motivo: 'rosto_pequeno_ou_longe' };
  }
  const proporcao = caixa.width / caixa.height;
  if (proporcao < PROPORCAO_MIN_CAIXA_ROSTO || proporcao > PROPORCAO_MAX_CAIXA_ROSTO) {
    return { ok: false, motivo: 'rosto_parcial_ou_mal_enquadrado' };
  }

  const pose = calcularPoseFacial(deteccao);
  if (Math.abs(pose.yaw) > YAW_MAXIMO_RECONHECIMENTO || Math.abs(pose.pitch) > PITCH_MAXIMO_RECONHECIMENTO) {
    return { ok: false, motivo: 'rosto_de_lado_ou_inclinado' };
  }

  return { ok: true, motivo: null };
}

// ---------------- Cadastro facial guiado (liveness, estilo Face ID) ----------------
// Em vez de capturar o rosto assim que a primeira detecção válida aparece,
// guia a pessoa por uma sequência de poses (virar a cabeça pros dois lados,
// aproximar/afastar do círculo, levantar/abaixar o queixo) antes de capturar
// de fato — mesma ideia do cadastro de Face ID do iPhone. Dificulta
// "cadastrar" uma foto impressa ou a tela de outro celular no lugar de um
// rosto de verdade, e garante que o cadastro sempre termina com a pessoa de
// frente e centralizada (melhor qualidade pro reconhecimento do dia a dia).
//
// Cada passo compara a pose ATUAL contra uma referência tirada no passo
// "centro" — não usa ângulos fixos em graus, porque cada rosto/câmera/
// distância é diferente; calibrar relativo à própria pessoa, no início da
// sequência, é bem mais confiável que um limiar absoluto universal.
const PASSOS_CAPTURA_GUIADA = [
  { id: 'centro', instrucao: 'Centralize seu rosto no círculo e fique parado...' },
  { id: 'giro1', instrucao: 'De frente para a câmera, vire o rosto para um dos lados' },
  { id: 'giro2', instrucao: 'Agora vire para o lado oposto' },
  { id: 'perto', instrucao: 'Volte a olhar de frente e aproxime seu rosto do círculo' },
  { id: 'longe', instrucao: 'Agora afaste um pouco o rosto, sem sair do quadro' },
  { id: 'cima', instrucao: 'Olhando de frente, levante um pouco o queixo' },
  { id: 'baixo', instrucao: 'Agora abaixe um pouco o queixo' },
  { id: 'final', instrucao: 'Perfeito! Volte a olhar de frente, centralizado...' },
];

const QUADROS_PARA_CONFIRMAR_PASSO_FACIAL = 2; // "segura" a pose por 2 detecções seguidas antes de avançar
const TIMEOUT_POR_PASSO_FACIAL_MS = 6000; // não conseguiu cumprir o passo? pula sozinho — nunca trava o cadastro

// Decide se o passo atual foi cumprido, sempre relativo à pose de referência
// (capturada no passo "centro"). Limiares generosos de propósito — o
// objetivo é confirmar um movimento real, não medir com precisão. Efeito
// colateral de propósito: ao confirmar "giro1", grava em `contexto` pra que
// "giro2" saiba exigir o sentido OPOSTO do giro que já foi feito.
function passoFacialCumprido(passoId, poseAtual, poseBase, contexto) {
  if (!poseBase) return false;
  const deltaYaw = poseAtual.yaw - poseBase.yaw;
  const deltaPitch = poseAtual.pitch - poseBase.pitch;
  const razaoTamanho = poseAtual.tamanho / poseBase.tamanho;

  switch (passoId) {
    case 'giro1':
      if (Math.abs(deltaYaw) > 0.09) {
        contexto.direcaoGiro1 = Math.sign(deltaYaw);
        return true;
      }
      return false;
    case 'giro2':
      return Math.abs(deltaYaw) > 0.09 && Math.sign(deltaYaw) !== contexto.direcaoGiro1;
    case 'perto':
      return razaoTamanho > 1.10;
    case 'longe':
      return razaoTamanho < 0.90;
    case 'cima':
      return deltaPitch < -0.09;
    case 'baixo':
      return deltaPitch > 0.09;
    case 'final':
      return Math.abs(deltaYaw) < 0.1 && Math.abs(deltaPitch) < 0.12 && razaoTamanho > 0.8 && razaoTamanho < 1.2;
    default:
      return false;
  }
}

// Conduz a sequência de PASSOS_CAPTURA_GUIADA acima e, ao final, chama
// `enviarDescritor` (fornecido por quem chamou — totem/portal/cadastro pelo
// celular postam pra endpoints/payloads diferentes) com o array de 128
// números do descritor facial. Não mexe em câmera nem em navegação entre
// telas — isso continua responsabilidade de cada chamador.
//
// `circulo` e `barraProgresso` são localizados automaticamente a partir do
// `video`/`statusEl` (mesma estrutura de HTML usada em todo lugar: um
// `.video-wrap` com o círculo de guia dentro, e uma `.guia-facial-progresso-
// barra` como irmã do `statusEl`) — cada chamador só passa video/statusEl.
async function executarCadastroFacialGuiado({
  video, statusEl, elementoCameraPronto, desenharQuadro, enviarDescritor, aoConcluir,
}) {
  const _elementoCameraPronto = elementoCameraPronto || ((el) => el.readyState === el.HAVE_ENOUGH_DATA);
  const _desenharQuadro = desenharQuadro || ((el) => el);
  const circulo = video.closest('.video-wrap')?.querySelector('.guia-facial-circulo') || null;
  const barraProgresso = statusEl.parentElement?.querySelector('.guia-facial-progresso-barra') || null;

  if (barraProgresso) barraProgresso.style.width = '0%';
  if (circulo) circulo.classList.remove('guia-ativo', 'guia-ok');

  let passoAtual = 0;
  let poseBase = null;
  let quadrosConfirmandoPasso = 0;
  let inicioPassoEm = Date.now();
  const contexto = { direcaoGiro1: 0 };

  function atualizarUI() {
    const passo = PASSOS_CAPTURA_GUIADA[passoAtual];
    if (!passo) return;
    statusEl.textContent = passo.instrucao;
    if (barraProgresso) {
      const pct = Math.round((passoAtual / (PASSOS_CAPTURA_GUIADA.length - 1)) * 100);
      barraProgresso.style.width = `${pct}%`;
    }
  }
  atualizarUI();

  function marcarPassoOk() {
    if (!circulo) return;
    circulo.classList.remove('guia-ativo');
    circulo.classList.add('guia-ok');
    setTimeout(() => circulo.classList.remove('guia-ok'), 300);
  }

  function avancarPasso() {
    quadrosConfirmandoPasso = 0;
    inicioPassoEm = Date.now();
    passoAtual += 1;
    atualizarUI();
  }

  async function concluirCaptura(deteccaoFinal, quadroFinal) {
    statusEl.textContent = 'Cadastrando...';
    try {
      // 2026-07-27: o descritor enviado ao servidor não é mais o do face-api
      // (rede pequena, pouco discriminativa) — é o embedding do SFace
      // (OpenCV Zoo), calculado em cima do mesmo rosto/landmarks já
      // detectados aqui. Ver facial-sface.js para o porquê da troca.
      const embedding = await obterEmbeddingSFace(quadroFinal, deteccaoFinal);
      await enviarDescritor(embedding);
      statusEl.textContent = 'Rosto cadastrado com sucesso!';
      if (barraProgresso) barraProgresso.style.width = '100%';
      if (aoConcluir) setTimeout(aoConcluir, 2500);
    } catch (err2) {
      statusEl.textContent = `Erro ao cadastrar: ${err2.message}`;
    } finally {
      passoAtual = PASSOS_CAPTURA_GUIADA.length; // sinaliza pro loop parar de reagendar
    }
  }

  const tick = async () => {
    // TUDO fica dentro do try, e o próximo quadro é sempre reagendado no
    // finally — um erro pontual (frame instável, canvas indisponível por um
    // instante) nunca deve travar o cadastro guiado pra sempre.
    try {
      if (!_elementoCameraPronto(video)) return;

      const quadro = _desenharQuadro(video);
      let deteccao = null;
      let rostoPresente = false;
      try {
        rostoPresente = await temRostoNoQuadro(quadro);
      } catch {
        // ignora erro pontual da detecção barata
      }
      if (rostoPresente) {
        try {
          deteccao = await detectarRostoComLandmarks(quadro);
        } catch {
          // ignora erro pontual da etapa pesada
        }
      }

      if (!deteccao) {
        quadrosConfirmandoPasso = 0;
        if (circulo) circulo.classList.remove('guia-ativo');
        return;
      }

      const pose = calcularPoseFacial(deteccao);
      const passo = PASSOS_CAPTURA_GUIADA[passoAtual];
      if (!passo) return; // já concluído/cancelado

      if (passo.id === 'centro') {
        // Passo inicial: a própria pose vira a referência — só precisa
        // segurar parado por alguns quadros seguidos pra calibrar direito
        // (evita calibrar em cima de um quadro tremido/borrado).
        poseBase = pose;
        quadrosConfirmandoPasso += 1;
        if (circulo) circulo.classList.add('guia-ativo');
        if (quadrosConfirmandoPasso >= QUADROS_PARA_CONFIRMAR_PASSO_FACIAL) {
          marcarPassoOk();
          avancarPasso();
        } else if (Date.now() - inicioPassoEm > TIMEOUT_POR_PASSO_FACIAL_MS) {
          await concluirCaptura(deteccao, quadro);
        }
        return;
      }

      const cumprido = passoFacialCumprido(passo.id, pose, poseBase, contexto);

      if (passo.id === 'final') {
        if (cumprido) {
          quadrosConfirmandoPasso += 1;
          if (circulo) circulo.classList.add('guia-ativo');
          if (quadrosConfirmandoPasso >= QUADROS_PARA_CONFIRMAR_PASSO_FACIAL) {
            await concluirCaptura(deteccao, quadro);
          }
        } else {
          quadrosConfirmandoPasso = 0;
          if (circulo) circulo.classList.remove('guia-ativo');
          // Mesma rede de segurança dos passos de movimento: se a pessoa não
          // conseguir voltar exatamente pro centro, captura com a última
          // detecção válida em vez de travar o cadastro na última tela.
          if (Date.now() - inicioPassoEm > TIMEOUT_POR_PASSO_FACIAL_MS) {
            await concluirCaptura(deteccao, quadro);
          }
        }
        return;
      }

      if (cumprido) {
        quadrosConfirmandoPasso += 1;
        if (circulo) circulo.classList.add('guia-ativo');
        if (quadrosConfirmandoPasso >= QUADROS_PARA_CONFIRMAR_PASSO_FACIAL) {
          marcarPassoOk();
          avancarPasso();
        }
      } else {
        quadrosConfirmandoPasso = 0;
        if (circulo) circulo.classList.remove('guia-ativo');
        // Passo demorando demais (câmera ruim, ângulo difícil pra essa
        // pessoa/aparelho): pula sozinho em vez de travar o cadastro pra
        // sempre — melhor terminar sem 100% da sequência do que deixar a
        // pessoa presa numa tela sem conseguir continuar.
        if (Date.now() - inicioPassoEm > TIMEOUT_POR_PASSO_FACIAL_MS) {
          avancarPasso();
        }
      }
    } catch (err) {
      console.error('Erro num ciclo do cadastro facial guiado (ignorado — tentando de novo):', err);
    } finally {
      if (passoAtual < PASSOS_CAPTURA_GUIADA.length) {
        setTimeout(tick, 400);
      }
    }
  };
  tick();
}
