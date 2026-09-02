// Portal remoto do aluno — mesma essência do totem (cadastro, cadastro facial,
// pagamento via CPF, consulta de treino), acessado de fora da academia. NUNCA
// aciona a catraca (ver aviso no topo de src/routes/portal.routes.js).

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error(dados.erro || dados.motivo || 'Erro na requisição.');
    erro.dados = dados; // preserva campos extras (ex.: precisa_senha) pra quem chamou decidir o que fazer
    throw erro;
  }
  return dados;
}

function mostrarPagina(id) {
  document.querySelectorAll('.pagina').forEach((p) => p.classList.remove('ativa'));
  document.getElementById(id).classList.add('ativa');
  irParaTopo();
}

// 2026-08-14: os painéis do hub (contas, treino, avaliações, notificações
// etc.) são mostrados/escondidos com classe CSS na MESMA página — não é
// navegação de verdade, então o navegador nunca reseta a rolagem sozinho.
// Sem isso, trocar de painel enquanto a rolagem está lá embaixo (ex.: o
// aluno rolou até o fim do dashboard) faz o painel novo abrir com a
// rolagem ainda lá embaixo — pro aluno parece que a tela abriu vazia, tendo
// que rolar pra cima pra ver o conteúdo de verdade.
// 2026-08-27: quem rola de verdade agora é #scroll-raiz (wrapper interno),
// não mais window/body — ver comentário grande em portal.html sobre por que
// o body virou position:fixed (2 tentativas anteriores, só com CSS de
// scroll no body, não resolveram o PWA "sambando pros lados" no iOS
// standalone de vez). Ainda assim zera scrollLeft/scrollTop tanto na hora
// quanto no próximo frame — não custa reforçar mesmo com o body travado.
function irParaTopo() {
  const raiz = document.getElementById('scroll-raiz');
  if (!raiz) return;
  raiz.scrollTo(0, 0);
  requestAnimationFrame(() => raiz.scrollTo(0, 0));
}

function formatarMoeda(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Banners/avisos do admin (2026-08-14, ver Recuperação de Clientes >
// Banners) — mostrados como um feed no topo do dashboard. "Some 1h depois
// de aberto" é decidido inteiramente aqui no cliente (localStorage por
// banner id, guardando quando o aluno viu pela primeira vez): o servidor
// sempre devolve todos os banners ativos aplicáveis, o filtro de "já passou
// 1h" é só visual, não precisa de round-trip nem de estado no servidor.
// ---------------------------------------------------------------------------
const CHAVE_BANNERS_VISTOS = 'academia_banners_vistos';
const BANNER_DURACAO_VISIVEL_MS = 60 * 60 * 1000; // 1h

function bannersVistosStorage() {
  try { return JSON.parse(localStorage.getItem(CHAVE_BANNERS_VISTOS) || '{}'); } catch { return {}; }
}

function marcarBannerVisto(bannerId) {
  const vistos = bannersVistosStorage();
  if (vistos[bannerId]) return; // já marcado — não reinicia a contagem de 1h a cada reload
  vistos[bannerId] = Date.now();
  try { localStorage.setItem(CHAVE_BANNERS_VISTOS, JSON.stringify(vistos)); } catch { /* localStorage indisponível (modo privado etc.) — sem persistência, sem quebrar o resto */ }
}

/** Fechar manualmente conta como "já passou da 1h" — evita o banner reaparecer no mesmo login/reload logo depois de fechado. */
function suprimirBanner(bannerId) {
  const vistos = bannersVistosStorage();
  vistos[bannerId] = Date.now() - BANNER_DURACAO_VISIVEL_MS - 1;
  try { localStorage.setItem(CHAVE_BANNERS_VISTOS, JSON.stringify(vistos)); } catch { /* idem acima */ }
}

async function carregarBannersHub() {
  const container = document.getElementById('feed-banners-hub');
  if (!container || !cpfHubAtual || !senhaHubAtual) return;
  try {
    const resp = await api(`/api/portal/banners?cpf=${encodeURIComponent(cpfHubAtual)}&senha=${encodeURIComponent(senhaHubAtual)}`);
    const vistos = bannersVistosStorage();
    const agora = Date.now();
    const visiveis = (resp.banners || []).filter((b) => {
      const vistoEm = vistos[b.id];
      return !vistoEm || (agora - vistoEm) < BANNER_DURACAO_VISIVEL_MS;
    });

    container.innerHTML = visiveis.map((b) => `
      <div class="cartao" data-banner-id="${escapeHtml(b.id)}" style="text-align:left">
        ${b.imagem_url ? `<img src="${escapeHtml(b.imagem_url)}" alt="" style="width:100%;border-radius:10px;margin-bottom:10px;display:block" />` : ''}
        <h3 style="margin-top:0">${escapeHtml(b.titulo)}</h3>
        <p style="margin-bottom:0">${escapeHtml(b.texto)}</p>
        <button type="button" class="btn-fechar-banner-hub" style="margin-top:10px">Fechar</button>
      </div>
    `).join('');

    // Marca como visto assim que renderizado — não precisa clicar em nada
    // pra contar como "aberto"; ele já apareceu na tela do aluno.
    visiveis.forEach((b) => marcarBannerVisto(b.id));

    container.querySelectorAll('.btn-fechar-banner-hub').forEach((btn) => {
      btn.addEventListener('click', () => {
        const elBanner = btn.closest('[data-banner-id]');
        suprimirBanner(elBanner.dataset.bannerId); // fechar manualmente também suprime de vez, não só nesta visita
        elBanner.remove();
      });
    });
  } catch {
    // Não é crítico pro resto do hub funcionar — se falhar, só não mostra
    // banner nenhum, sem travar o dashboard.
  }
}

function formatarData(iso) {
  if (!iso) return '';
  return iso.split('-').reverse().join('/');
}

// ---------------------------------------------------------------------------
// Web Push (2026-08-13) — notificações que chegam mesmo com o portal fechado
// (ex.: aviso de vencimento). Mesmo padrão validado no TreinoPro/Entregaí:
// pede permissão só num gesto explícito do aluno (nunca no carregamento da
// página sem contexto — o navegador pode simplesmente ignorar o pedido fora
// de uma interação direta), compara a chave da subscription existente com a
// atual antes de reaproveitar (protege contra uma eventual rotação de chave
// VAPID deixar assinaturas mortas em silêncio).
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const bruto = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...bruto].map((c) => c.charCodeAt(0)));
}

function chavesIguais(chaveAtualBuffer, chaveEsperadaUint8) {
  if (!chaveAtualBuffer) return false;
  const atual = new Uint8Array(chaveAtualBuffer);
  return atual.length === chaveEsperadaUint8.length && atual.every((b, i) => b === chaveEsperadaUint8[i]);
}

/**
 * Garante uma PushSubscription válida pro aluno logado (cpfHubAtual/
 * senhaHubAtual) e manda pro servidor. Chamar só a partir de um clique
 * explícito (checkbox/botão de "ativar notificações") — nunca sozinho no
 * carregamento da página. Retorna um status pra quem chamou decidir o que
 * mostrar: 'unsupported' | 'denied' | 'subscribed' | 'erro'.
 */
async function ativarNotificacoesPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';

  try {
    const { publicKey, habilitado } = await api('/api/portal/push/vapid-public-key');
    if (!habilitado || !publicKey) return 'erro';

    if (Notification.permission === 'default') {
      const permissao = await Notification.requestPermission();
      if (permissao !== 'granted') return 'denied';
    }

    const registro = await navigator.serviceWorker.ready;
    const chaveEsperada = urlBase64ToUint8Array(publicKey);
    let sub = await registro.pushManager.getSubscription();

    if (sub && !chavesIguais(sub.options && sub.options.applicationServerKey, chaveEsperada)) {
      // Assinatura presa numa chave VAPID antiga (ex.: par de chaves foi
      // regenerado no servidor) — desinscreve e força uma nova.
      await sub.unsubscribe();
      sub = null;
    }

    if (!sub) {
      sub = await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveEsperada });
    }

    await api('/api/portal/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, subscription: sub.toJSON() }),
    });
    return 'subscribed';
  } catch (err) {
    console.error('[push] falha ao ativar notificações:', err.message);
    return 'erro';
  }
}

/** Desliga notificações neste aparelho (chamado ao desmarcar a caixa em Configurações). */
async function desativarNotificacoesPush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const registro = await navigator.serviceWorker.ready;
    const sub = await registro.pushManager.getSubscription();
    if (!sub) return;
    await api('/api/portal/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  } catch (err) {
    console.error('[push] falha ao desativar notificações:', err.message);
  }
}

let configApp = { nome_app: 'Academia Gestão', whatsapp_contato: '', treino_app_url: '' };

async function carregarConfigPublica() {
  try {
    configApp = await api('/api/config');
    document.getElementById('portal-logo').textContent = (configApp.nome_app || 'Academia Gestão').toUpperCase();
  } catch {
    // segue com os padrões se a config pública falhar por algum motivo
  }
}

// ---------------- Câmera (compartilhada entre cadastro facial do hub e do cadastro novo) ----------------

let streamAtual = null;
// 2026-08-04: frontal/traseira — ver alternarCamera abaixo (pedido explícito
// pra poder cadastrar o rosto de outra pessoa usando a câmera traseira do
// celular, mais fácil de mirar do que virar a tela pra frontal).
let facingModeAtual = 'user';

async function iniciarCamera(videoEl) {
  pararCamera();
  streamAtual = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingModeAtual } });
  videoEl.srcObject = streamAtual;
  // Traseira não deve vir espelhada (ver CSS .camera-traseira) — só a
  // frontal tem o efeito "espelho" esperado.
  videoEl.classList.toggle('camera-traseira', facingModeAtual === 'environment');
  await videoEl.play();
}

function pararCamera() {
  if (streamAtual) {
    streamAtual.getTracks().forEach((t) => t.stop());
    streamAtual = null;
  }
}

async function alternarCamera(videoEl) {
  facingModeAtual = facingModeAtual === 'user' ? 'environment' : 'user';
  try {
    await iniciarCamera(videoEl);
  } catch (err) {
    // Sem a câmera pedida (ex.: PC sem traseira) — volta pra frontal em vez
    // de deixar a tela sem imagem nenhuma.
    facingModeAtual = 'user';
    await iniciarCamera(videoEl);
  }
}

// Carregamento dos modelos e a mecânica de captura (com liveness — mesma
// sequência de passos guiados do totem) agora vêm de facial-guiado.js. Antes
// este arquivo tinha sua própria versão "crua" (cadastrava na primeira
// detecção, sem liveness) — era exatamente o mecanismo diferente do totem
// relatado em 2026-07-27. Aqui só cuidamos do que é específico do portal:
// carregar câmera/modelos antes e mandar o descritor pro endpoint do portal
// (com senha) ao final.
async function iniciarCadastroFacial({ video, statusEl, cpf, senha, aoConcluir }) {
  try {
    statusEl.textContent = 'Carregando...';
    await carregarModelosFaciais();
    await iniciarCamera(video);
  } catch (err) {
    statusEl.textContent = `Erro: ${err.message}`;
    return;
  }

  await executarCadastroFacialGuiado({
    video,
    statusEl,
    enviarDescritor: async (descriptor, foto) => {
      pararCamera();
      await api('/api/portal/vincular/facial', {
        method: 'POST',
        body: JSON.stringify({ cpf, senha, descriptor, foto }),
      });
    },
    aoConcluir,
  });
}

// ---------------- Início ----------------

document.getElementById('btn-ir-hub').addEventListener('click', () => {
  resetHub();
  mostrarPagina('pagina-hub');
});

document.getElementById('btn-ir-cadastro-portal').addEventListener('click', () => {
  resetCadastroPortal();
  mostrarPagina('pagina-cadastro-portal');
});

// ---------------- Hub do aluno ----------------

let cpfHubAtual = null;
let senhaHubAtual = null; // senha do portal (mesmo código do biometria_id) — ver análise de segurança 2026-07

// ---------------- Login persistente (2026-08-27) ----------------
// Pedido explícito do dono do sistema: quem já tem o app instalado no
// celular não deveria precisar digitar CPF+senha toda vez que abre — só na
// primeira vez. Guarda as credenciais em localStorage (privado a este
// dispositivo/navegador) e tenta logar sozinho ao abrir a página (ver
// tentarAutoLoginHub, chamada lá embaixo em "Inicialização"). Continua
// mandando CPF+senha em toda chamada de API como sempre (o portal nunca
// teve sessão/token — ver comentário de senhaHubAtual acima); isso só evita
// o aluno ter que redigitar a cada vez que reabre o app.
const CHAVE_CPF_SALVO = 'portal_cpf_salvo';
const CHAVE_SENHA_SALVA = 'portal_senha_salva';

function salvarCredenciaisHub(cpf, senha) {
  try {
    localStorage.setItem(CHAVE_CPF_SALVO, cpf);
    localStorage.setItem(CHAVE_SENHA_SALVA, senha);
  } catch { /* localStorage indisponível (modo privado etc.) — só significa que vai pedir login de novo na próxima vez */ }
}

function limparCredenciaisHub() {
  try {
    localStorage.removeItem(CHAVE_CPF_SALVO);
    localStorage.removeItem(CHAVE_SENHA_SALVA);
  } catch { /* idem acima */ }
}

function lerCredenciaisSalvasHub() {
  try {
    const cpf = localStorage.getItem(CHAVE_CPF_SALVO);
    const senha = localStorage.getItem(CHAVE_SENHA_SALVA);
    return cpf && senha ? { cpf, senha } : null;
  } catch {
    return null;
  }
}

// Tenta logar sozinho com as credenciais salvas deste dispositivo, direto
// na tela inicial (sem o aluno digitar nada). Se falhar por qualquer motivo
// (senha mudou, cadastro removido, etc.), apaga o que estava salvo e deixa
// a tela normal de CPF/senha aparecer — nunca trava o portal num estado
// quebrado por causa disso.
async function tentarAutoLoginHub() {
  const salvo = lerCredenciaisSalvasHub();
  if (!salvo) return;
  // 2026-08-27: reforça o reset de scroll do wrapper interno (ver
  // irParaTopo) já aqui, antes de esconder o painel de CPF — o body em si
  // não rola mais (position:fixed, ver comentário grande em portal.html),
  // então isso é só uma segunda camada de segurança, não a correção
  // principal do "sambando pros lados".
  document.getElementById('scroll-raiz')?.scrollTo(0, 0);
  // Esconde a tela de CPF/senha (visível por padrão no HTML) enquanto o
  // login automático está em andamento, pra evitar o "flash" dela aparecer
  // e sumir rápido de novo antes do dashboard carregar.
  const painelCpf = document.getElementById('painel-hub-cpf');
  painelCpf.classList.add('oculto');
  try {
    const info = await api(`/api/portal/aluno?${new URLSearchParams({ cpf: salvo.cpf, senha: salvo.senha }).toString()}`);
    if (info.primeiro_acesso) { limparCredenciaisHub(); painelCpf.classList.remove('oculto'); return; } // credencial salva não devia cair nesse caso; por segurança, não assume nada
    cpfHubAtual = salvo.cpf;
    senhaHubAtual = salvo.senha;
    preencherDashboardHub(info);
  } catch {
    limparCredenciaisHub();
    painelCpf.classList.remove('oculto');
  }
}
let alunoHubTreinoModo = 'nativo';
let alunoHubTreinoLiberado = true; // mensalidade em dia? (ver GET /api/portal/aluno) — false esconde/desabilita o card de treino
let alunoHubTreinoBloqueadoMotivo = null;
let contasSelecionadasHub = {};
let pixHubPollTimer = null;
let infoHubPendentePrimeiroAcesso = null; // guarda os dados do dashboard enquanto a tela de "guarde sua senha" está aberta
let dadosPessoaisHubAtual = null; // { nome, telefone, email, data_nascimento } — ver GET /api/portal/aluno

function resetHub() {
  pararPollPixHub();
  pararCamera();
  cpfHubAtual = null;
  senhaHubAtual = null;
  infoHubPendentePrimeiroAcesso = null;
  dadosPessoaisHubAtual = null;
  contasSelecionadasHub = {};
  document.getElementById('input-cpf-hub').value = '';
  document.getElementById('input-senha-hub').value = '';
  document.getElementById('input-senha-hub').classList.add('oculto');
  document.getElementById('hub-cpf-erro').textContent = '';
  document.getElementById('painel-hub-cpf').classList.remove('oculto');
  ['painel-hub-primeiro-acesso', 'painel-hub-dashboard', 'painel-hub-contas', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-comprovante', 'painel-hub-completar-cadastro', 'painel-hub-facial', 'painel-hub-avaliacoes']
    .forEach((id) => document.getElementById(id).classList.add('oculto'));
  const avisoVencimento = document.getElementById('aviso-vencimento-hub');
  avisoVencimento.classList.add('oculto');
  avisoVencimento.textContent = '';
}

// 2026-07: antes esse botão sempre resetava tudo e voltava pro início (digitar
// CPF de novo), mesmo estando só um nível dentro (ex: na tela de Contas ou
// Treino, depois de já ter aberto o menu). Agora ele volta um nível de cada
// vez: se tiver algum painel de submenu aberto (contas/treino/plano/pix/
// facial), fecha esse painel e volta pro menu principal (painel-hub-
// dashboard); só faz o reset completo pro início quando já está no menu
// principal (ou na tela de CPF).
document.getElementById('btn-voltar-hub').addEventListener('click', () => {
  const SUBPAINEIS_HUB = ['painel-hub-contas', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-completar-cadastro', 'painel-hub-facial', 'painel-hub-avaliacoes', 'painel-hub-notificacoes'];
  const painelAberto = SUBPAINEIS_HUB.find((id) => !document.getElementById(id).classList.contains('oculto'));
  if (painelAberto) {
    if (painelAberto === 'painel-hub-pix') pararPollPixHub();
    if (painelAberto === 'painel-hub-facial') pararCamera();
    ocultarPaineisHub();
    document.getElementById('painel-hub-dashboard').classList.remove('oculto');
    return;
  }
  resetHub();
  mostrarPagina('pagina-inicio');
});

function preencherDashboardHub(info) {
  alunoHubTreinoModo = info.treino_modo || 'nativo';
  dadosPessoaisHubAtual = info.dados_pessoais || null;

  document.getElementById('hub-saudacao').textContent = `Olá, ${info.aluno_nome}!`;
  document.getElementById('painel-hub-cpf').classList.add('oculto');
  document.getElementById('painel-hub-primeiro-acesso').classList.add('oculto');
  document.getElementById('painel-hub-dashboard').classList.remove('oculto');
  irParaTopo();

  document.getElementById('card-plano-resumo').textContent = info.plano_atual
    ? `${info.plano_atual.plano_nome} — ${formatarMoeda(info.plano_atual.valor_centavos)}/ciclo`
    : 'Nenhum plano ativo no momento.';

  alunoHubTreinoLiberado = info.treino_liberado !== false;
  alunoHubTreinoBloqueadoMotivo = info.treino_bloqueado_motivo || null;

  const btnAbrirTreino = document.getElementById('btn-abrir-treino');
  if (!alunoHubTreinoLiberado) {
    document.getElementById('card-treino-resumo').textContent = alunoHubTreinoBloqueadoMotivo
      || 'Regularize sua mensalidade para ver o treino.';
    btnAbrirTreino.disabled = true;
  } else {
    document.getElementById('card-treino-resumo').textContent = alunoHubTreinoModo === 'app_externo'
      ? 'Seu treino é acompanhado em outro aplicativo.'
      : 'Toque para ver seus treinos cadastrados.';
    btnAbrirTreino.disabled = false;
  }

  const cardFacial = document.getElementById('card-facial');
  if (info.tem_rosto_cadastrado) cardFacial.classList.add('oculto');
  else cardFacial.classList.remove('oculto');

  const cardAvaliacao = document.getElementById('card-avaliacao');
  const linkAgendar = document.getElementById('link-agendar-avaliacao');
  if (configApp.whatsapp_contato) {
    cardAvaliacao.classList.remove('oculto');
    linkAgendar.classList.remove('oculto');
    const texto = encodeURIComponent(`Olá! Sou aluno(a) ${info.aluno_nome} e gostaria de agendar/renovar minha avaliação física.`);
    linkAgendar.href = `https://wa.me/${configApp.whatsapp_contato}?text=${texto}`;
  } else {
    linkAgendar.classList.add('oculto');
  }

  atualizarCardNotificacoes(info);
  carregarBannersHub();
  carregarResumoContasHub();
  carregarAvaliacoesHub();
}

// ---- Notificações de vencimento (2026-08-13) ----

// 2026-08-29 (achado investigando "push não chega, mas aparece Ativado"):
// notificar_vencimento é uma preferência do CADASTRO do aluno (um valor só,
// compartilhado por qualquer aparelho/navegador que ele use) — não indica
// se ESTE aparelho específico tem uma PushSubscription de verdade ativa.
// Um aluno que ativou no computador da recepção, ou no celular antigo, vê
// "Ativadas" aqui de cara no celular novo — sem nunca ter concedido
// permissão nem assinado push NESSE aparelho. Confirma direto com o
// service worker (única fonte de verdade sobre o aparelho atual) em vez de
// confiar só no que veio do servidor.
async function esteAparelhoTemPushAtivo() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const registro = await navigator.serviceWorker.ready;
    const sub = await registro.pushManager.getSubscription();
    return Boolean(sub);
  } catch {
    return false;
  }
}

// notificar_vencimento: null = nunca perguntado (mostra o convite) — 0/1 =
// já respondeu (só reflete no card, sem convite de novo).
async function atualizarCardNotificacoes(info) {
  const convite = document.getElementById('convite-notificacoes-hub');
  const diasAntesAtual = info.notificar_vencimento_dias_antes || 3;

  if (info.notificar_vencimento === null || info.notificar_vencimento === undefined) {
    convite.classList.remove('oculto');
  } else {
    convite.classList.add('oculto');
  }

  document.getElementById('input-notif-dias-antes').value = diasAntesAtual;
  document.getElementById('input-notif-ativar').checked = Boolean(info.notificar_vencimento);

  const resumoEl = document.getElementById('card-notificacoes-resumo');
  const btnAtivarAparelho = document.getElementById('btn-notif-ativar-aparelho');
  if (!info.notificar_vencimento) {
    resumoEl.textContent = 'Desativadas. Toque para ativar o aviso de vencimento.';
    btnAtivarAparelho.classList.add('oculto');
    return;
  }

  // Preferência ligada — mas só sabemos se ESTE aparelho vai receber o
  // aviso depois de checar a subscription local (async, por isso o card
  // mostra "Ativadas" na hora e só ajusta o aviso extra logo em seguida).
  resumoEl.textContent = `Ativadas — avisamos ${diasAntesAtual} dia${diasAntesAtual === 1 ? '' : 's'} antes do vencimento.`;
  const temPushAqui = await esteAparelhoTemPushAtivo();
  if (!temPushAqui && Notification.permission !== 'denied') {
    resumoEl.textContent += ' Ativadas em outro aparelho — toque abaixo pra também receber neste.';
    btnAtivarAparelho.classList.remove('oculto');
  } else {
    btnAtivarAparelho.classList.add('oculto');
  }
}

document.getElementById('btn-notif-ativar-aparelho').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = 'Ativando...';
  const resultado = await ativarNotificacoesPush();
  if (resultado === 'subscribed') {
    btn.classList.add('oculto');
    document.getElementById('card-notificacoes-resumo').textContent = document.getElementById('card-notificacoes-resumo').textContent.replace(' Ativadas em outro aparelho — toque abaixo pra também receber neste.', '');
    alert('Pronto! Este aparelho também vai receber os avisos.');
  } else if (resultado === 'denied') {
    alert('O navegador bloqueou a permissão de notificação. Ative manualmente nas configurações do navegador/celular e tente de novo.');
    btn.disabled = false;
    btn.textContent = textoOriginal;
  } else {
    alert('Não deu pra ativar agora. Tente de novo em alguns instantes.');
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
});

document.getElementById('btn-convite-notif-sim').addEventListener('click', async () => {
  const resultado = await ativarNotificacoesPush();
  await api('/api/portal/notificacoes-preferencia', {
    method: 'POST',
    body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, notificar_vencimento: true }),
  }).catch(() => {});
  document.getElementById('convite-notificacoes-hub').classList.add('oculto');
  document.getElementById('card-notificacoes-resumo').textContent = 'Ativadas — avisamos 3 dias antes do vencimento.';
  document.getElementById('input-notif-ativar').checked = true;
  if (resultado === 'denied') {
    alert('Notificação de vencimento ativada, mas o navegador bloqueou o aviso automático. Você pode permitir depois nas configurações do navegador, ou continuar vendo o aviso aqui no portal normalmente.');
  }
});

document.getElementById('btn-convite-notif-nao').addEventListener('click', async () => {
  await api('/api/portal/notificacoes-preferencia', {
    method: 'POST',
    body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, notificar_vencimento: false }),
  }).catch(() => {});
  document.getElementById('convite-notificacoes-hub').classList.add('oculto');
});

document.getElementById('btn-abrir-notificacoes').addEventListener('click', () => {
  ocultarPaineisHub();
  document.getElementById('painel-hub-notificacoes').classList.remove('oculto');
});

document.getElementById('input-notif-ativar').addEventListener('change', async (ev) => {
  const ligar = ev.target.checked;
  if (ligar) await ativarNotificacoesPush();
  else await desativarNotificacoesPush();
});

document.getElementById('painel-hub-notificacoes').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ativar = document.getElementById('input-notif-ativar').checked;
  const diasAntes = Number(document.getElementById('input-notif-dias-antes').value) || 3;
  try {
    await api('/api/portal/notificacoes-preferencia', {
      method: 'POST',
      body: JSON.stringify({
        cpf: cpfHubAtual, senha: senhaHubAtual, notificar_vencimento: ativar, dias_antes: diasAntes,
      }),
    });
    document.getElementById('card-notificacoes-resumo').textContent = ativar
      ? `Ativadas — avisamos ${diasAntes} dia${diasAntes === 1 ? '' : 's'} antes do vencimento.`
      : 'Desativadas. Toque para ativar o aviso de vencimento.';
    alert('Preferência salva.');
  } catch (err) {
    alert(err.message);
  }
});

// Incentivo a instalar o portal na tela de início — Web Push no Safari/iOS
// só é entregue com o app instalado (não funciona numa aba normal, mesmo
// com a assinatura salva certinha). Mostra só se ainda não estiver rodando
// em modo standalone (ou seja, já instalado).
(function avisoInstalarApp() {
  const jaInstalado = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (jaInstalado) return;
  const aviso = document.getElementById('aviso-instalar-app');
  if (aviso) aviso.classList.remove('oculto');
})();

// ---- Minhas avaliações ----

let avaliacoesHubAtual = [];

// 2026-08-14: mesma cadência recomendada usada no TreinoPro (REASSESSMENT_
// CADENCE_DAYS) — 90 dias entre avaliações físicas. A janela de aviso aqui é
// mais generosa que os 3 dias de lá (15) porque renovar uma avaliação exige
// agendar um horário presencial na academia, não é uma ação de um clique.
const CADENCIA_AVALIACAO_DIAS = 90;
const AVISO_AVALIACAO_ANTECEDENCIA_DIAS = 15;

async function carregarAvaliacoesHub() {
  const cardAvaliacao = document.getElementById('card-avaliacao');
  const botaoVer = document.getElementById('btn-ver-avaliacoes-hub');
  const resumo = document.getElementById('card-avaliacao-resumo');
  try {
    const resp = await api(`/api/portal/avaliacoes?cpf=${encodeURIComponent(cpfHubAtual)}&senha=${encodeURIComponent(senhaHubAtual)}`);
    avaliacoesHubAtual = resp.avaliacoes || [];
    if (avaliacoesHubAtual.length) {
      cardAvaliacao.classList.remove('oculto');
      botaoVer.classList.remove('oculto');
      const ultima = avaliacoesHubAtual[avaliacoesHubAtual.length - 1];
      const diasDesdeUltima = -diasAteVencimento(ultima.data);
      const diasParaVencer = CADENCIA_AVALIACAO_DIAS - diasDesdeUltima;

      let avisoHtml = '';
      if (diasParaVencer < 0) {
        avisoHtml = `<strong style="color:#fca5a5">⚠️ Sua avaliação venceu há ${Math.abs(diasParaVencer)} dia${Math.abs(diasParaVencer) === 1 ? '' : 's'} — hora de renovar.</strong><br>`;
      } else if (diasParaVencer <= AVISO_AVALIACAO_ANTECEDENCIA_DIAS) {
        avisoHtml = `<strong style="color:#fbbf24">⏳ Sua avaliação vence em ${diasParaVencer} dia${diasParaVencer === 1 ? '' : 's'} — hora de renovar.</strong><br>`;
      }
      resumo.innerHTML = `${avisoHtml}Última avaliação em ${formatarData(ultima.data)}. Toque para ver sua evolução.`;
    } else {
      botaoVer.classList.add('oculto');
    }
  } catch (err) {
    // Não é crítico pro resto do hub funcionar — se falhar, só o botão
    // de ver avaliações não aparece, sem travar o resto do dashboard.
    botaoVer.classList.add('oculto');
  }
}

document.getElementById('btn-ver-avaliacoes-hub').addEventListener('click', () => {
  ocultarPaineisHub();
  document.getElementById('painel-hub-avaliacoes').classList.remove('oculto');
  renderizarAvaliacoesHub(avaliacoesHubAtual);
});

// Mini gráfico de linha, sem eixos nem grade — só a tendência, pensado
// pro tema sempre-escuro do portal (o AvaliaPro tem um componente de
// gráfico próprio, mas ele se adapta a claro/escuro pelo sistema
// operacional, e o portal é sempre escuro; reaproveitar geraria texto
// claro ilegível pra quem estiver com o celular no modo claro).
function sparklineHub(pontos, unidade) {
  if (pontos.length < 2) return '';
  const W = 260, H = 46, PAD = 6;
  const valores = pontos.map((p) => p.valor);
  let min = Math.min(...valores), max = Math.max(...valores);
  const folga = Math.max((max - min) * 0.15, Math.abs(max) * 0.02 || 1);
  min -= folga; max += folga;
  const px = (i) => PAD + (i / (pontos.length - 1)) * (W - PAD * 2);
  const py = (v) => H - PAD - ((v - min) / (max - min || 1)) * (H - PAD * 2);
  const d = pontos.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(p.valor).toFixed(1)}`).join(' ');
  const ultimo = pontos[pontos.length - 1];
  return `<svg class="avaliacao-sparkline" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    <path d="${d}" fill="none" stroke="#10b981" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pontos.map((p, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(p.valor).toFixed(1)}" r="${i === pontos.length - 1 ? 3.5 : 2.5}" fill="#10b981" stroke="#0f172a" stroke-width="1.5"/>`).join('')}
    <text x="${px(pontos.length - 1).toFixed(1)}" y="${(py(ultimo.valor) - 8).toFixed(1)}" text-anchor="end" font-size="11" font-weight="700" fill="#cbd5e1">${formatarNumeroHub(ultimo.valor)}${unidade}</text>
  </svg>`;
}

function formatarNumeroHub(v, casas) {
  const c = casas != null ? casas : (Math.abs(v) < 10 ? 2 : 1);
  return Number(v).toFixed(c).replace('.', ',');
}

// Uma métrica de destaque por tipo — o bastante pro aluno acompanhar
// sem virar uma segunda tela de profissional (o AvaliaPro completo,
// com edição e captura, é só pro staff).
const METRICAS_HUB = {
  Antropometria: [{ chave: 'fields.peso', rotulo: 'Peso', unidade: ' kg', melhor: null }],
  Adipometria: [
    { chave: 'computed.bf', rotulo: '% de gordura', unidade: '%', melhor: 'menor' },
    { chave: 'computed.massaMagra', rotulo: 'Massa magra', unidade: ' kg', melhor: 'maior' },
  ],
  Perimetria: [{ chave: 'fields.cintura', rotulo: 'Cintura', unidade: ' cm', melhor: 'menor' }],
  'Bioimpedância': [{ chave: 'computed.bf', rotulo: '% de gordura', unidade: '%', melhor: 'menor' }],
};

function valorEmHub(av, caminho) {
  const partes = caminho.split('.');
  let atual = av;
  for (const p of partes) { if (atual == null) return null; atual = atual[p]; }
  if (atual === '' || atual == null) return null;
  const n = typeof atual === 'number' ? atual : parseFloat(String(atual).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function renderizarAvaliacoesHub(avaliacoes) {
  const alvo = document.getElementById('conteudo-avaliacoes-hub');
  if (!avaliacoes.length) {
    alvo.innerHTML = '<p style="color:#94a3b8;font-size:14px">Nenhuma avaliação registrada ainda.</p>';
    return;
  }

  const porTipo = {};
  avaliacoes.forEach((av) => { (porTipo[av.tipo] = porTipo[av.tipo] || []).push(av); });

  let html = '';
  Object.keys(METRICAS_HUB).forEach((tipo) => {
    const lista = porTipo[tipo];
    if (!lista || !lista.length) return;

    html += `<div class="avaliacao-card"><h4>${tipo}</h4>`;
    METRICAS_HUB[tipo].forEach((m) => {
      const pontos = lista
        .map((av) => ({ data: av.data, valor: valorEmHub(av, m.chave) }))
        .filter((p) => p.valor != null);
      if (!pontos.length) return;

      const atual = pontos[pontos.length - 1].valor;
      const primeiro = pontos[0].valor;
      const delta = pontos.length > 1 ? atual - primeiro : null;
      let classeDelta = 'neutro';
      if (delta != null && m.melhor && Math.abs(delta) > 0.05) {
        const melhorou = m.melhor === 'menor' ? delta < 0 : delta > 0;
        classeDelta = melhorou ? 'bom' : 'ruim';
      }
      const setaDelta = delta == null ? '' : delta > 0.05 ? '▲' : delta < -0.05 ? '▼' : '';

      html += `<div class="avaliacao-metrica">
        <div>
          <div class="rotulo">${m.rotulo}</div>
          ${pontos.length > 1 ? sparklineHub(pontos, m.unidade) : ''}
        </div>
        <div class="valores">
          <span class="atual">${formatarNumeroHub(atual)}${m.unidade}</span>
          ${delta != null ? `<span class="avaliacao-delta ${classeDelta}">${setaDelta} ${formatarNumeroHub(Math.abs(delta))}${m.unidade}</span>` : ''}
        </div>
      </div>`;
    });
    const datas = lista.map((av) => av.data);
    html += `<div class="avaliacao-data-linha">${lista.length} avaliaç${lista.length === 1 ? 'ão' : 'ões'} · ${formatarData(datas[0])} a ${formatarData(datas[datas.length - 1])}</div>`;
    html += '</div>';
  });

  alvo.innerHTML = html || '<p style="color:#94a3b8;font-size:14px">Nenhuma medida reconhecida nas avaliações registradas.</p>';
}

document.getElementById('btn-buscar-hub').addEventListener('click', async () => {
  const cpf = document.getElementById('input-cpf-hub').value.trim();
  const campoSenha = document.getElementById('input-senha-hub');
  const erroEl = document.getElementById('hub-cpf-erro');
  erroEl.textContent = '';
  if (!cpf) return;

  // 2026-08-14: só manda "senha" se o campo já estiver VISÍVEL (ou seja, o
  // aluno já foi explicitamente pedido por ela numa tentativa anterior) —
  // nunca só por ter algum valor. Navegadores (Chrome principalmente) podem
  // autopreencher um input type="password" mesmo escondido via CSS, com uma
  // senha salva de OUTRO site/login; sem essa checagem, a 1a tentativa (só
  // CPF) mandava esse valor lixo junto, o servidor recusava com "CPF ou
  // senha incorretos" (em vez de "informe sua senha"), e o campo nunca
  // aparecia pro aluno ver ou corrigir — parecia que o portal simplesmente
  // não fazia nada. Achado testando com um aluno real (Robson).
  const campoSenhaVisivel = !campoSenha.classList.contains('oculto');
  const senhaDigitada = campoSenha.value.trim();

  try {
    const qs = new URLSearchParams({ cpf });
    if (campoSenhaVisivel && senhaDigitada) qs.set('senha', senhaDigitada);
    const info = await api(`/api/portal/aluno?${qs.toString()}`);
    cpfHubAtual = cpf;

    if (info.primeiro_acesso) {
      // 1o acesso deste aluno ao portal: mostra a senha gerada/recuperada
      // antes de entrar no dashboard — só aparece esta vez.
      senhaHubAtual = info.senha_gerada;
      infoHubPendentePrimeiroAcesso = info;
      document.getElementById('painel-hub-cpf').classList.add('oculto');
      document.getElementById('primeiro-acesso-senha-valor').textContent = info.senha_gerada;
      document.getElementById('painel-hub-primeiro-acesso').classList.remove('oculto');
      return;
    }

    senhaHubAtual = senhaDigitada;
    salvarCredenciaisHub(cpfHubAtual, senhaHubAtual);
    preencherDashboardHub(info);
  } catch (err) {
    // Sempre garante o campo visível quando a senha é o problema (faltando
    // OU errada) — antes só revelava no caso "faltando", deixando o aluno
    // sem nenhum jeito de corrigir uma senha errada/autopreenchida.
    if (err.dados && (err.dados.precisa_senha || campoSenhaVisivel)) {
      campoSenha.classList.remove('oculto');
      campoSenha.value = '';
      campoSenha.focus();
    }
    erroEl.textContent = err.message;
  }
});

document.getElementById('btn-hub-sair').addEventListener('click', () => {
  if (!confirm('Sair desta conta? Da próxima vez você vai precisar digitar CPF e senha de novo.')) return;
  limparCredenciaisHub();
  resetHub();
});

document.getElementById('btn-primeiro-acesso-continuar').addEventListener('click', () => {
  if (!infoHubPendentePrimeiroAcesso) return;
  const info = infoHubPendentePrimeiroAcesso;
  infoHubPendentePrimeiroAcesso = null;
  salvarCredenciaisHub(cpfHubAtual, senhaHubAtual);
  preencherDashboardHub(info);
});

async function carregarResumoContasHub() {
  try {
    const resp = await api('/api/portal/contas/consultar', { method: 'POST', body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual }) });
    const resumoEl = document.getElementById('card-contas-resumo');
    if (!resp.contas.length) {
      resumoEl.textContent = 'Nenhuma conta em aberto. Tudo em dia!';
      document.getElementById('btn-abrir-contas').disabled = true;
    } else {
      const total = resp.contas.reduce((s, c) => s + c.valor_centavos, 0);
      resumoEl.textContent = `${resp.contas.length} conta(s) em aberto — total ${formatarMoeda(total)}.`;
      document.getElementById('btn-abrir-contas').disabled = false;
    }
    atualizarAvisoVencimento(resp.contas);
  } catch (err) {
    document.getElementById('card-contas-resumo').textContent = `Erro ao consultar: ${err.message}`;
  }
}

// ---- Aviso de vencimento (3 dias antes / "vence hoje" / "vencido há N dias") ----
// Regra pedida: nos 3 dias anteriores ao vencimento mostra aviso de aproximação;
// no dia do vencimento mostra "vence hoje"; depois do vencimento, enquanto a conta
// continuar em aberto (atrasada), mostra "vencido há N dia(s)" contando os dias.

// "vencimento" vem como 'AAAA-MM-DD' (ver formatarData acima) — monta a data em
// horário local (meio-dia evita qualquer problema de fuso horário na comparação).
function dataLocalDeIso(dataIso) {
  const [ano, mes, dia] = dataIso.split('-').map(Number);
  return new Date(ano, mes - 1, dia, 12, 0, 0);
}

// Quantos dias faltam até o vencimento (negativo = já venceu há N dias).
function diasAteVencimento(dataIso) {
  const hoje = new Date();
  const hojeSemHora = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 12, 0, 0);
  const venc = dataLocalDeIso(dataIso);
  return Math.round((venc - hojeSemHora) / 86400000);
}

// Entre as contas em aberto, a que está mais perto de vencer (ou mais atrasada) é
// a que manda no aviso — não faz sentido mostrar "vence em 3 dias" se já tem outra
// conta vencida há uma semana.
function contaMaisUrgente(contas) {
  let escolhida = null;
  let diasEscolhida = Infinity;
  contas.forEach((c) => {
    if (!c.vencimento) return;
    const dias = diasAteVencimento(c.vencimento);
    if (dias < diasEscolhida) { diasEscolhida = dias; escolhida = c; }
  });
  return escolhida ? { conta: escolhida, dias: diasEscolhida } : null;
}

// 2026-08-13: pedido do dono do sistema — antes só aparecia quando urgente
// (≤3 dias ou já vencido); agora fica sempre visível, com a data concreta,
// logo ao acessar o app (não só quando o aluno abre "Contas"). A cor/tom
// ainda muda com a urgência, mas a VISIBILIDADE não depende mais disso.
function atualizarAvisoVencimento(contas) {
  const el = document.getElementById('aviso-vencimento-hub');
  if (!el) return;

  const urgente = contaMaisUrgente(contas);
  if (!urgente) {
    el.textContent = '✅ Sua mensalidade está em dia.';
    el.className = 'aviso-vencimento em-dia';
    return;
  }

  const { dias, conta } = urgente;
  const dataFormatada = formatarData(conta.vencimento);
  let texto;
  let classe;
  if (dias < 0) {
    const diasAtraso = Math.abs(dias);
    texto = `⚠️ Sua mensalidade venceu dia ${dataFormatada} (há ${diasAtraso} dia${diasAtraso === 1 ? '' : 's'}). Regularize para evitar bloqueio de acesso.`;
    classe = 'vencido';
  } else if (dias === 0) {
    texto = `⏰ Sua mensalidade vence hoje, dia ${dataFormatada}.`;
    classe = 'hoje';
  } else if (dias <= 3) {
    texto = `⏳ Sua mensalidade vence dia ${dataFormatada} (em ${dias} dia${dias === 1 ? '' : 's'}).`;
    classe = 'proximo';
  } else {
    texto = `📅 Sua mensalidade vence dia ${dataFormatada}.`;
    classe = 'futuro';
  }
  el.textContent = texto;
  el.className = `aviso-vencimento ${classe}`;
}

function ocultarPaineisHub() {
  ['painel-hub-dashboard', 'painel-hub-contas', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-comprovante', 'painel-hub-completar-cadastro', 'painel-hub-facial', 'painel-hub-notificacoes', 'painel-hub-avaliacoes']
    .forEach((id) => document.getElementById(id).classList.add('oculto'));
  irParaTopo();
}

document.getElementById('btn-abrir-contas').addEventListener('click', async () => {
  try {
    const resp = await api('/api/portal/contas/consultar', { method: 'POST', body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual }) });
    if (!resp.contas.length) return;
    ocultarPaineisHub();
    document.getElementById('painel-hub-contas').classList.remove('oculto');
    renderizarContasHub(resp.contas);
  } catch (err) {
    alert(err.message);
  }
});

function renderizarContasHub(contas) {
  contasSelecionadasHub = {};
  const alvo = document.getElementById('lista-contas-hub');
  alvo.innerHTML = contas.map((c) => `
    <label class="item-conta">
      <input type="checkbox" data-id="${c.id}" data-valor="${c.valor_centavos}" checked />
      <div class="info">
        <div class="desc">${c.descricao || 'Conta'}</div>
        <div class="venc">${c.vencimento ? `Vencimento: ${formatarData(c.vencimento)}` : ''}</div>
      </div>
      <div class="valor">${formatarMoeda(c.valor_centavos)}</div>
    </label>
  `).join('');
  contas.forEach((c) => { contasSelecionadasHub[c.id] = c.valor_centavos; });

  alvo.querySelectorAll('input[type=checkbox]').forEach((chk) => {
    chk.addEventListener('change', () => {
      if (chk.checked) contasSelecionadasHub[chk.dataset.id] = Number(chk.dataset.valor);
      else delete contasSelecionadasHub[chk.dataset.id];
      atualizarTotalContasHub();
    });
  });
  atualizarTotalContasHub();
}

function atualizarTotalContasHub() {
  const total = Object.values(contasSelecionadasHub).reduce((a, b) => a + b, 0);
  document.getElementById('contas-hub-total').textContent = formatarMoeda(total);
  document.getElementById('btn-pagar-contas-hub').disabled = total <= 0;
}

document.getElementById('btn-pagar-contas-hub').addEventListener('click', async () => {
  const ids = Object.keys(contasSelecionadasHub);
  if (!ids.length) return;
  try {
    const resp = await api('/api/portal/contas/pagar', {
      method: 'POST',
      body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, cobranca_ids: ids }),
    });
    abrirPagamentoPixHub({
      titulo: `Pagar ${formatarMoeda(resp.valor_centavos)}`,
      qrCodePix: resp.qr_code_pix,
      qrCodePixImagem: resp.qr_code_pix_imagem,
      statusUrl: `/api/portal/contas/status/${resp.pagamento_id}`,
      aoConfirmar: (statusResp) => {
        mostrarComprovanteHub({
          saudacao: `Pagamento aprovado, ${statusResp.aluno_nome || ''}!`,
          itens: statusResp.itens,
          total: statusResp.valor_centavos,
        });
        carregarResumoContasHub();
      },
    });
  } catch (err) {
    alert(err.message);
  }
});

// ---- Treino ----
// Vídeo de execução (2026-08, port do TreinoPro): mesmo esquema de embed —
// reconhece link do YouTube e monta um iframe; qualquer outro link vira um
// botão "▶ Ver vídeo" abrindo em nova aba.
function youtubeEmbedUrl(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/);
  return m ? `https://www.youtube.com/embed/${m[1]}?cc_load_policy=1&cc_lang_pref=pt&hl=pt&playsinline=1&rel=0` : null;
}
function videoPreviewHtml(url) {
  if (!url) return '';
  const yt = youtubeEmbedUrl(url);
  if (yt) return `<div class="video-embed"><iframe src="${yt}" allowfullscreen loading="lazy"></iframe></div>`;
  return `<div style="margin-top:6px"><a href="${url}" target="_blank" rel="noopener" class="btn-ver-video-ex" style="text-decoration:none;display:inline-block">▶ Ver vídeo</a></div>`;
}

const DIAS_SEMANA_PORTAL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
// Treino "em foco" por card (2026-09-02, layout inspirado no TreinoPro — ver
// abrirPainelTreino/renderizarTreinosHub abaixo): qual exercício o hero do
// treino X está mostrando agora. Sobrevive a re-renders (navegação
// anterior/próximo, marcar exercício), só é limpo quando o painel é reaberto
// do zero (abrirPainelTreino busca os dados de novo e escolheCurrentExercicio
// reconstrói a partir daí).
const treinoFocoExercicio = {};
let treinosCacheHub = [];

// Cronômetro por treino-card (2026-09-02, port do TreinoPro) — um estado por
// treino (não um único global) porque, quando o aluno tem mais de um treino
// marcado pro mesmo dia da semana, cada card cronometra a sua própria sessão
// independentemente. Zera sozinho só quando o aluno clica no botão de
// "zerar" — não é afetado por re-renders (navegação, marcar exercício).
const treinoTimers = {};
function formatarTempoTimer(totalSeg) {
  const min = Math.floor(totalSeg / 60).toString().padStart(2, '0');
  const seg = (totalSeg % 60).toString().padStart(2, '0');
  return `${min}:${seg}`;
}
function obterTimer(treinoId) {
  if (!treinoTimers[treinoId]) treinoTimers[treinoId] = { seg: 0, rodando: false, intervalo: null };
  return treinoTimers[treinoId];
}

function playerHeroMediaHtml(ex) {
  const yt = ex.video_url ? youtubeEmbedUrl(ex.video_url) : null;
  if (yt) return `<div class="player-hero-media"><iframe src="${yt}" allowfullscreen loading="lazy"></iframe></div>`;
  if (ex.video_url) return `<div class="player-hero-media"><a href="${ex.video_url}" target="_blank" rel="noopener" class="btn-ver-video-ex" style="display:block;text-align:center;padding:60px 0;text-decoration:none">▶ Ver vídeo</a></div>`;
  if (ex.imagem_url) return `<div class="player-hero-media"><img src="${ex.imagem_url}" loading="lazy"></div>`;
  return '<div class="player-hero-media"><div class="sem-midia">🏋️</div></div>';
}
function playerThumbHtml(ex) {
  return ex.imagem_url ? `<img src="${ex.imagem_url}" loading="lazy">` : '🏋️';
}
// Escolhe o exercício em foco: mantém o que já estava selecionado (se ainda
// existir no treino), senão pega o primeiro não concluído, senão o primeiro
// de todos (treino inteiro já feito) — mesma regra do TreinoPro
// (pickCurrentExercise em index.html).
function escolherExercicioAtual(treinoId, exercicios) {
  const focoId = treinoFocoExercicio[treinoId];
  if (focoId) {
    const achado = exercicios.find((e) => e.id === focoId);
    if (achado) return achado;
  }
  return exercicios.find((e) => !e.concluido) || exercicios[0];
}

async function abrirPainelTreino() {
  treinosCacheHub = await api(`/api/portal/treino?cpf=${encodeURIComponent(cpfHubAtual)}&senha=${encodeURIComponent(senhaHubAtual)}`);
  ocultarPaineisHub();
  document.getElementById('painel-hub-treino').classList.remove('oculto');
  renderizarTreinosHub();
  carregarGamificacaoHub();
}

// Só mostra o(s) treino(s) marcados pro dia de hoje (mesmo espírito do
// TreinoPro — 1 treino em foco por dia, não a lista inteira do aluno de uma
// vez). Um treino sem dias_semana definidos (nenhum dia marcado na aba
// Treinos do professor) continua aparecendo todo dia — é o mesmo
// comportamento "sem restrição" de antes desta mudança, só não filtra.
// Combinado com o reset diário que já existia (concluido_em == hoje, ver GET
// /treino em portal.routes.js), um treino de só 1 dia por semana (ex.:
// só segunda) reaparece pro aluno já desmarcado quando a próxima segunda
// chegar — sem precisar de nenhuma lógica de "reset semanal" à parte.
function treinosDeHoje() {
  const hojeIdx = new Date().getDay();
  return treinosCacheHub.filter((t) => !(t.dias_semana || []).length || t.dias_semana.includes(hojeIdx));
}

function renderizarTreinosHub() {
  const alvo = document.getElementById('conteudo-treino-hub');
  if (!treinosCacheHub.length) {
    alvo.innerHTML = '<p>Nenhum treino cadastrado ainda. Fale com seu instrutor.</p>';
    return;
  }
  const treinosHoje = treinosDeHoje();
  if (!treinosHoje.length) {
    alvo.innerHTML = '<div class="treino-card" style="text-align:center;padding:32px 16px"><div style="font-size:15px">Hoje é dia de descanso 💆</div><p style="color:#94a3b8;font-size:13px;margin-top:8px">Aproveite pra recuperar. Seu próximo treino aparece aqui no dia certo.</p></div>';
    return;
  }

  alvo.innerHTML = treinosHoje.map((t) => {
    const diasTexto = (t.dias_semana || []).map((d) => DIAS_SEMANA_PORTAL[d]).join(', ') || 'Sem dias definidos';
    const timer = obterTimer(t.id);
    const barraTimerHtml = `
      <div class="player-timer-bar" data-tid="${t.id}">
        <button type="button" class="player-timer-btn stop" data-acao="zerar-timer" title="Zerar cronômetro">■</button>
        <div class="player-timer-display" data-timer-display="${t.id}">${formatarTempoTimer(timer.seg)}</div>
        <button type="button" class="player-timer-btn play" data-acao="alternar-timer" title="Iniciar/Pausar">${timer.rodando ? '⏸' : '▶'}</button>
      </div>
    `;
    if (!t.exercicios.length) {
      return `
        <div class="treino-card" data-tid="${t.id}">
          <div class="treino-card-topo"><h4>${t.nome}</h4></div>
          <div class="dias">${diasTexto}</div>
          <p style="color:#94a3b8;font-size:13px">Nenhum exercício adicionado ainda.</p>
        </div>
      `;
    }

    const atual = escolherExercicioAtual(t.id, t.exercicios);
    treinoFocoExercicio[t.id] = atual.id;
    const concluidos = t.exercicios.filter((ex) => ex.concluido).length;

    return `
      <div class="treino-card" data-tid="${t.id}">
        <div class="treino-card-topo">
          <h4>${t.nome}</h4>
          <span class="badge-contagem">${concluidos} de ${t.exercicios.length} concluídos</span>
        </div>
        <div class="dias">${diasTexto}</div>
        ${barraTimerHtml}

        ${playerHeroMediaHtml(atual)}
        <div class="player-hero-nome">${atual.exercicio}</div>
        <div class="player-hero-detalhe">${[atual.series, atual.carga].filter(Boolean).join(' · ')}</div>
        ${atual.metodo ? `<span class="tag">⚡ ${atual.metodo}</span>` : ''}
        ${atual.intervalo ? `<span class="tag">⏱ ${atual.intervalo}</span>` : ''}
        ${atual.observacao ? `<div class="detalhe" style="margin-top:6px">${atual.observacao}</div>` : ''}
        ${atual.dica ? `<div class="detalhe">💡 ${atual.dica}</div>` : ''}

        <div class="player-nav-row">
          <button type="button" class="player-nav-btn" data-acao="anterior" title="Exercício anterior">◀</button>
          <button type="button" class="check-concluido grande ${atual.concluido ? 'marcado' : ''}" data-eid="${atual.id}" title="Marcar como concluído">${atual.concluido ? '✓' : ''}</button>
          <button type="button" class="player-nav-btn" data-acao="proximo" title="Próximo exercício">▶</button>
        </div>

        <!-- font-size:16px (2026-08-31) é o mínimo pra iOS NÃO dar zoom
             automático ao focar o campo — ver comentário grande no <head>. -->
        <div class="registro-carga" style="display:flex;gap:8px">
          <input type="text" class="input-peso-usado" placeholder="Peso usado (ex: 20kg)" value="${escapeHtml(atual.ultimo_peso_usado || '')}" style="flex:1;min-width:0;padding:8px;font-size:16px;border:1px solid #30384a;border-radius:8px;background:transparent;color:inherit" />
          <input type="number" class="input-reps-max" placeholder="Repetições" min="0" max="999" value="${atual.ultimo_repeticoes_max ?? ''}" style="width:100px;padding:8px;font-size:16px;border:1px solid #30384a;border-radius:8px;background:transparent;color:inherit" />
          <button type="button" class="btn-registrar" data-acao="registrar">Registrar</button>
        </div>

        <div class="player-ex-list">
          ${t.exercicios.map((ex) => `
            <div class="player-ex-row ${ex.id === atual.id ? 'ativo' : ''} ${ex.concluido ? 'concluido' : ''}" data-acao="focar" data-eid="${ex.id}">
              <div class="player-ex-thumb">${playerThumbHtml(ex)}</div>
              <div class="player-ex-nome">${ex.exercicio}</div>
              <div class="player-ex-series">${ex.series || ''}</div>
              <div class="player-ex-dot ${ex.concluido ? 'marcado' : ''}"></div>
            </div>
          `).join('')}
        </div>

        <button type="button" class="btn-concluir-treino" data-acao="concluir-treino" style="margin-top:14px;width:100%">Concluir treino</button>
      </div>
    `;
  }).join('');

  // Navegar pro exercício anterior/próximo do treino, ou pular direto pra um
  // pelo clique na lista compacta — só troca o "foco" e re-renderiza (dados
  // já estão em treinosCacheHub, não precisa buscar de novo no servidor).
  alvo.querySelectorAll('.player-nav-btn[data-acao]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const treinoId = btn.closest('.treino-card').dataset.tid;
      const treino = treinosCacheHub.find((t) => t.id === treinoId);
      if (!treino) return;
      const idxAtual = treino.exercicios.findIndex((e) => e.id === treinoFocoExercicio[treinoId]);
      const delta = btn.dataset.acao === 'proximo' ? 1 : -1;
      const proximo = treino.exercicios[(idxAtual + delta + treino.exercicios.length) % treino.exercicios.length];
      treinoFocoExercicio[treinoId] = proximo.id;
      renderizarTreinosHub();
    });
  });
  alvo.querySelectorAll('.player-ex-row[data-acao="focar"]').forEach((linha) => {
    linha.addEventListener('click', () => {
      const treinoId = linha.closest('.treino-card').dataset.tid;
      treinoFocoExercicio[treinoId] = linha.dataset.eid;
      renderizarTreinosHub();
    });
  });

  // Cronômetro: atualiza só o próprio texto a cada segundo (não chama
  // renderizarTreinosHub de novo — re-renderizar o card inteiro a cada tique
  // perderia o foco/cursor de quem estiver digitando peso/reps). Sobrevive a
  // re-renders motivados por outras ações porque busca o elemento pelo
  // seletor de novo a cada tique, em vez de guardar uma referência presa ao
  // DOM antigo.
  function iniciarTiqueTimer(treinoId) {
    const timer = obterTimer(treinoId);
    if (timer.intervalo) return;
    timer.intervalo = setInterval(() => {
      timer.seg += 1;
      const display = document.querySelector(`[data-timer-display="${treinoId}"]`);
      if (display) display.textContent = formatarTempoTimer(timer.seg);
    }, 1000);
  }
  function pararTiqueTimer(treinoId) {
    const timer = obterTimer(treinoId);
    if (timer.intervalo) { clearInterval(timer.intervalo); timer.intervalo = null; }
  }
  alvo.querySelectorAll('.player-timer-btn[data-acao="alternar-timer"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const treinoId = btn.closest('.player-timer-bar').dataset.tid;
      const timer = obterTimer(treinoId);
      timer.rodando = !timer.rodando;
      if (timer.rodando) iniciarTiqueTimer(treinoId); else pararTiqueTimer(treinoId);
      btn.textContent = timer.rodando ? '⏸' : '▶';
    });
  });
  alvo.querySelectorAll('.player-timer-btn[data-acao="zerar-timer"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const treinoId = btn.closest('.player-timer-bar').dataset.tid;
      pararTiqueTimer(treinoId);
      const timer = obterTimer(treinoId);
      timer.seg = 0;
      timer.rodando = false;
      const display = document.querySelector(`[data-timer-display="${treinoId}"]`);
      if (display) display.textContent = formatarTempoTimer(0);
      const btnPlay = btn.closest('.player-timer-bar').querySelector('[data-acao="alternar-timer"]');
      if (btnPlay) btnPlay.textContent = '▶';
    });
  });
  // Se o timer já estava rodando antes deste re-render (ex.: aluno navegou
  // pro próximo exercício com o cronômetro ligado), religa o tique sem
  // precisar tocar em play de novo — senão o setInterval antigo continuaria
  // rodando escrevendo num elemento que já não existe mais.
  alvo.querySelectorAll('.player-timer-bar[data-tid]').forEach((barra) => {
    const treinoId = barra.dataset.tid;
    if (obterTimer(treinoId).rodando) iniciarTiqueTimer(treinoId);
  });

  // Peso usado/repetições (2026-08-27, e 2026-09-02 o botão "Registrar"):
  // marcar o check já grava junto o que estiver preenchido nos campos de
  // peso/reps do exercício em foco (o aluno pode preencher antes ou depois
  // de tocar o check). "Registrar" faz a mesma chamada mas fica disponível
  // mesmo com o exercício já marcado — pra atualizar o peso depois de trocar
  // de carga no meio da série, sem precisar desmarcar/marcar de novo. Nos
  // dois casos, o peso informado agora também SUBSTITUI a carga prescrita
  // (ver POST /treino/exercicio/:id/concluir em portal.routes.js) até o
  // professor ajustar de novo. Mais de 13 repetições manda o exercício pras
  // Pendências do professor (ver LIMITE_REPETICOES_SEM_AJUSTE em
  // portal.routes.js) — avisa o aluno na hora também, só pra ele saber que o
  // professor vai revisar a carga.
  async function registrarExercicio(treinoId, exercicioId, marcarComo) {
    const card = alvo.querySelector(`.treino-card[data-tid="${treinoId}"]`);
    const pesoUsado = card.querySelector('.input-peso-usado').value.trim();
    const repsTexto = card.querySelector('.input-reps-max').value.trim();
    const repeticoesMax = repsTexto ? Number(repsTexto) : null;
    const resp = await api(`/api/portal/treino/exercicio/${exercicioId}/concluir`, {
      method: 'POST',
      body: JSON.stringify({
        cpf: cpfHubAtual, senha: senhaHubAtual, concluido: marcarComo,
        peso_usado: marcarComo ? (pesoUsado || null) : null,
        repeticoes_max: marcarComo ? repeticoesMax : null,
      }),
    });
    const treino = treinosCacheHub.find((t) => t.id === treinoId);
    const ex = treino && treino.exercicios.find((e) => e.id === exercicioId);
    if (ex) {
      ex.concluido = marcarComo;
      if (marcarComo) {
        if (pesoUsado) { ex.ultimo_peso_usado = pesoUsado; ex.carga = pesoUsado; }
        ex.ultimo_repeticoes_max = repeticoesMax;
      }
    }
    if (marcarComo && treino) {
      const proximo = treino.exercicios.find((e) => !e.concluido);
      if (proximo) treinoFocoExercicio[treinoId] = proximo.id;
    }
    renderizarTreinosHub();
    if (marcarComo && repeticoesMax != null && repeticoesMax > 13) {
      alert('Boa! Como você conseguiu mais de 13 repetições, seu professor vai revisar a carga desse exercício.');
    }
    if (marcarComo && resp.conquistas_novas && resp.conquistas_novas.length) {
      comemorarConquistas(resp.conquistas_novas);
      carregarGamificacaoHub();
    }
  }

  alvo.querySelectorAll('.check-concluido[data-eid]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const treinoId = btn.closest('.treino-card').dataset.tid;
      const marcarComo = !btn.classList.contains('marcado');
      try { await registrarExercicio(treinoId, btn.dataset.eid, marcarComo); }
      catch (err) { alert(err.message); }
    });
  });
  alvo.querySelectorAll('.btn-registrar[data-acao="registrar"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const treinoId = btn.closest('.treino-card').dataset.tid;
      const exercicioId = treinoFocoExercicio[treinoId];
      btn.disabled = true;
      try { await registrarExercicio(treinoId, exercicioId, true); }
      catch (err) { alert(err.message); }
      finally { btn.disabled = false; }
    });
  });

  // "Concluir treino" (2026-08-24): fecha a sessão de hoje — o check de cada
  // exercício já é só visual-do-dia (some sozinho amanhã, ver GET /treino),
  // mas este botão limpa na hora, sem esperar virar o dia, pra quem treina
  // mais de uma vez no mesmo dia conseguir marcar de novo. O registro
  // permanente de que o aluno treinou (pro professor) já foi gravado a cada
  // exercício marcado — este botão só ADICIONA um evento "treino concluído"
  // a mais nesse histórico, nunca substitui os anteriores.
  alvo.querySelectorAll('.btn-concluir-treino[data-acao="concluir-treino"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const treinoId = btn.closest('.treino-card').dataset.tid;
      btn.disabled = true;
      try {
        const resp = await api(`/api/portal/treino/${treinoId}/concluir-treino`, {
          method: 'POST',
          body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual }),
        });
        alert('Parabéns! Treino concluído. 💪');
        if (resp.conquistas_novas && resp.conquistas_novas.length) comemorarConquistas(resp.conquistas_novas);
        await abrirPainelTreino();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

// Conquistas/gamificação (2026-09-02, port do TreinoPro) — "Meu progresso":
// streak em semanas, total de treinos e a vitrine de badges (desbloqueadas
// coloridas, bloqueadas apagadas). Busca à parte de abrirPainelTreino (não
// bloqueia a tela de treino esperando isso) e de novo depois de qualquer
// ação que possa ter desbloqueado uma badge nova.
async function carregarGamificacaoHub() {
  const alvo = document.getElementById('conteudo-gamificacao-hub');
  if (!alvo) return;
  try {
    const resumo = await api(`/api/portal/gamificacao?cpf=${encodeURIComponent(cpfHubAtual)}&senha=${encodeURIComponent(senhaHubAtual)}`);
    renderizarGamificacaoHub(resumo);
  } catch { /* gamificação é só um extra visual — não trava o resto do portal se falhar */ }
}
function renderizarGamificacaoHub(resumo) {
  const alvo = document.getElementById('conteudo-gamificacao-hub');
  if (!alvo) return;
  const streakTexto = resumo.streakSemanas >= 1
    ? `🔥 ${resumo.streakSemanas} semana${resumo.streakSemanas === 1 ? '' : 's'} seguida${resumo.streakSemanas === 1 ? '' : 's'} · ${resumo.totalTreinos} treino${resumo.totalTreinos === 1 ? '' : 's'} registrado${resumo.totalTreinos === 1 ? '' : 's'} no total`
    : `${resumo.totalTreinos} treino${resumo.totalTreinos === 1 ? '' : 's'} registrado${resumo.totalTreinos === 1 ? '' : 's'} no total`;
  alvo.innerHTML = `
    <div class="progresso-card">
      <h4>Meu progresso</h4>
      <div class="progresso-streak">${streakTexto} · ${resumo.totalDesbloqueadas} de ${resumo.totalBadges} conquistas</div>
      <div class="badges-grid">
        ${resumo.badges.map((b) => `
          <div class="badge-item ${b.desbloqueada ? 'desbloqueada' : ''}" title="${escapeHtml(b.descricao)}">
            <span class="icone">${b.icone}</span>
            <span class="nome">${b.nome}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}
function comemorarConquistas(conquistas) {
  const texto = conquistas.map((c) => `${c.icone} ${c.nome}`).join('\n');
  alert(`Nova conquista desbloqueada!\n\n${texto}`);
}

document.getElementById('btn-abrir-treino').addEventListener('click', async () => {
  if (alunoHubTreinoModo === 'app_externo') {
    if (configApp.treino_app_url) window.open(configApp.treino_app_url, '_blank', 'noopener');
    else alert('O link do app de treino ainda não foi configurado pela academia.');
    return;
  }
  try {
    await abrirPainelTreino();
  } catch (err) {
    alert(err.message);
  }
});

// ---- Upgrade/troca de plano ----

document.getElementById('btn-abrir-upgrade').addEventListener('click', async () => {
  try {
    const planos = await api('/api/portal/planos');
    ocultarPaineisHub();
    document.getElementById('painel-hub-upgrade').classList.remove('oculto');
    const alvo = document.getElementById('lista-planos-upgrade');
    alvo.innerHTML = planos.map((p) => `
      <div class="plano-opcao">
        <div>
          <div style="font-weight:600">${p.nome}</div>
          <div style="font-size:13px;color:#94a3b8">${formatarMoeda(p.valor_centavos)}</div>
        </div>
        <button data-plano-id="${p.id}">Assinar</button>
      </div>
    `).join('') || '<p>Nenhum plano disponível no momento.</p>';

    alvo.querySelectorAll('button[data-plano-id]').forEach((btn) => {
      btn.addEventListener('click', () => assinarPlanoHub(btn.dataset.planoId));
    });
  } catch (err) {
    alert(err.message);
  }
});

async function assinarPlanoHub(planoId) {
  try {
    const resp = await api('/api/portal/upgrade', {
      method: 'POST',
      body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, plano_id: planoId }),
    });
    abrirPagamentoPixHub({
      titulo: `Assinar plano — ${formatarMoeda(resp.valor_centavos)}`,
      qrCodePix: resp.qr_code_pix,
      qrCodePixImagem: resp.qr_code_pix_imagem,
      statusUrl: `/api/portal/upgrade/status/${resp.cobranca_id}`,
      aoConfirmar: (statusResp) => {
        mostrarComprovanteHub({
          saudacao: `Plano ativado, ${statusResp.aluno_nome || ''}! Bem-vindo(a).`,
          itens: null,
          total: null,
        });
      },
    });
  } catch (err) {
    alert(err.message);
  }
}

// ---- Pagamento Pix genérico (contas ou upgrade) ----

function abrirPagamentoPixHub({ titulo, qrCodePix, qrCodePixImagem, statusUrl, aoConfirmar }) {
  ocultarPaineisHub();
  document.getElementById('painel-hub-pix').classList.remove('oculto');
  document.getElementById('pix-hub-titulo').textContent = titulo;
  document.getElementById('pix-hub-status').textContent = 'Aguardando pagamento...';

  const alvo = document.getElementById('qrcode-pix-hub');
  alvo.innerHTML = '';
  const btnCopiar = document.getElementById('btn-copiar-pix-hub');

  if (qrCodePixImagem) {
    const img = document.createElement('img');
    img.src = `data:image/png;base64,${qrCodePixImagem}`;
    img.style.width = '220px';
    img.style.height = '220px';
    img.style.borderRadius = '12px';
    alvo.appendChild(img);
  } else if (qrCodePix) {
    // eslint-disable-next-line no-new
    new QRCode(alvo, { text: qrCodePix, width: 220, height: 220, colorDark: '#0f172a', colorLight: '#ffffff' });
  }

  if (qrCodePix) {
    btnCopiar.classList.remove('oculto');
    btnCopiar.onclick = async () => {
      try {
        await navigator.clipboard.writeText(qrCodePix);
        btnCopiar.textContent = 'Código copiado!';
        setTimeout(() => { btnCopiar.textContent = 'Copiar código Pix'; }, 2000);
      } catch {
        alert(`Não foi possível copiar automaticamente. Código Pix:\n${qrCodePix}`);
      }
    };
  } else {
    btnCopiar.classList.add('oculto');
  }

  pararPollPixHub();
  const statusEl = document.getElementById('pix-hub-status');
  pixHubPollTimer = setInterval(async () => {
    try {
      const resp = await api(statusUrl);
      if (resp.pago) {
        pararPollPixHub();
        aoConfirmar(resp);
      }
    } catch (err) {
      statusEl.textContent = `Erro ao consultar pagamento: ${err.message}`;
    }
  }, 4000);
}

function pararPollPixHub() {
  if (pixHubPollTimer) {
    clearInterval(pixHubPollTimer);
    pixHubPollTimer = null;
  }
}

function mostrarComprovanteHub({ saudacao, itens, total }) {
  ocultarPaineisHub();
  document.getElementById('painel-hub-comprovante').classList.remove('oculto');
  document.getElementById('comprovante-hub-saudacao').textContent = saudacao;

  const linhas = (itens || []).map((it) => `
    <div class="linha"><span>${it.descricao || 'Conta'}</span><span>${formatarMoeda(it.valor_centavos)}</span></div>
  `).join('');
  const linhaTotal = total != null ? `<div class="linha"><span>Total pago</span><span>${formatarMoeda(total)}</span></div>` : '';
  document.getElementById('comprovante-hub-itens').innerHTML = linhas + linhaTotal;
}

document.getElementById('btn-comprovante-hub-ok').addEventListener('click', () => {
  resetHub();
  mostrarPagina('pagina-inicio');
});

// ---- Completar cadastro antes do 1o cadastro facial (2026-07-31) ----
// Pedido do dono do sistema, ao mandar o link do portal pra todos os alunos
// via WhatsApp pra fazerem o cadastro facial: muitos alunos antigos
// (importados do Secullum antes de telefone/e-mail/data de nascimento serem
// obrigatórios, ver terminal.routes.js/portal.routes.js) não têm esses dados
// no sistema. Antes de liberar a câmera do cadastro facial, checa se algum
// desses 4 campos está vazio — se estiver, mostra um formulário pré-preenchido
// com o que já existe (ver dadosPessoaisHubAtual, vindo de GET /aluno) e só
// libera a câmera depois de salvo.
const CAMPOS_OBRIGATORIOS_HUB = ['nome', 'telefone', 'email', 'data_nascimento'];

function camposFaltandoHub() {
  if (!dadosPessoaisHubAtual) return [];
  return CAMPOS_OBRIGATORIOS_HUB.filter((chave) => !String(dadosPessoaisHubAtual[chave] || '').trim());
}

function abrirCompletarCadastroHub() {
  ocultarPaineisHub();
  document.getElementById('painel-hub-completar-cadastro').classList.remove('oculto');
  document.getElementById('completar-cadastro-nome').value = dadosPessoaisHubAtual?.nome || '';
  document.getElementById('completar-cadastro-telefone').value = dadosPessoaisHubAtual?.telefone || '';
  document.getElementById('completar-cadastro-email').value = dadosPessoaisHubAtual?.email || '';
  document.getElementById('completar-cadastro-nascimento').value = dadosPessoaisHubAtual?.data_nascimento || '';
  document.getElementById('completar-cadastro-erro').textContent = '';
}

document.getElementById('btn-completar-cadastro-continuar').addEventListener('click', async () => {
  const nome = document.getElementById('completar-cadastro-nome').value.trim();
  const telefone = document.getElementById('completar-cadastro-telefone').value.trim();
  const email = document.getElementById('completar-cadastro-email').value.trim();
  const dataNascimento = document.getElementById('completar-cadastro-nascimento').value;
  const erroEl = document.getElementById('completar-cadastro-erro');
  erroEl.textContent = '';

  if (!nome || !telefone || !email || !dataNascimento) {
    erroEl.textContent = 'Preencha nome completo, telefone, e-mail e data de nascimento para continuar.';
    return;
  }

  try {
    await api('/api/portal/completar-cadastro', {
      method: 'POST',
      body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, nome, telefone, email, data_nascimento: dataNascimento }),
    });
    dadosPessoaisHubAtual = { nome, telefone, email, data_nascimento: dataNascimento };
    document.getElementById('hub-saudacao').textContent = `Olá, ${nome}!`;
    abrirCadastroFacialHub();
  } catch (err) {
    erroEl.textContent = err.message;
  }
});

// ---- Cadastro facial pelo hub (aluno já existente) ----

function abrirCadastroFacialHub() {
  ocultarPaineisHub();
  document.getElementById('painel-hub-facial').classList.remove('oculto');
  iniciarCadastroFacial({
    video: document.getElementById('video-facial-hub'),
    statusEl: document.getElementById('status-facial-hub'),
    cpf: cpfHubAtual,
    senha: senhaHubAtual,
    aoConcluir: () => {
      ocultarPaineisHub();
      document.getElementById('painel-hub-dashboard').classList.remove('oculto');
      document.getElementById('card-facial').classList.add('oculto');
    },
  });
}

document.getElementById('btn-trocar-camera-hub')?.addEventListener('click', () => {
  alternarCamera(document.getElementById('video-facial-hub'));
});

document.getElementById('btn-abrir-facial-hub').addEventListener('click', () => {
  if (camposFaltandoHub().length) {
    abrirCompletarCadastroHub();
    return;
  }
  abrirCadastroFacialHub();
});

// ---------------- Cadastro novo ----------------

let cadastroPortalCpfAtual = null;
let cadastroPortalSenhaAtual = null; // senha do portal já gerada no cadastro (ver POST /api/portal/cadastro)
let cadastroPortalPollTimer = null;

function resetCadastroPortal() {
  pararPollCadastroPortal();
  pararCamera();
  cadastroPortalCpfAtual = null;
  cadastroPortalSenhaAtual = null;
  document.getElementById('portal-cadastro-nome').value = '';
  document.getElementById('portal-cadastro-cpf').value = '';
  document.getElementById('portal-cadastro-telefone').value = '';
  document.getElementById('portal-cadastro-email').value = '';
  document.getElementById('portal-cadastro-nascimento').value = '';
  document.getElementById('portal-cadastro-indicado-cpf').value = '';
  document.getElementById('portal-cadastro-erro').textContent = '';
  document.getElementById('portal-cadastro-senha-caixa').textContent = '';
  document.getElementById('painel-cadastro-portal-form').classList.remove('oculto');
  document.getElementById('painel-cadastro-portal-pagamento').classList.add('oculto');
  document.getElementById('painel-cadastro-portal-sucesso').classList.add('oculto');
  document.getElementById('painel-cadastro-portal-facial').classList.add('oculto');
  document.getElementById('btn-copiar-pix-cadastro-portal').classList.add('oculto');
  carregarPlanosCadastroPortal();
}

async function carregarPlanosCadastroPortal() {
  const select = document.getElementById('portal-cadastro-plano');
  select.innerHTML = '<option value="">Carregando planos...</option>';
  try {
    // incluir_visitante=true só aqui (cadastro novo) — nunca no seletor de
    // upgrade (ver comentário em portal.routes.js GET /planos).
    const planos = await api('/api/portal/planos?incluir_visitante=true');
    select.innerHTML = planos.length
      ? planos.map((p) => `<option value="${p.id}">${p.nome} — ${formatarMoeda(p.valor_centavos)}</option>`).join('')
      : '<option value="">Nenhum plano disponível</option>';
  } catch {
    select.innerHTML = '<option value="">Não foi possível carregar os planos</option>';
  }
}

document.getElementById('btn-voltar-cadastro-portal').addEventListener('click', () => {
  resetCadastroPortal();
  mostrarPagina('pagina-inicio');
});

document.getElementById('btn-portal-cadastro-continuar').addEventListener('click', async () => {
  const nome = document.getElementById('portal-cadastro-nome').value.trim();
  const cpf = document.getElementById('portal-cadastro-cpf').value.trim();
  const telefone = document.getElementById('portal-cadastro-telefone').value.trim();
  const email = document.getElementById('portal-cadastro-email').value.trim();
  const dataNascimento = document.getElementById('portal-cadastro-nascimento').value;
  const planoId = document.getElementById('portal-cadastro-plano').value;
  const indicadoPorCpf = document.getElementById('portal-cadastro-indicado-cpf').value.trim();
  const erroEl = document.getElementById('portal-cadastro-erro');
  erroEl.textContent = '';

  if (!nome || !cpf || !telefone || !email || !dataNascimento || !planoId) {
    erroEl.textContent = 'Preencha nome, CPF, telefone, e-mail, data de nascimento e escolha um plano.';
    return;
  }

  try {
    const resp = await api('/api/portal/cadastro', {
      method: 'POST',
      body: JSON.stringify({
        nome, cpf, telefone, email, data_nascimento: dataNascimento, plano_id: planoId, indicado_por_cpf: indicadoPorCpf || null,
      }),
    });
    cadastroPortalCpfAtual = cpf;

    // Fluxo "visitante" (2026-07): sem Pix/matrícula — o próprio POST já
    // devolve o cadastro concluído. Sem senha própria ainda (será gerada no
    // primeiro login via "Já sou aluno", ver GET /api/portal/aluno).
    if (resp.visitante) {
      document.getElementById('painel-cadastro-portal-form').classList.add('oculto');
      document.getElementById('painel-cadastro-portal-sucesso').classList.remove('oculto');
      document.getElementById('portal-cadastro-sucesso-msg').textContent = `Cadastro de visitante concluído! Bem-vindo(a), ${resp.aluno_nome || ''}. Use "Já sou aluno" com seu CPF para acessar o portal e ver sua senha.`;
      document.getElementById('portal-cadastro-senha-caixa').textContent = '';
      return;
    }

    cadastroPortalSenhaAtual = resp.senha_acesso;
    document.getElementById('painel-cadastro-portal-form').classList.add('oculto');
    document.getElementById('painel-cadastro-portal-pagamento').classList.remove('oculto');
    document.getElementById('portal-cadastro-valor').textContent = `Valor: ${formatarMoeda(resp.valor_centavos)}`;
    document.getElementById('portal-cadastro-status').textContent = 'Aguardando pagamento...';

    const alvo = document.getElementById('qrcode-cadastro-portal');
    alvo.innerHTML = '';
    const btnCopiar = document.getElementById('btn-copiar-pix-cadastro-portal');

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
      btnCopiar.classList.remove('oculto');
      btnCopiar.onclick = async () => {
        try {
          await navigator.clipboard.writeText(resp.qr_code_pix);
          btnCopiar.textContent = 'Código copiado!';
          setTimeout(() => { btnCopiar.textContent = 'Copiar código Pix'; }, 2000);
        } catch {
          alert(`Não foi possível copiar automaticamente. Código Pix:\n${resp.qr_code_pix}`);
        }
      };
    } else {
      btnCopiar.classList.add('oculto');
    }

    iniciarPollCadastroPortal(resp.cobranca_id);
  } catch (err) {
    erroEl.textContent = err.message;
  }
});

function iniciarPollCadastroPortal(cobrancaId) {
  pararPollCadastroPortal();
  const statusEl = document.getElementById('portal-cadastro-status');
  cadastroPortalPollTimer = setInterval(async () => {
    try {
      const resp = await api(`/api/portal/cadastro/status/${cobrancaId}`);
      if (resp.pago) {
        pararPollCadastroPortal();
        document.getElementById('painel-cadastro-portal-pagamento').classList.add('oculto');
        document.getElementById('painel-cadastro-portal-sucesso').classList.remove('oculto');
        document.getElementById('portal-cadastro-sucesso-msg').textContent = `Pagamento confirmado! Bem-vindo(a), ${resp.aluno_nome || ''}. Sua matrícula já está ativa.`;
        document.getElementById('portal-cadastro-senha-caixa').textContent = cadastroPortalSenhaAtual || '';
      }
    } catch (err) {
      statusEl.textContent = `Erro ao consultar pagamento: ${err.message}`;
    }
  }, 4000);
}

function pararPollCadastroPortal() {
  if (cadastroPortalPollTimer) {
    clearInterval(cadastroPortalPollTimer);
    cadastroPortalPollTimer = null;
  }
}

document.getElementById('btn-portal-cadastro-facial').addEventListener('click', async () => {
  document.getElementById('painel-cadastro-portal-sucesso').classList.add('oculto');
  document.getElementById('painel-cadastro-portal-facial').classList.remove('oculto');
  await iniciarCadastroFacial({
    video: document.getElementById('video-cadastro-portal-facial'),
    statusEl: document.getElementById('status-cadastro-portal-facial'),
    cpf: cadastroPortalCpfAtual,
    senha: cadastroPortalSenhaAtual,
    aoConcluir: () => { resetCadastroPortal(); mostrarPagina('pagina-inicio'); },
  });
});

document.getElementById('btn-trocar-camera-cadastro-portal')?.addEventListener('click', () => {
  alternarCamera(document.getElementById('video-cadastro-portal-facial'));
});

document.getElementById('btn-portal-cadastro-concluir').addEventListener('click', () => {
  resetCadastroPortal();
  mostrarPagina('pagina-inicio');
});

// ---------------- Inicialização ----------------

// 2026-08-31: o truque de resetar o <meta viewport> a cada campo perder o
// foco (tentativa anterior, pra "soltar" um zoom grudado) foi REMOVIDO —
// relato real de que deixava a tela inteira com aparência "zoomada pra
// fora" (elementos pequenos, muito espaço em volta). A causa raiz de
// verdade era font-size < 16px em alguns campos (corrigido — ver
// input-peso-usado/input-reps-max acima) brigando com o zoom já travado no
// <meta viewport> (ver portal.html) — com a causa raiz corrigida, o zoom
// trava em 100% de forma estável sem precisar desse reset manual.

carregarConfigPublica();
tentarAutoLoginHub();
