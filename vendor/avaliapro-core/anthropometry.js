'use strict';

// ─────────────────────────────────────────────────────────────────
// CÓPIA VENDORIZADA — origem: avaliapro/src/core/anthropometry.js
//
// Este arquivo NÃO é editado aqui. O AvaliaPro (projeto irmão, fora
// deste repositório — D:\Meus documentos\Downloads\avaliapro, ainda sem
// git próprio) é a fonte de verdade; esta cópia existe só porque o
// deploy na nuvem do academia-gestao não tem acesso a essa outra pasta
// do notebook, e `alunos.routes.js` precisa de `computeForTipo` para
// gravar avaliação física sem duplicar as fórmulas à mão.
//
// Se as equações do AvaliaPro mudarem (nova faixa de classificação,
// correção de coeficiente etc.), esta cópia precisa ser atualizada à
// mão — copie o arquivo de novo por inteiro, não edite os dois
// separadamente. Autocontido de propósito: zero `require`, então
// colar por cima nunca quebra por causa de um import que mudou.
//
// Núcleo de cálculo antropométrico.
//
// Portado de treinopro/server.js:968 (`computeForTipo`). As fórmulas
// foram copiadas com os coeficientes idênticos, dígito por dígito, e
// estão travadas por testes numéricos em avaliapro/tests/anthropometry.test.js
// — diferente do TreinoPro, cujos testes verificam se um trecho de
// texto existe no HTML e por isso passam mesmo com a matemática errada.
//
// Referências das equações:
//   • Jackson & Pollock (1978), homens — 3 e 7 dobras
//   • Jackson, Pollock & Ward (1980), mulheres — 3 e 7 dobras
//   • Siri (1961) — conversão de densidade corporal em % de gordura
// ─────────────────────────────────────────────────────────────────

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function imcLabel(imc) {
  if (!imc) return '';
  if (imc < 18.5) return 'Abaixo do peso';
  if (imc < 25) return 'Peso normal';
  if (imc < 30) return 'Sobrepeso';
  return 'Obeso';
}

// Média das duas leituras da mesma dobra, quando a segunda existe.
// Uma leitura só continua valendo — registros antigos (e importados do
// TreinoPro sem a 2ª medida) calculam exatamente como antes.
function foldAvg(f, id) {
  const a = Number(f[id]);
  const b = Number(f[id + '_2']);
  const hasA = f[id] != null && f[id] !== '' && Number.isFinite(a);
  const hasB = f[id + '_2'] != null && f[id + '_2'] !== '' && Number.isFinite(b);
  if (hasA && hasB) return (a + b) / 2;
  return hasA ? a : (hasB ? b : 0);
}

// Coeficiente de variação entre as duas leituras da mesma dobra, em %.
// Acima de 5% a prática da avaliação física manda remedir o ponto — é o
// princípio do Erro Técnico de Medida (ETM). Retorna null quando não há
// as duas leituras (sem segunda medida não há dispersão a calcular).
function foldCv(f, id) {
  const a = parseFloat(f[id]);
  const b = parseFloat(f[id + '_2']);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const mean = (a + b) / 2;
  if (!mean) return null;
  // Desvio-padrão amostral de duas observações = |a-b| / √2.
  const sd = Math.abs(a - b) / Math.SQRT2;
  return Math.round((sd / mean) * 1000) / 10;
}

const LIMITE_CV_DOBRA = 5;

// Densidade corporal por Jackson & Pollock. Isolada de `computeForTipo`
// para poder ser testada sozinha contra os valores publicados.
function densidadeCorporal(protocolo, soma, sexo, idade) {
  const m = sexo === 'M';
  if (protocolo === '3dobras') {
    return m
      ? 1.10938 - 0.0008267 * soma + 0.0000016 * soma ** 2 - 0.0002574 * idade
      : 1.0994921 - 0.0009929 * soma + 0.0000023 * soma ** 2 - 0.0001392 * idade;
  }
  if (protocolo === '5dobras') {
    return m
      ? 1.1099 - 0.0007619 * soma + 0.0000023 * soma ** 2 - 0.0001392 * idade
      : 1.089733 - 0.0009245 * soma + 0.0000025 * soma ** 2 - 0.0000979 * idade;
  }
  // 7 dobras
  return m
    ? 1.112 - 0.00043499 * soma + 0.00000055 * soma ** 2 - 0.00028826 * idade
    : 1.097 - 0.00046971 * soma + 0.00000056 * soma ** 2 - 0.00012828 * idade;
}

// Siri (1961): %G = (495 / densidade) − 450.
const siri = (bd) => (bd ? round1((495 / bd) - 450) : 0);

// Classificação do percentual de gordura (ACSM). Não existe no
// TreinoPro — lá o número aparece cru. Um %BF sem faixa de referência
// não diz nada ao avaliado, e é a primeira pergunta que ele faz.
const FAIXAS_BF = {
  M: [[6, 'Essencial'], [14, 'Atlético'], [18, 'Bom'], [25, 'Aceitável'], [Infinity, 'Elevado']],
  F: [[14, 'Essencial'], [21, 'Atlético'], [25, 'Bom'], [32, 'Aceitável'], [Infinity, 'Elevado']],
};

function bfLabel(bf, sexo) {
  if (!bf) return '';
  const faixas = FAIXAS_BF[sexo === 'M' ? 'M' : 'F'];
  for (const [limite, label] of faixas) {
    if (bf < limite) return label;
  }
  return '';
}

// Risco cardiovascular pela relação cintura-quadril (OMS).
function rcqLabel(rcq, sexo) {
  if (!rcq) return '';
  const limite = sexo === 'M' ? 0.9 : 0.85;
  return rcq > limite ? 'Risco aumentado' : 'Risco baixo';
}

const PARQ_KEYS = [
  'cardiaco', 'dorPeitoAtividade', 'dorPeitoRepouso', 'equilibrio',
  'ossosArticulacoes', 'medicamento', 'outroMotivo',
];

const ANAMNESE_RISK_KEYS = ['historico', 'cirurgias', 'medicamentos', 'lesoes'];

function isEmptyOrNegative(v) {
  if (!v) return true;
  const t = String(v).trim().toLowerCase();
  return !t || ['não', 'nao', 'n/a', 'na', 'nenhum', 'nenhuma', '-', 'sem'].includes(t);
}

// Calcula os valores derivados de uma avaliação. Recebe os campos
// medidos e devolve só o que é fórmula — nunca sobrescreve medida.
function computeForTipo(tipo, f, protocolo) {
  f = f || {};
  const out = {};

  if (tipo === 'Antropometria') {
    const peso = Number(f.peso) || 0;
    const alt = Number(f.altura) || 0;
    out.imc = alt ? round1(peso / ((alt / 100) ** 2)) : 0;
    out.imcLabel = imcLabel(out.imc);

  } else if (tipo === 'Adipometria') {
    const sexo = f.sexo === 'M' ? 'M' : 'F';
    const idade = Number(f.idade) || 0;
    const proto = protocolo || '7dobras';

    const pontos = proto === '3dobras'
      ? ['dobra1', 'dobra2', 'dobra3']
      : proto === '5dobras'
        ? ['peitoral', 'abdominal', 'coxa', 'suprailiaca', 'axilar']
        : ['peitoral', 'triceps', 'subescapular', 'suprailiaca', 'abdominal', 'coxa', 'axilar'];

    const soma = pontos.reduce((s, id) => s + foldAvg(f, id), 0);
    const bd = densidadeCorporal(proto, soma, sexo, idade);

    out.somaDobras = round1(soma);
    out.densidade = bd ? Math.round(bd * 100000) / 100000 : 0;
    out.bf = siri(bd);
    out.bfLabel = bfLabel(out.bf, sexo);

    const p = Number(f.peso) || 0;
    const alt = Number(f.altura) || 0;
    out.imc = alt ? round1(p / ((alt / 100) ** 2)) : 0;
    out.imcLabel = imcLabel(out.imc);

    // Massa gorda e massa magra em kg. Não existem no TreinoPro, mas
    // são o que o avaliado entende: "perdeu 2,1 kg de gordura e manteve
    // a massa magra" comunica muito mais que "%BF caiu 2,4 pontos".
    if (p && out.bf) {
      out.massaGorda = round1(p * (out.bf / 100));
      out.massaMagra = round1(p - out.massaGorda);
    }

    // Dobras cuja repetição divergiu acima do limite. A tela usa isto
    // para marcar o ponto como "vale remedir".
    const dispersas = pontos.filter((id) => {
      const cv = foldCv(f, id);
      return cv != null && cv > LIMITE_CV_DOBRA;
    });
    if (dispersas.length) out.dobrasDispersas = dispersas;

  } else if (tipo === 'Perimetria') {
    const cint = Number(f.cintura) || 0;
    const quad = Number(f.quadril) || 0;
    out.rcq = quad ? round2(cint / quad) : 0;
    out.rcqLabel = rcqLabel(out.rcq, f.sexo);

  } else if (tipo === 'Bioimpedância') {
    out.bf = Number(f.gordura) || 0;
    out.bfLabel = bfLabel(out.bf, f.sexo);
    const p = Number(f.peso) || 0;
    if (p && out.bf) {
      out.massaGorda = round1(p * (out.bf / 100));
      out.massaMagra = round1(p - out.massaGorda);
    }

  } else if (tipo === 'Autoavaliação') {
    const cint = Number(f.cintura) || 0;
    const quad = Number(f.quadril) || 0;
    if (cint && quad) out.rcq = round2(cint / quad);

  } else if (tipo === 'Par-Q') {
    // Qualquer "sim" sinaliza recomendação de avaliação médica antes de
    // liberar treino sem restrição.
    out.recomendacaoMedica = PARQ_KEYS.some((k) => f[k] === 'sim');
    out.respostasSim = PARQ_KEYS.filter((k) => f[k] === 'sim');

  } else if (tipo === 'Anamnese') {
    // Anamnese é texto livre — sem pergunta sim/não como o Par-Q. Uma
    // heurística simples (sem gastar IA nisso) cobre o caso comum: se o
    // avaliado relatou algo nos campos de saúde, vale destacar para
    // revisão, mesmo que não seja necessariamente grave.
    out.recomendacaoMedica = ANAMNESE_RISK_KEYS.some((k) => !isEmptyOrNegative(f[k]));
  }

  return out;
}

module.exports = {
  computeForTipo,
  foldAvg,
  foldCv,
  densidadeCorporal,
  siri,
  imcLabel,
  bfLabel,
  rcqLabel,
  round1,
  round2,
  LIMITE_CV_DOBRA,
  PARQ_KEYS,
};
