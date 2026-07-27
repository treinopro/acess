// Reconhecimento facial "de verdade" — troca o embedding fraco do
// face-api.js (rede pequena de ~2019) pelo SFace, modelo do OpenCV Zoo
// (licença Apache-2.0, uso comercial livre — ver LICENSE em
// vendor/onnx/models/), bem mais discriminativo. Roda inteiramente no
// navegador via ONNX Runtime Web (vendor/onnx/runtime/), sem servidor novo.
//
// A detecção e os 68 pontos de referência CONTINUAM vindo do face-api.js
// (código já testado em produção, usado pelo cadastro guiado/liveness em
// facial-guiado.js) — só a etapa de RECONHECIMENTO (o embedding usado pra
// comparar/identificar) foi trocada. Deste arquivo derivamos 5 pontos
// (olhos, nariz, cantos da boca) a partir dos 68 do face-api, alinhamos o
// rosto num recorte 112x112 (mesmo algoritmo do cv::FaceRecognizerSF::
// alignCrop — ver getSimilarityTransformMatrix no código-fonte do OpenCV,
// modules/objdetect/src/face_recognize.cpp) e rodamos o SFace nesse recorte.
//
// IMPORTANTE (2026-07-27, corte seco combinado com o dono do sistema): este
// embedding é de um modelo DIFERENTE do face-api — não é comparável com os
// descritores antigos salvos no banco. A migração que zera face_descriptor
// pra todo mundo (ver scripts/) é o que força o recadastro.

let sessaoSFaceCarregando = null;
let sessaoSFace = null;

const SFACE_MODEL_URL = 'vendor/onnx/models/face_recognition_sface_2021dec_int8.onnx';
const ONNX_WASM_DIR = 'vendor/onnx/runtime/';

// O limiar de similaridade (0.363, recomendado pela própria documentação/
// demo do OpenCV Zoo — ver sface.py no repositório) é aplicado no SERVIDOR
// (FACE_MATCH_LIMIAR_COSSENO em acessoTerminal.service.js), não aqui — este
// arquivo só produz o embedding; quem decide "é a mesma pessoa" é o backend,
// que tem acesso a todos os alunos cadastrados pra comparar.

async function carregarSessaoSFace() {
  if (sessaoSFace) return sessaoSFace;
  if (sessaoSFaceCarregando) return sessaoSFaceCarregando;
  sessaoSFaceCarregando = (async () => {
    ort.env.wasm.wasmPaths = ONNX_WASM_DIR;
    // Força execução single-thread, sem Web Worker: o modo multi-thread do
    // onnxruntime-web depende de SharedArrayBuffer, que só fica disponível
    // com cabeçalhos COOP/COEP no servidor (não configurados aqui) — sem
    // isso, o modo multi-thread cai num arquivo .mjs de worker que nem foi
    // baixado pro vendor/. Modelo é pequeno (SFace int8 ~10MB), single-thread
    // já roda rápido o bastante num tablet/celular comum.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    sessaoSFace = await ort.InferenceSession.create(SFACE_MODEL_URL, {
      executionProviders: ['wasm'],
    });
    return sessaoSFace;
  })();
  return sessaoSFaceCarregando;
}

// Template de referência 112x112 do SFace/ArcFace (5 pontos: olho-esquerdo-
// na-imagem, olho-direito-na-imagem, ponta do nariz, canto-esquerdo-da-boca-
// na-imagem, canto-direito-da-boca-na-imagem — "esquerda/direita" aqui é
// posição NA IMAGEM, não anatômica da pessoa). Valores exatos copiados de
// cv::FaceRecognizerSF::getSimilarityTransformMatrix (OpenCV, mesmo arquivo
// citado acima) — não são arbitrários, têm que bater exatamente com o que o
// modelo foi treinado pra esperar.
const SFACE_TEMPLATE_112 = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

// Deriva os 5 pontos de alinhamento a partir dos 68 pontos do face-api
// (esquema iBUG/300-W padrão). "Esquerda/direita" nos nomes das variáveis é
// posição NA IMAGEM (câmera não espelhada, ver comentário sobre isso em
// facial-guiado.js) — por isso o olho que aparece do lado esquerdo da
// imagem é o pontos[36..41] (olho direito anatômico da pessoa, que fica do
// lado esquerdo de quem olha de frente pra ela), e vice-versa. Essa
// correspondência posição-na-imagem ↔ template é o que importa pro
// alinhamento, não o rótulo anatômico.
function pontos5DeLandmarks68(landmarks) {
  const pts = landmarks.positions;
  const media = (indices) => {
    const soma = indices.reduce((acc, i) => ({ x: acc.x + pts[i].x, y: acc.y + pts[i].y }), { x: 0, y: 0 });
    return { x: soma.x / indices.length, y: soma.y / indices.length };
  };
  const olhoImagemEsquerda = media([36, 37, 38, 39, 40, 41]);
  const olhoImagemDireita = media([42, 43, 44, 45, 46, 47]);
  const nariz = pts[30];
  const bocaImagemEsquerda = pts[48];
  const bocaImagemDireita = pts[54];
  return [
    [olhoImagemEsquerda.x, olhoImagemEsquerda.y],
    [olhoImagemDireita.x, olhoImagemDireita.y],
    [nariz.x, nariz.y],
    [bocaImagemEsquerda.x, bocaImagemEsquerda.y],
    [bocaImagemDireita.x, bocaImagemDireita.y],
  ];
}

// Ajuste de transformação de similaridade (rotação + escala uniforme +
// translação, sem espelhamento) por mínimos quadrados entre os 5 pontos de
// origem e o template de destino — equivalente ao resultado do algoritmo de
// Umeyama usado pelo OpenCV (getSimilarityTransformMatrix) pro caso 2D sem
// reflexão, só que resolvido em forma fechada via número complexo (rotação+
// escala uniforme = multiplicação por um único número complexo w = a+ib):
// minimizar a soma de |z_origem_i * w - z_destino_i|² dá w = Σ(conj(z_i)·z'_i)
// / Σ|z_i|², com z_i = ponto demediado como número complexo x+iy. Retorna
// {a, b, tx, ty} tal que x' = a·x - b·y + tx e y' = b·x + a·y + ty.
function ajustarTransformacaoSimilaridade(origem, destino) {
  const n = origem.length;
  let mx = 0, my = 0, mx2 = 0, my2 = 0;
  for (let i = 0; i < n; i++) { mx += origem[i][0]; my += origem[i][1]; mx2 += destino[i][0]; my2 += destino[i][1]; }
  mx /= n; my /= n; mx2 /= n; my2 /= n;

  let num_a = 0, num_b = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = origem[i][0] - mx, dy = origem[i][1] - my;
    const dx2 = destino[i][0] - mx2, dy2 = destino[i][1] - my2;
    num_a += dx * dx2 + dy * dy2;
    num_b += dx * dy2 - dy * dx2;
    den += dx * dx + dy * dy;
  }
  const a = num_a / den;
  const b = num_b / den;
  const tx = mx2 - a * mx + b * my;
  const ty = my2 - b * mx - a * my;
  return { a, b, tx, ty };
}

// Recorta e alinha o rosto num canvas 112x112, a partir da fonte (vídeo ou
// canvas de processamento) e dos 68 landmarks do face-api. Espelha
// exatamente o warpAffine do OpenCV (mesmo template, mesma ideia de
// transformação), só que via canvas 2D em vez de OpenCV nativo.
function alinharRosto112(fonte, landmarks) {
  const pontosOrigem = pontos5DeLandmarks68(landmarks);
  const { a, b, tx, ty } = ajustarTransformacaoSimilaridade(pontosOrigem, SFACE_TEMPLATE_112);

  const destino = document.createElement('canvas');
  destino.width = 112;
  destino.height = 112;
  const ctx = destino.getContext('2d');
  // canvas setTransform(m11, m12, m21, m22, dx, dy): x' = m11 x + m21 y + dx,
  // y' = m12 x + m22 y + dy — bate com x' = a x - b y + tx, y' = b x + a y + ty.
  ctx.setTransform(a, b, -b, a, tx, ty);
  ctx.drawImage(fonte, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return destino;
}

// Monta o tensor NCHW [1,3,112,112] esperado pelo SFace a partir do canvas
// alinhado. Mesma receita de pré-processamento do cv::dnn::blobFromImage
// usado internamente pelo FaceRecognizerSF::feature (scalefactor=1 — valores
// 0-255 crus, sem normalizar —, sem subtrair média, swapRB=true). Como o
// canvas já entrega os pixels em RGB (não BGR, ao contrário de um Mat do
// OpenCV), NÃO precisamos trocar canais — já é equivalente ao resultado de
// swapRB=true a partir de uma imagem BGR.
function construirTensorEntrada(canvas112) {
  const ctx = canvas112.getContext('2d');
  const { data } = ctx.getImageData(0, 0, 112, 112); // RGBA, 112*112*4 bytes
  const chw = new Float32Array(3 * 112 * 112);
  const hw = 112 * 112;
  for (let p = 0; p < hw; p++) {
    chw[p] = data[p * 4]; // R
    chw[hw + p] = data[p * 4 + 1]; // G
    chw[2 * hw + p] = data[p * 4 + 2]; // B
  }
  return new ort.Tensor('float32', chw, [1, 3, 112, 112]);
}

function normalizarL2(vetor) {
  let soma = 0;
  for (let i = 0; i < vetor.length; i++) soma += vetor[i] * vetor[i];
  const norma = Math.sqrt(soma) || 1;
  return Array.from(vetor, (v) => v / norma);
}

// Função principal: dado o frame fonte (vídeo/canvas já usado pelo face-api)
// e uma detecção do face-api já com .landmarks, devolve o embedding SFace
// (array de 128 números, já normalizado L2 — comparar por produto escalar
// direto dá a similaridade de cosseno; quem faz essa comparação é o servidor,
// ver FACE_MATCH_LIMIAR_COSSENO em acessoTerminal.service.js).
async function obterEmbeddingSFace(fonte, deteccaoComLandmarks) {
  const sessao = await carregarSessaoSFace();
  const canvas112 = alinharRosto112(fonte, deteccaoComLandmarks.landmarks);
  const tensor = construirTensorEntrada(canvas112);
  const saida = await sessao.run({ [sessao.inputNames[0]]: tensor });
  const embeddingBruto = saida[sessao.outputNames[0]].data;
  return normalizarL2(embeddingBruto);
}
