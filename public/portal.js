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
    erro.status = resp.status; // distingue "servidor recusou a credencial" (401/404) de "servidor com problema" (500) pra quem precisar decidir se foi erro do usuário ou instabilidade passageira
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

// Combos (ex.: avaliação física a cada 90 dias): o aluno escolhe junto com a modalidade e o valor mensal já inclui o adicional.
function seletorComboHtml(p) {
  const combos = Array.isArray(p.combos) ? p.combos : [];
  if (!combos.length) return '';
  const base = '<option value="nenhum" data-total="' + p.valor_final_centavos + '">Só o plano</option>';
  const opcoes = combos.map((c) => '<option value="' + escapeHtml(c.id) + '" data-total="' + c.valor_total_centavos + '">' + escapeHtml((function (n) { return n.charAt(0).toUpperCase() + n.slice(1); })(String(c.nome).replace(/^Plano \+ /i, ''))) + ' (+' + formatarMoeda(c.adicional_centavos) + ')</option>').join('');
  return '<label style="display:block;font-size:12px;margin:10px 0 4px;color:inherit;opacity:.8">Quer incluir uma avaliação física?</label>' +
    '<select data-combo-de="' + escapeHtml(p.id) + '" style="width:100%;padding:10px;border-radius:8px;font-size:16px">' + base + opcoes + '</select>' +
    '<small style="display:block;margin-top:4px;opacity:.75">O adicional entra no valor mensal. A liberação da avaliação segue a regra da modalidade.</small>';
}
function ligarSeletoresCombo(container) {
  container.querySelectorAll('select[data-combo-de]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const alvo = container.querySelector('[data-preco-de="' + sel.dataset.comboDe + '"]');
      const total = Number(sel.selectedOptions[0] && sel.selectedOptions[0].dataset.total);
      if (alvo && Number.isFinite(total)) alvo.textContent = formatarMoeda(total) + '/mês';
    });
  });
}
function comboEscolhido(container, modalidade) {
  const sel = container.querySelector('select[data-combo-de="' + modalidade + '"]');
  return sel ? sel.value : undefined;
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

/**
 * Card "Pague no automático" (assinatura Mercado Pago). Só aparece quando o servidor
 * diz que está disponível para este aluno (recurso ligado, matrícula recorrente
 * ativa, ainda sem assinatura autorizada). O clique cria/reaproveita a assinatura
 * e abre a página de oferta.
 */
async function carregarCardAssinaturaHub() {
  const container = document.getElementById('feed-assinatura-hub');
  if (!container || !cpfHubAtual || !senhaHubAtual) return;
  container.innerHTML = '';
  try {
    const d = await api(`/api/portal/assinatura?cpf=${encodeURIComponent(cpfHubAtual)}&senha=${encodeURIComponent(senhaHubAtual)}`);
    if (!d.disponivel) return;
    const resposta = await api('/api/portal/cadastro/recorrencia/planos?cpf=' + encodeURIComponent(String(cpfHubAtual || '').replace(/\D/g, '')));
    const opcoes = Array.isArray(resposta.opcoes) ? resposta.opcoes : [];
    if (!opcoes.length) return;
    const cards = opcoes.map((p, i) => {
      const mensal = formatarMoeda(p.valor_final_centavos);
      const detalhe = p.limite_cobrancas
        ? String(p.limite_cobrancas) + ' cobranças mensais de ' + mensal
        : 'Cobrança mensal contínua • Sem permanência mínima';
      const desconto = p.desconto_centavos > 0
        ? '<small style="display:block;color:#64748b">De ' + formatarMoeda(p.valor_centavos) + ' por mês</small>' : '';
      const cor = i === 0 ? '#166534' : '#1d4ed8';
      return '<div style="background:#fff;color:#0f172a;border-radius:12px;padding:14px"><strong style="font-size:16px">' +
        escapeHtml(p.nome) + '</strong><div data-preco-de="' + escapeHtml(p.id) + '" style="font-size:27px;font-weight:900;margin:4px 0;color:' + cor + '">' +
        mensal + '/mês</div>' + desconto + '<div style="font-size:13px;color:#475569">' + escapeHtml(detalhe) +
        '</div>' + seletorComboHtml(p) + '<button type="button" data-modalidade="' + escapeHtml(p.id) + '" data-rotulo="' + escapeHtml(p.nome) +
        '" style="width:100%;margin-top:12px;border:0;border-radius:9px;padding:12px;font-size:15px;font-weight:800;color:#fff;background:' +
        (i === 0 ? '#15803d' : '#1d4ed8') + ';cursor:pointer">Escolher ' + escapeHtml(p.nome) + '</button></div>';
    }).join('');
    container.innerHTML = `
      <div class="cartao" style="text-align:left;background:linear-gradient(135deg,#0f172a,#1d4ed8);color:#fff;border:0;box-shadow:0 10px 30px rgba(29,78,216,.35)">
        <div style="display:inline-block;background:rgba(250,204,21,.18);color:#facc15;border:1px solid rgba(250,204,21,.5);border-radius:999px;padding:4px 10px;font-size:11px;font-weight:800;letter-spacing:.06em">⚡ PAGAMENTO AUTOMÁTICO</div>
        <h3 style="margin:10px 0 4px;color:#fff;font-size:20px">Escolha como prefere pagar</h3>
        <p style="margin:0 0 14px;color:#dbeafe">A cobrança acontece automaticamente no cartão. Consulte as condições de cada modalidade antes de confirmar.</p>
        <div style="display:grid;gap:12px">${cards}</div>
        <p style="font-size:11px;color:#dbeafe;margin:12px 0 0">O cartão é cadastrado diretamente no Mercado Pago.</p>
      </div>`;
    ligarSeletoresCombo(container);
    container.querySelectorAll('[data-modalidade]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const modalidade = btn.dataset.modalidade;
        const combo = comboEscolhido(container, modalidade);
        const botoes = Array.from(container.querySelectorAll('[data-modalidade]'));
        botoes.forEach((b) => { b.disabled = true; b.textContent = 'Abrindo…'; });
        try {
          const r = await api('/api/portal/assinatura', {
            method: 'POST',
            body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, modalidade, combo }),
          });
          window.location.href = r.oferta_url;
        } catch (err) {
          botoes.forEach((b) => { b.disabled = false; b.textContent = 'Escolher ' + b.dataset.rotulo; });
          alert(err.message || 'Não foi possível abrir agora. Tente novamente em instantes.');
        }
      });
    });
  } catch {
    // Não é crítico: sem card, o resto do hub segue normal.
  }
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
  // Se o auto-login (tentarAutoLoginHub, na inicialização) já restaurou uma
  // sessão salva, NÃO reseta — resetHub() apagaria cpfHubAtual/senhaHubAtual
  // e mostraria a tela de CPF/senha de novo, desfazendo o login automático
  // bem na hora que o aluno entra no hub (bug real: o auto-login nunca tinha
  // efeito nenhum por causa disso).
  if (!cpfHubAtual) resetHub();
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
    mostrarPagina('pagina-hub'); // pula a tela "Já sou aluno" — é isto que faz o login persistente valer a pena
  } catch (err) {
    // Só apaga a credencial salva se o SERVIDOR respondeu recusando de
    // verdade (401 senha errada, 404 aluno removido) — 401/404 são os únicos
    // status que a rota GET /portal/aluno usa pra "credencial inválida" (ver
    // portal.routes.js). Qualquer outra coisa (500 de instabilidade no banco,
    // falha de rede/timeout sem resposta nenhuma) NÃO prova que a credencial
    // é inválida — mantém salva e deixa tentar de novo na próxima abertura,
    // em vez de forçar login manual por causa de um problema passageiro.
    if (err.status === 401 || err.status === 404) limparCredenciaisHub();
    painelCpf.classList.remove('oculto');
  }
}
let alunoHubTreinoModo = 'nativo';
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
  ['painel-hub-primeiro-acesso', 'painel-hub-dashboard', 'painel-hub-contas', 'painel-hub-conta', 'painel-hub-upgrade-escolha', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-comprovante', 'painel-hub-completar-cadastro', 'painel-hub-facial', 'painel-hub-avaliacoes']
    .forEach((id) => document.getElementById(id).classList.add('oculto'));
  const avisoVencimento = document.getElementById('aviso-vencimento-hub');
  avisoVencimento.classList.add('oculto');
  avisoVencimento.textContent = '';
  document.getElementById('btn-chamar-professor-flutuante').classList.add('oculto');
}

// 2026-07: antes esse botão sempre resetava tudo e voltava pro início (digitar
// CPF de novo), mesmo estando só um nível dentro (ex: na tela de Contas ou
// Treino, depois de já ter aberto o menu). Agora ele volta um nível de cada
// vez: se tiver algum painel de submenu aberto (contas/treino/plano/pix/
// facial), fecha esse painel e volta pro menu principal (painel-hub-
// dashboard); só faz o reset completo pro início quando já está no menu
// principal (ou na tela de CPF).
// ---- Biblioteca de exercícios (consulta; só matrícula ativa) ----
let bibliotecaPortal = [];
let bibGrupo = 'todos';
function normalizarBibPortal(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }

// Miniatura: a imagem cadastrada no exercício; se não houver, a capa do vídeo do YouTube.
function miniaturaBibliotecaPortal(e) {
  if (e.imagem_url) return e.imagem_url;
  const m = String(e.video_url || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/);
  return m ? 'https://i.ytimg.com/vi/' + m[1] + '/mqdefault.jpg' : '';
}

function renderizarBibliotecaPortal() {
  const termos = normalizarBibPortal(document.getElementById('bib-busca').value).split(/\s+/).filter(Boolean);
  const lista = bibliotecaPortal
    .filter((e) => bibGrupo === 'todos' || e.grupo_muscular === bibGrupo)
    .filter((e) => { const alvo = normalizarBibPortal(e.nome + ' ' + e.grupo_muscular); return termos.every((t) => alvo.includes(t)); });
  document.getElementById('bib-contagem').textContent = lista.length + ' de ' + bibliotecaPortal.length + ' exercícios';
  const alvo = document.getElementById('bib-lista');
  if (!lista.length) { alvo.innerHTML = '<p style="color:#94a3b8">Nenhum exercício encontrado.</p>'; return; }
  alvo.innerHTML = lista.map((e) => {
    const tags = (e.equipamento ? '<span class="tag">' + escapeHtml(e.equipamento) + '</span>' : '') + (e.dificuldade ? '<span class="tag">' + escapeHtml(e.dificuldade) + '</span>' : '');
    const miniatura = miniaturaBibliotecaPortal(e);
    // A miniatura é o botão que abre o vídeo (carregado só no toque). Sem vídeo, só a imagem, se houver.
    const thumb = miniatura
      ? '<button type="button" ' + (e.video_url ? 'data-bib-video="' + escapeHtml(e.id) + '" aria-label="Ver execução"' : 'disabled') + ' style="position:relative;flex:0 0 112px;width:112px;height:68px;border:none;padding:0;border-radius:8px;overflow:hidden;background:#000;cursor:' + (e.video_url ? 'pointer' : 'default') + '">' +
        '<img src="' + escapeHtml(miniatura) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">' +
        (e.video_url ? '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><span style="background:rgba(0,0,0,.6);color:#fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:13px">&#9654;</span></span>' : '') + '</button>'
      : '';
    return '<div class="item-conta" style="display:block"><div style="display:flex;gap:12px;align-items:center">' + thumb +
      '<div style="min-width:0"><div style="font-weight:700">' + escapeHtml(e.nome) + '</div>' +
      '<div style="font-size:13px;color:#94a3b8">' + escapeHtml(e.grupo_muscular) + tags + '</div></div></div>' +
      (e.video_url ? '<div id="bibv-' + escapeHtml(e.id) + '"></div>' : '') +
      (e.instrucoes ? '<div style="font-size:14px;color:#cbd5e1;margin-top:8px">' + escapeHtml(e.instrucoes) + '</div>' : '') + '</div>';
  }).join('');
  // O vídeo só é carregado quando o aluno toca em "Ver execução" (nada pesado abre junto com a lista).
  alvo.querySelectorAll('[data-bib-video]').forEach((btn) => btn.addEventListener('click', () => {
    const ex = bibliotecaPortal.find((x) => x.id === btn.dataset.bibVideo);
    const box = document.getElementById('bibv-' + btn.dataset.bibVideo);
    box.innerHTML = box.innerHTML ? '' : videoPreviewHtml(ex.video_url);
  }));
}

function renderizarGruposBibliotecaPortal() {
  const grupos = ['todos', ...new Set(bibliotecaPortal.map((e) => e.grupo_muscular))];
  const box = document.getElementById('bib-grupos');
  box.innerHTML = grupos.map((g) => '<button type="button" class="tag" data-bib-grupo="' + escapeHtml(g) + '" style="border:none;cursor:pointer;margin:0;padding:8px 12px;font-size:14px' + (g === bibGrupo ? ';background:#10b981;color:#052e22;font-weight:700' : '') + '">' + (g === 'todos' ? 'Todos' : escapeHtml(g)) + '</button>').join('');
  box.querySelectorAll('[data-bib-grupo]').forEach((b) => b.addEventListener('click', () => { bibGrupo = b.dataset.bibGrupo; renderizarGruposBibliotecaPortal(); renderizarBibliotecaPortal(); }));
}

document.getElementById('btn-abrir-biblioteca').addEventListener('click', async () => {
  const btn = document.getElementById('btn-abrir-biblioteca');
  btn.disabled = true;
  document.getElementById('bib-card-erro').textContent = '';
  try {
    const resp = await api('/api/portal/biblioteca?cpf=' + encodeURIComponent(cpfHubAtual) + '&senha=' + encodeURIComponent(senhaHubAtual));
    bibliotecaPortal = resp.exercicios || [];
    bibGrupo = 'todos';
    ocultarPaineisHub();
    document.getElementById('painel-hub-biblioteca').classList.remove('oculto');
    document.getElementById('bib-erro').textContent = '';
    document.getElementById('bib-busca').value = '';
    renderizarGruposBibliotecaPortal();
    renderizarBibliotecaPortal();
  } catch (err) {
    document.getElementById('bib-card-erro').textContent = err.message || 'Não foi possível abrir a biblioteca agora.';
  }
  btn.disabled = false;
});
document.getElementById('bib-busca').addEventListener('input', renderizarBibliotecaPortal);

// Pesquisa por voz: usa o reconhecimento de voz do próprio navegador (pt-BR). Sem suporte, o botão nem aparece.
(function ligarVozBiblioteca() {
  const Reconhecimento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById('btn-bib-voz');
  if (!Reconhecimento || !btn) return;
  btn.classList.remove('oculto');
  const campo = document.getElementById('bib-busca');
  const status = document.getElementById('bib-voz-status');
  let rec = null;
  let ouvindo = false;
  function parar() { try { rec && rec.stop(); } catch (e) { /* já parado */ } }
  function fim() { ouvindo = false; btn.style.background = '#10b981'; btn.innerHTML = '&#127908;'; }
  btn.addEventListener('click', () => {
    if (ouvindo) { parar(); return; }
    document.getElementById('bib-erro').textContent = '';
    rec = new Reconhecimento();
    rec.lang = 'pt-BR';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => { ouvindo = true; btn.style.background = '#ef4444'; btn.innerHTML = '&#9724;'; status.textContent = 'Ouvindo... fale o nome do exercício ou o grupo.'; };
    rec.onresult = (ev) => {
      let texto = '';
      for (let i = 0; i < ev.results.length; i += 1) texto += ev.results[i][0].transcript;
      campo.value = texto.replace(/[.,!?]+$/g, '').trim();
      renderizarBibliotecaPortal();
    };
    rec.onerror = (ev) => {
      const msgs = { 'not-allowed': 'Permita o uso do microfone no navegador para pesquisar por voz.', 'service-not-allowed': 'Permita o uso do microfone no navegador para pesquisar por voz.', 'no-speech': 'Não ouvi nada. Toque no microfone e tente de novo.', 'audio-capture': 'Não encontrei um microfone neste aparelho.', network: 'Sem conexão para reconhecer a voz. Digite a pesquisa.' };
      document.getElementById('bib-erro').textContent = msgs[ev.error] || 'Não consegui reconhecer a voz agora. Digite a pesquisa.';
    };
    rec.onend = () => { fim(); status.textContent = ''; };
    try { rec.start(); } catch (e) { fim(); }
  });
})();

document.getElementById('btn-voltar-hub').addEventListener('click', () => {
  const SUBPAINEIS_HUB = ['painel-hub-conta', 'painel-hub-upgrade-escolha', 'painel-hub-contas', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-completar-cadastro', 'painel-hub-facial', 'painel-hub-avaliacoes', 'painel-hub-notificacoes', 'painel-hub-biblioteca'];
  const painelAberto = SUBPAINEIS_HUB.find((id) => !document.getElementById(id).classList.contains('oculto'));
  if (painelAberto) {
    if (painelAberto === 'painel-hub-pix') pararPollPixHub();
    if (painelAberto === 'painel-hub-facial') pararCamera();
    ocultarPaineisHub();
    // Da página de uma conta, volta para a lista de contas; da escolha de pagamento do plano, para a lista de planos.
    document.getElementById(painelAberto === 'painel-hub-conta' ? 'painel-hub-contas' : (painelAberto === 'painel-hub-upgrade-escolha' ? 'painel-hub-upgrade' : 'painel-hub-dashboard')).classList.remove('oculto');
    return;
  }
  resetHub();
  mostrarPagina('pagina-inicio');
});

// "Chamar professor" (2026-09-02) — mesmo aviso via Telegram das tags NFC
// coladas nos aparelhos (ver POST /api/portal/chamar-professor em
// portal.routes.js), só que disparado pelo aluno direto do portal.
// `exercicio` (opcional) é o nome do exercício em foco no player do treino
// — quando informado, o professor já sabe onde ir sem precisar perguntar.
// `botao` é desabilitado durante a chamada (evita duplo clique) e continua
// desabilitado por alguns segundos depois de um sucesso, só como reforço
// visual — o cooldown de verdade (60s por aluno) é aplicado no servidor.
async function chamarProfessor(exercicio, botao) {
  if (botao) botao.disabled = true;
  try {
    const resp = await api('/api/portal/chamar-professor', {
      method: 'POST',
      body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, exercicio: exercicio || undefined }),
    });
    // 2026-09-04: resp aqui é o formato de enviarParaTodoStaff() em
    // webPush.service.js — {enviados, removidos} ou, em cooldown,
    // {enviados:0, motivo:'cooldown'} (ver POST /chamar-professor em
    // portal.routes.js). NUNCA tem um campo "enviado" (singular) — esse
    // formato era do notificarInstrutor/Telegram antigo, trocado em
    // 2026-09-02 pro Web Push, mas esta checagem ficou comparando um campo
    // que não existe mais (`resp.enviado === false`, sempre falso porque
    // undefined !== false) — bug real relatado: 2ª chamada (depois de trocar
    // de exercício, dentro da janela de cooldown) mostrava "Professor
    // avisado!" mesmo sem nenhum push ter saído de verdade.
    if (resp.motivo === 'cooldown') {
      alert('Você já chamou o professor há pouco — ele já está a caminho!');
    } else {
      alert('Professor avisado! 🔔 Ele já está vindo.');
    }
  } catch (err) {
    alert(err.message);
  } finally {
    if (botao) setTimeout(() => { botao.disabled = false; }, 5000);
  }
}

document.getElementById('btn-chamar-professor-flutuante').addEventListener('click', (ev) => {
  chamarProfessor(null, ev.currentTarget);
});

function preencherDashboardHub(info) {
  alunoHubTreinoModo = info.treino_modo || 'nativo';
  dadosPessoaisHubAtual = info.dados_pessoais || null;

  document.getElementById('hub-saudacao').textContent = `Olá, ${info.aluno_nome}!`;
  document.getElementById('painel-hub-cpf').classList.add('oculto');
  document.getElementById('painel-hub-primeiro-acesso').classList.add('oculto');
  document.getElementById('painel-hub-dashboard').classList.remove('oculto');
  document.getElementById('btn-chamar-professor-flutuante').classList.remove('oculto');
  irParaTopo();

  document.getElementById('card-plano-resumo').textContent = info.plano_atual
    ? `${info.plano_atual.plano_nome} — ${formatarMoeda(info.plano_atual.valor_centavos)}/ciclo`
    : 'Nenhum plano ativo no momento.';

  // O treino não é mais bloqueado por mensalidade em atraso (2026-10-13): só some
  // quando o professor oculta, o prazo "Ocultar do aluno após" do treino acaba, ou
  // o cadastro do aluno está inativo ou trancado (treino_oculto — o cartão inteiro some).
  document.getElementById('card-treino').classList.toggle('oculto', Boolean(info.treino_oculto));
  document.getElementById('card-treino-resumo').textContent = alunoHubTreinoModo === 'app_externo'
    ? 'Seu treino é acompanhado em outro aplicativo.'
    : 'Toque para ver seus treinos cadastrados.';
  document.getElementById('btn-abrir-treino').disabled = false;

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
  carregarCardAssinaturaHub();
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

function htmlDireitoAvaliacao(d) {
  if (!d || !d.tem_combo) return '';
  const nome = escapeHtml(String(d.combo_nome || 'avaliação').replace(/^Plano \+ /i, ''));
  if (d.disponivel) return '<strong style="color:#10b981">✅ Sua ' + nome + ' está liberada.</strong> Fale com a recepção para agendar.';
  if (d.motivo === 'aguardando_terceira_cobranca') return '🔒 Sua ' + nome + ' é liberada após a 3ª mensalidade paga (faltam ' + d.faltam_cobrancas + ').';
  if (d.disponivel_em) return '⏳ Sua ' + nome + ' será liberada em ' + formatarData(d.disponivel_em) + ' (a avaliação atual ainda está válida).';
  return '';
}

async function carregarAvaliacoesHub() {
  const cardAvaliacao = document.getElementById('card-avaliacao');
  const botaoVer = document.getElementById('btn-ver-avaliacoes-hub');
  const resumo = document.getElementById('card-avaliacao-resumo');
  try {
    const resp = await api(`/api/portal/avaliacoes?cpf=${encodeURIComponent(cpfHubAtual)}&senha=${encodeURIComponent(senhaHubAtual)}`);
    avaliacoesHubAtual = resp.avaliacoes || [];
    const direitoHtml = htmlDireitoAvaliacao(resp.direito);
    if (!avaliacoesHubAtual.length && direitoHtml) {
      cardAvaliacao.classList.remove('oculto');
      botaoVer.classList.add('oculto');
      resumo.innerHTML = direitoHtml;
    } else if (avaliacoesHubAtual.length) {
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
      resumo.innerHTML = `${avisoHtml}Última avaliação em ${formatarData(ultima.data)}. Toque para ver sua evolução.${direitoHtml ? '<br>' + direitoHtml : ''}`;
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

  // 2026-09-09 (pedido explícito, segunda vez): antes só mostrava 1-2
  // métricas curadas por tipo (METRICAS_HUB acima) pra não "virar uma
  // segunda tela de profissional" — mas o aluno quer o relatório completo,
  // com todos os campos, igual ao que sai do AvaliaPro pro staff. Mostra o
  // botão de relatório/comparador só quando há avaliação de verdade.
  document.getElementById('btn-relatorio-completo-avaliacoes').classList.toggle('oculto', avaliacoes.length === 0);
  document.getElementById('bloco-comparar-avaliacoes').classList.toggle('oculto', avaliacoes.length === 0);
  if (avaliacoes.length) popularComparadorAvaliacoes();
}

// ---------------- Relatório completo de avaliações (PDF) + comparador ----
// Mesma estratégia do AvaliaPro (ver avaliapro/public/app/relatorio.js):
// janela nova com HTML de impressão, sem biblioteca de PDF — Ctrl+P vira
// PDF nativamente, com texto selecionável/pesquisável (não uma imagem).

// Rótulo + unidade amigável pra cada chave conhecida de fields/computed —
// chave desconhecida cai no próprio nome da chave, sem quebrar o relatório.
const ROTULOS_CAMPOS_AVALIACAO = {
  peso: ['Peso', ' kg'], altura: ['Altura', ' cm'], idade: ['Idade', ' anos'], sexo: ['Sexo', ''],
  cintura: ['Cintura', ' cm'], quadril: ['Quadril', ' cm'], torax: ['Tórax', ' cm'],
  braco_d: ['Braço (direito)', ' cm'], braco_e: ['Braço (esquerdo)', ' cm'],
  coxa_d: ['Coxa (direita)', ' cm'], coxa_e: ['Coxa (esquerda)', ' cm'],
  gordura: ['% de gordura (bioimpedância)', '%'],
  peitoral: ['Dobra peitoral', ' mm'], triceps: ['Dobra tríceps', ' mm'], subescapular: ['Dobra subescapular', ' mm'],
  suprailiaca: ['Dobra suprailíaca', ' mm'], abdominal: ['Dobra abdominal', ' mm'], coxa: ['Dobra coxa', ' mm'],
  axilar: ['Dobra axilar média', ' mm'],
};
const ROTULOS_COMPUTED_AVALIACAO = {
  somaDobras: ['Soma das dobras', ' mm'], densidade: ['Densidade corporal', ' g/cm³'],
  bf: ['% de gordura (Siri)', '%'], massaGorda: ['Massa gorda', ' kg'], massaMagra: ['Massa magra', ' kg'],
  imc: ['IMC', ''], rcq: ['Relação cintura-quadril', ''],
};
// Chaves "*Label" (bfLabel, imcLabel, rcqLabel...) são anexadas ao valor da
// métrica principal ("16.7% — Atlético"), não viram linha própria.
function chaveLabelPara(chave) { return `${chave}Label`; }

function escHtmlAv(v) { return escapeHtml(v == null ? '' : String(v)); }

function formatarNumeroAv(v, casas) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const c = casas != null ? casas : (Math.abs(n) < 10 ? 2 : 1);
  return n.toFixed(c).replace('.', ',');
}

// Linhas de exibição (rótulo + valor formatado) pra uma avaliação — usado
// tanto no histórico completo quanto, campo a campo, na comparação.
function linhasDetalheAvaliacao(av) {
  const linhas = [];
  const fields = av.fields || {};
  Object.keys(fields).forEach((chave) => {
    if (chave.endsWith('Label')) return;
    const valor = fields[chave];
    if (valor === '' || valor == null) return;
    const [rotulo, unidade] = ROTULOS_CAMPOS_AVALIACAO[chave] || [chave, ''];
    const numerico = typeof valor === 'number' || (!Number.isNaN(parseFloat(String(valor).replace(',', '.'))) && String(valor).trim() !== '');
    linhas.push({
      chave: `fields.${chave}`,
      rotulo,
      valorTexto: numerico ? `${formatarNumeroAv(valor)}${unidade}` : escHtmlAv(valor),
      valorNumerico: numerico ? Number(String(valor).replace(',', '.')) : null,
      unidade,
    });
  });
  const computed = av.computed || {};
  Object.keys(computed).forEach((chave) => {
    if (chave.endsWith('Label')) return;
    const valor = computed[chave];
    if (valor === '' || valor == null) return;
    const [rotulo, unidade] = ROTULOS_COMPUTED_AVALIACAO[chave] || [chave, ''];
    const rotuloExtra = computed[chaveLabelPara(chave)];
    const numerico = typeof valor === 'number';
    linhas.push({
      chave: `computed.${chave}`,
      rotulo,
      valorTexto: (numerico ? `${formatarNumeroAv(valor, chave === 'densidade' ? 5 : chave === 'rcq' ? 2 : undefined)}${unidade}` : escHtmlAv(valor)) + (rotuloExtra ? ` — ${escHtmlAv(rotuloExtra)}` : ''),
      valorNumerico: numerico ? valor : null,
      unidade,
    });
  });
  return linhas;
}

// Gráfico de evolução maior, em fundo claro (a janela do relatório é
// impressa/salva em PDF — fundo escuro desperdiça tinta e fica ruim
// impresso). Mesma ideia do sparklineHub, só que com eixo de datas.
function graficoEvolucaoAv(pontos, unidade) {
  const W = 320, H = 120, PAD_X = 10, PAD_Y = 18;
  const valores = pontos.map((p) => p.valor);
  let min = Math.min(...valores), max = Math.max(...valores);
  const folga = Math.max((max - min) * 0.2, Math.abs(max) * 0.03 || 1);
  min -= folga; max += folga;
  const px = (i) => PAD_X + (i / (pontos.length - 1)) * (W - PAD_X * 2);
  const py = (v) => H - PAD_Y - ((v - min) / (max - min || 1)) * (H - PAD_Y * 2);
  const d = pontos.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(p.valor).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    <path d="${d}" fill="none" stroke="#2a8f5e" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pontos.map((p, i) => `
      <circle cx="${px(i).toFixed(1)}" cy="${py(p.valor).toFixed(1)}" r="${i === pontos.length - 1 ? 3.5 : 2.5}" fill="#2a8f5e"/>
      <text x="${px(i).toFixed(1)}" y="${H - 3}" text-anchor="middle" font-size="9" fill="#5d6b7d">${formatarData(p.data).slice(0, 5)}</text>
      <text x="${px(i).toFixed(1)}" y="${(py(p.valor) - 7).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#17202b">${formatarNumeroAv(p.valor)}${unidade}</text>
    `).join('')}
  </svg>`;
}

// Une TODAS as chaves numéricas (fields.* e computed.*) presentes em pelo
// menos uma avaliação da lista — diferente de METRICAS_HUB (curado, 1-2 por
// tipo), aqui é "todas as informações", uma seção de gráfico por métrica.
function metricasPresentesNaLista(lista) {
  const chaves = new Map(); // chave completa -> {rotulo, unidade}
  lista.forEach((av) => {
    linhasDetalheAvaliacao(av).forEach((l) => {
      if (l.valorNumerico == null) return;
      if (!chaves.has(l.chave)) chaves.set(l.chave, { rotulo: l.rotulo, unidade: l.unidade });
    });
  });
  return [...chaves.entries()].map(([chave, meta]) => ({ chave, ...meta }));
}

function valorNumericoPorChave(av, chaveCompleta) {
  const linha = linhasDetalheAvaliacao(av).find((l) => l.chave === chaveCompleta);
  return linha ? linha.valorNumerico : null;
}

const ESTILO_RELATORIO_AV =
  'body{font:13px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#17202b;max-width:760px;margin:0 auto;padding:28px;}'
  + 'h1{font-size:20px;margin:0 0 2px;}h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #d7dde7;padding-bottom:4px;}'
  + 'h3{font-size:13.5px;margin:14px 0 4px;}.sub{color:#5d6b7d;font-size:12px;margin:0 0 16px;}'
  + 'table{border-collapse:collapse;width:100%;font-size:12.5px;margin:6px 0;}'
  + 'th,td{padding:5px 8px;border-bottom:1px solid #e6eaf0;text-align:right;}'
  + 'th:first-child,td:first-child{text-align:left;}thead th{color:#5d6b7d;font-weight:600;font-size:11.5px;}'
  + '.grade-graficos{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin:10px 0 20px;}'
  + '.gr-caixa{background:#f7f8fa;border:1px solid #e6eaf0;border-radius:9px;padding:12px;page-break-inside:avoid;}'
  + '.gr-caixa h4{margin:0 0 2px;font-size:13px;}.gr-delta{font-size:12px;margin-bottom:6px;}'
  + '.gr-caixa svg{width:100%;height:auto;display:block;overflow:visible;}'
  + '.bom{color:#2f9e44;}.ruim{color:#d1433c;}.neutro{color:#5d6b7d;}'
  + '.rodape{margin-top:26px;border-top:1px solid #d7dde7;padding-top:10px;color:#5d6b7d;font-size:11.5px;}'
  + '@media print{body{padding:0;}h2{page-break-after:avoid;}.gr-caixa{page-break-inside:avoid;}}';

function abrirJanelaRelatorioAv(titulo, corpo) {
  const w = window.open('', '_blank');
  if (!w) { window.alert('O navegador bloqueou a janela do relatório. Autorize pop-ups deste site e tente de novo.'); return; }
  // 2026-09-09: o portal costuma rodar instalado na tela de início (PWA) —
  // nesse modo não existe barra do navegador nem botão "voltar" nenhum, então
  // a janela nova do relatório (window.open) fica sem NENHUM jeito de
  // retornar ao portal sem esta barra própria. @media print esconde ela do
  // PDF gerado (ninguém quer o botão "Voltar" impresso no relatório).
  const barraVoltar = '<div class="barra-voltar-relatorio">'
    + '<button type="button" onclick="window.close()">← Voltar ao portal</button></div>';
  const estiloBarraVoltar = '.barra-voltar-relatorio{position:sticky;top:0;background:#17202b;padding:10px 12px;'
    + 'margin:-28px -28px 20px;display:flex;}'
    + '.barra-voltar-relatorio button{background:#2a8f5e;color:#fff;border:none;border-radius:7px;'
    + 'padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;}'
    + '@media print{.barra-voltar-relatorio{display:none;}}';
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escHtmlAv(titulo)}</title>`
    + `<style>${ESTILO_RELATORIO_AV}${estiloBarraVoltar}</style></head><body>${barraVoltar}${corpo}`
    + `<div class="rodape">Gerado em ${new Date().toLocaleString('pt-BR')}. Para salvar em PDF, use Ctrl+P (ou Cmd+P) e escolha "Salvar como PDF".</div>`
    + '</body></html>');
  w.document.close();
}

function gerarRelatorioCompletoAvaliacoes() {
  const lista = avaliacoesHubAtual;
  if (!lista.length) return;
  const nomeAluno = document.getElementById('hub-saudacao').textContent.replace(/^Olá,\s*/, '').replace(/!$/, '');

  const porTipo = {};
  lista.forEach((av) => { (porTipo[av.tipo] = porTipo[av.tipo] || []).push(av); });

  let html = `<h1>Relatório completo de avaliação física</h1>`
    + `<p class="sub">${escHtmlAv(nomeAluno)} · ${lista.length} avaliaç${lista.length === 1 ? 'ão registrada' : 'ões registradas'}</p>`;

  // Evolução: uma seção por tipo com 2+ registros, um gráfico por métrica
  // numérica presente (todas, não só a curada) — mesma ideia de
  // Relatorio.completo no AvaliaPro (gruposEvolucao).
  let temEvolucao = false;
  Object.entries(porTipo).forEach(([tipo, avsDoTipo]) => {
    if (avsDoTipo.length < 2) return;
    const metricas = metricasPresentesNaLista(avsDoTipo);
    const caixas = metricas.map((m) => {
      const pontos = avsDoTipo
        .map((av) => ({ data: av.data, valor: valorNumericoPorChave(av, m.chave) }))
        .filter((p) => p.valor != null);
      if (pontos.length < 2) return '';
      const delta = pontos[pontos.length - 1].valor - pontos[0].valor;
      const seta = delta > 0.005 ? '▲' : delta < -0.005 ? '▼' : '=';
      return `<div class="gr-caixa"><h4>${escHtmlAv(m.rotulo)}</h4>`
        + `<div class="gr-delta neutro">${seta} ${formatarNumeroAv(Math.abs(delta))}${m.unidade} desde a primeira</div>`
        + graficoEvolucaoAv(pontos, m.unidade) + '</div>';
    }).filter(Boolean).join('');
    if (caixas) {
      temEvolucao = true;
      html += `<h2>${escHtmlAv(tipo)}</h2><div class="grade-graficos">${caixas}</div>`;
    }
  });
  if (!temEvolucao) {
    html += '<p class="sub">Ainda não há avaliações suficientes (mínimo 2 do mesmo tipo) para gerar gráficos de evolução.</p>';
  }

  // Histórico completo: uma seção por avaliação, com TODOS os campos.
  html += '<h2>Histórico completo</h2>';
  lista.forEach((av) => {
    const linhas = linhasDetalheAvaliacao(av);
    html += `<h3>${escHtmlAv(av.tipo)} — ${formatarData(av.data)}${av.protocolo ? ` <span style="font-weight:400;color:#5d6b7d;">(${escHtmlAv(av.protocolo)})</span>` : ''}</h3>`;
    html += linhas.length
      ? `<table><tbody>${linhas.map((l) => `<tr><td>${escHtmlAv(l.rotulo)}</td><td>${l.valorTexto}</td></tr>`).join('')}</tbody></table>`
      : '<p class="sub">Sem detalhes registrados.</p>';
  });

  abrirJanelaRelatorioAv(`Relatório completo — ${nomeAluno}`, html);
}

document.getElementById('btn-relatorio-completo-avaliacoes').addEventListener('click', gerarRelatorioCompletoAvaliacoes);

// ---------------- Comparador de duas avaliações do mesmo tipo -----------
function popularComparadorAvaliacoes() {
  const selTipo = document.getElementById('comparar-avaliacao-tipo');
  const porTipo = {};
  avaliacoesHubAtual.forEach((av, idx) => { (porTipo[av.tipo] = porTipo[av.tipo] || []).push(idx); });
  const tiposComparaveis = Object.keys(porTipo).filter((t) => porTipo[t].length >= 2);

  document.getElementById('bloco-comparar-avaliacoes').classList.toggle('oculto', tiposComparaveis.length === 0);
  if (!tiposComparaveis.length) return;

  const tipoAnterior = selTipo.value;
  selTipo.innerHTML = tiposComparaveis.map((t) => `<option value="${escHtmlAv(t)}">${escHtmlAv(t)}</option>`).join('');
  selTipo.value = tiposComparaveis.includes(tipoAnterior) ? tipoAnterior : tiposComparaveis[0];
  popularSelectsComparacao();
}

function popularSelectsComparacao() {
  const tipo = document.getElementById('comparar-avaliacao-tipo').value;
  const indices = [];
  avaliacoesHubAtual.forEach((av, idx) => { if (av.tipo === tipo) indices.push(idx); });
  const opcoes = indices.map((idx) => {
    const av = avaliacoesHubAtual[idx];
    return `<option value="${idx}">${formatarData(av.data)}${av.protocolo ? ` (${escHtmlAv(av.protocolo)})` : ''}</option>`;
  }).join('');
  const selA = document.getElementById('comparar-avaliacao-a');
  const selB = document.getElementById('comparar-avaliacao-b');
  selA.innerHTML = opcoes;
  selB.innerHTML = opcoes;
  // Por padrão compara a primeira com a mais recente do tipo escolhido.
  selA.value = indices[0];
  selB.value = indices[indices.length - 1];
  document.getElementById('resultado-comparar-avaliacoes').innerHTML = '';
}

document.getElementById('comparar-avaliacao-tipo').addEventListener('change', popularSelectsComparacao);

document.getElementById('btn-comparar-avaliacoes').addEventListener('click', () => {
  const idxA = Number(document.getElementById('comparar-avaliacao-a').value);
  const idxB = Number(document.getElementById('comparar-avaliacao-b').value);
  const alvo = document.getElementById('resultado-comparar-avaliacoes');
  if (idxA === idxB) { alvo.innerHTML = '<p style="color:#fbbf24;font-size:13px">Escolha duas avaliações diferentes.</p>'; return; }
  const avA = avaliacoesHubAtual[idxA];
  const avB = avaliacoesHubAtual[idxB];
  // Sempre mostra a mais antiga primeiro, independente da ordem escolhida.
  const [maisAntiga, maisRecente] = new Date(avA.data) <= new Date(avB.data) ? [avA, avB] : [avB, avA];

  const linhasA = linhasDetalheAvaliacao(maisAntiga);
  const linhasB = linhasDetalheAvaliacao(maisRecente);
  const chaves = [...new Map([...linhasA, ...linhasB].map((l) => [l.chave, l.rotulo])).entries()];

  let html = `<table class="tabela-comparacao-av" style="margin-top:10px"><thead><tr><th>Medida</th><th>${formatarData(maisAntiga.data)}</th><th>${formatarData(maisRecente.data)}</th><th>Diferença</th></tr></thead><tbody>`;
  chaves.forEach(([chave, rotulo]) => {
    const lA = linhasA.find((l) => l.chave === chave);
    const lB = linhasB.find((l) => l.chave === chave);
    if (!lA && !lB) return;
    let diffTexto = '—';
    if (lA && lB && lA.valorNumerico != null && lB.valorNumerico != null) {
      const diff = lB.valorNumerico - lA.valorNumerico;
      diffTexto = `${diff > 0 ? '+' : ''}${formatarNumeroAv(diff)}${lA.unidade || ''}`;
    }
    html += `<tr><td>${escHtmlAv(rotulo)}</td><td>${lA ? lA.valorTexto : '—'}</td><td>${lB ? lB.valorTexto : '—'}</td><td>${diffTexto}</td></tr>`;
  });
  html += '</tbody></table>';
  alvo.innerHTML = html;
});

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
  ['painel-hub-dashboard', 'painel-hub-contas', 'painel-hub-conta', 'painel-hub-upgrade-escolha', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-comprovante', 'painel-hub-completar-cadastro', 'painel-hub-facial', 'painel-hub-notificacoes', 'painel-hub-avaliacoes', 'painel-hub-biblioteca']
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
    <div class="item-conta">
      <input type="checkbox" data-id="${c.id}" data-valor="${c.valor_centavos}" checked aria-label="Incluir no pagamento" />
      <div class="info" data-abrir-conta="${c.id}" role="button" tabindex="0">
        <div class="desc">${escapeHtml(String(c.descricao || 'Conta').replace(/[\s-]+$/, ''))}</div>
        <div class="venc">${c.vencimento ? `Vencimento: ${formatarData(c.vencimento)}` : ''}</div>
      </div>
      <div class="valor" data-abrir-conta="${c.id}" role="button">${formatarMoeda(c.valor_centavos)}</div>
      <span class="abrir" data-abrir-conta="${c.id}" aria-hidden="true">&rsaquo;</span>
    </div>
  `).join('');
  alvo.querySelectorAll('[data-abrir-conta]').forEach((el) => {
    el.addEventListener('click', () => abrirPaginaContaHub(contas.find((x) => x.id === el.dataset.abrirConta)));
  });
  contas.forEach((c) => { contasSelecionadasHub[c.id] = c.valor_centavos; });

  alvo.querySelectorAll('input[type=checkbox]').forEach((chk) => {
    chk.addEventListener('change', () => {
      if (chk.checked) contasSelecionadasHub[chk.dataset.id] = Number(chk.dataset.valor);
      else delete contasSelecionadasHub[chk.dataset.id];
      atualizarTotalContasHub();
    });
  });
  atualizarTotalContasHub();
  mostrarBannerCartaoContas(contas);
}

// Destaque na lista de contas: oferece o cartão automático (se o aluno puder) e abre a página da mensalidade.
async function mostrarBannerCartaoContas(contas) {
  const banner = document.getElementById('banner-cartao-contas');
  if (!banner) return;
  banner.classList.add('oculto');
  const alvo = contas.find((c) => /^Mensalidade/i.test(c.descricao || ''));
  if (!alvo) return;
  try {
    const d = await api('/api/portal/assinatura?cpf=' + encodeURIComponent(cpfHubAtual) + '&senha=' + encodeURIComponent(senhaHubAtual));
    if (!d.disponivel) return;
    banner.classList.remove('oculto');
    document.getElementById('btn-banner-cartao').onclick = async () => {
      await abrirPaginaContaHub(alvo);
      const b = document.getElementById('btn-conta-cartao');
      if (b && !b.classList.contains('oculto')) b.click();
    };
  } catch (e) { /* sem cartão: só Pix */ }
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
        <button type="button" class="btn-chamar-professor-exercicio" data-acao="chamar-professor-exercicio">🙋 Chamar professor</button>
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
  alvo.querySelectorAll('.btn-chamar-professor-exercicio[data-acao="chamar-professor-exercicio"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const treinoId = btn.closest('.treino-card').dataset.tid;
      const treino = treinosCacheHub.find((t) => t.id === treinoId);
      const exercicioFoco = treino && treino.exercicios.find((e) => e.id === treinoFocoExercicio[treinoId]);
      chamarProfessor(exercicioFoco ? exercicioFoco.exercicio : null, btn);
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

// ---------------------------------------------------------------------------
// Cartão automático (recorrência) nas telas do Meu espaço: cartões das modalidades com escolha de combo.
// Usado pela página da conta e pela escolha de pagamento ao assinar um plano.
// ---------------------------------------------------------------------------
function htmlCartoesRecorrencia(opcoes) {
  return opcoes.map((p) => {
    const mensal = formatarMoeda(p.valor_final_centavos);
    const detalhe = p.limite_cobrancas
      ? p.limite_cobrancas + ' cobranças mensais (uma por mês, durante ' + p.limite_cobrancas + ' meses)'
      : 'Cobrança automática todo mês • Sem permanência mínima';
    const desconto = p.desconto_centavos > 0 ? '<small style="display:block;color:#64748b">De ' + formatarMoeda(p.valor_centavos) + ' por mês</small>' : '';
    return '<div style="background:#0f172a;border-radius:10px;padding:12px;margin:10px 0"><strong>' + escapeHtml(p.nome) +
      '</strong><div data-preco-de="' + escapeHtml(p.id) + '" style="font-size:23px;font-weight:800;color:#10b981">' + mensal + '/mês</div>' + desconto +
      '<small>' + escapeHtml(detalhe) + '</small>' + (p.limite_cobrancas >= 12 ? '<small style="display:block;margin-top:4px;color:#fbbf24">Compromisso de ' + p.limite_cobrancas + ' meses: cancelando antes do fim, devolve-se o desconto recebido (' + (p.desconto_centavos > 0 ? formatarMoeda(p.desconto_centavos) + ' por mês cobrado' : 'conforme contrato') + '). Sem custo nos 7 primeiros dias.</small>' : '') + seletorComboHtml(p) +
      '<button type="button" data-modalidade="' + escapeHtml(p.id) + '" data-rotulo="' + escapeHtml(p.nome) + '" class="botao-grande secundario" style="margin-top:8px">Escolher ' + escapeHtml(p.nome) + '</button></div>';
  }).join('');
}

const TEXTO_RECORRENCIA_HUB = '<div style="background:#0f172a;border:1px solid #10b981;border-radius:10px;padding:12px;margin:10px 0;font-size:14px;line-height:1.45">' +
  '<div style="font-weight:800;color:#10b981">🔁 Como funciona o pagamento automático</div>' +
  '<div style="margin-top:6px">Na próxima página você cadastra o cartão uma única vez. A mensalidade passa a ser <strong>cobrada automaticamente no cartão</strong> todo mês, sem você precisar lembrar.</div>' +
  '<div style="margin-top:6px">💳 <strong>Não ocupa o limite do cartão:</strong> é cobrado só o valor de cada mês.</div>' +
  '<div style="margin-top:6px">🙋 Para cancelar, é só falar com a <strong>recepção</strong>.</div></div>';

// Carrega e mostra as opções de recorrência em `container`. `aoEscolher({ modalidade, combo })` devolve uma Promise
// com a URL do Mercado Pago. Retorna false se não houver nenhuma opção disponível para este aluno.
async function mostrarRecorrenciaHub(container, aoEscolher, erroEl) {
  let opcoes = [];
  try {
    const dados = await api('/api/portal/cadastro/recorrencia/planos?cpf=' + encodeURIComponent(String(cpfHubAtual || '').replace(/\D/g, '')));
    opcoes = Array.isArray(dados.opcoes) ? dados.opcoes : [];
  } catch (e) { /* sem recorrência: só o Pix */ }
  if (!opcoes.length) { container.innerHTML = ''; return false; }
  container.innerHTML = TEXTO_RECORRENCIA_HUB + htmlCartoesRecorrencia(opcoes);
  ligarSeletoresCombo(container);
  container.querySelectorAll('[data-modalidade]').forEach((btn) => btn.addEventListener('click', async () => {
    const modalidade = btn.dataset.modalidade;
    const combo = comboEscolhido(container, modalidade);
    const botoes = Array.from(container.querySelectorAll('button'));
    botoes.forEach((b) => { b.disabled = true; });
    btn.textContent = 'Abrindo Mercado Pago…';
    if (erroEl) erroEl.textContent = '';
    try {
      const url = await aoEscolher({ modalidade, combo });
      if (!url) throw new Error('O Mercado Pago não retornou o endereço da oferta.');
      window.location.href = url;
    } catch (err) {
      if (erroEl) erroEl.textContent = err.message || 'Não foi possível abrir o cartão agora.';
      botoes.forEach((b) => { b.disabled = false; });
      btn.textContent = 'Escolher ' + btn.dataset.rotulo;
    }
  }));
  return true;
}

// ---------------------------------------------------------------------------
// Página de uma conta em aberto: detalhes, valor em destaque e formas de pagamento (Pix e cartão automático).
// ---------------------------------------------------------------------------
async function abrirPaginaContaHub(conta) {
  if (!conta) return;
  ocultarPaineisHub();
  const $ = (id) => document.getElementById(id);
  const painel = $('painel-hub-conta');
  painel.classList.remove('oculto');
  const hoje = new Date().toISOString().slice(0, 10);
  const venc = String(conta.vencimento || '').slice(0, 10);
  const atrasada = !!venc && venc < hoje;
  const dias = atrasada ? Math.round((new Date(hoje) - new Date(venc)) / 86400000) : 0;
  const partes = String(conta.descricao || 'Conta').split(' - ');
  $('conta-titulo').textContent = partes[0] || 'Conta';
  $('conta-subtitulo').textContent = partes.slice(1).join(' - ').replace(/[\s-]+$/, '').trim();
  const selo = $('conta-vencimento');
  selo.textContent = venc ? formatarData(venc) : '—';
  selo.className = 'conta-selo' + (atrasada ? ' atrasada' : '');
  $('conta-situacao').textContent = atrasada ? (dias === 1 ? 'Venceu há 1 dia' : 'Venceu há ' + dias + ' dias') : 'Em dia';
  $('conta-valor').textContent = formatarMoeda(conta.valor_centavos);
  $('conta-erro').textContent = '';
  $('conta-recorrencia').innerHTML = '';
  $('conta-aviso').innerHTML = '';
  const btnPix = $('btn-conta-pix'), btnCartao = $('btn-conta-cartao');
  btnPix.disabled = false;
  btnCartao.classList.add('oculto');
  $('conta-destaque-cartao').classList.add('oculto');
  btnPix.classList.remove('primario'); btnPix.classList.add('secundario');

  btnPix.onclick = async () => {
    btnPix.disabled = true;
    try {
      const resp = await api('/api/portal/contas/pagar', { method: 'POST', body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, cobranca_ids: [conta.id] }) });
      abrirPagamentoPixHub({
        titulo: 'Pagar ' + formatarMoeda(resp.valor_centavos),
        qrCodePix: resp.qr_code_pix,
        qrCodePixImagem: resp.qr_code_pix_imagem,
        statusUrl: '/api/portal/contas/status/' + resp.pagamento_id,
        aoConfirmar: (statusResp) => {
          mostrarComprovanteHub({ saudacao: 'Pagamento aprovado, ' + (statusResp.aluno_nome || '') + '!', itens: statusResp.itens, total: statusResp.valor_centavos });
          carregarResumoContasHub();
        },
      });
    } catch (err) { $('conta-erro').textContent = err.message; }
    btnPix.disabled = false;
  };

  // O cartão automático só aparece para quem pode (plano mensal, sem assinatura ativa) e com modalidades disponíveis.
  try {
    const d = await api('/api/portal/assinatura?cpf=' + encodeURIComponent(cpfHubAtual) + '&senha=' + encodeURIComponent(senhaHubAtual));
    if (d.disponivel) { $('conta-destaque-cartao').classList.remove('oculto'); btnPix.textContent = 'Pagar só esta conta com Pix'; }
    if (!d.disponivel && d.motivo === 'mensalidades_anteriores' && (d.mensalidades_anteriores || []).length) {
      // Mês anterior em aberto: essa conta só por Pix. O cartão automático cobre a mensalidade do mês corrente.
      const ant = d.mensalidades_anteriores;
      const box = $('conta-aviso');
      box.innerHTML = '<div style="background:#1e293b;border:1px solid #f59e0b;border-radius:12px;padding:14px;margin-top:12px;font-size:14px;line-height:1.5">' +
        '<div style="font-weight:800;color:#f59e0b">Cartão automático indisponível por enquanto</div>' +
        '<div style="margin-top:6px">Você tem <strong>' + ant.length + (ant.length === 1 ? ' mensalidade' : ' mensalidades') + ' de mês anterior em aberto</strong> (' + formatarMoeda(d.total_anteriores_centavos) + '). Essas contas são pagas somente por <strong>Pix</strong>. Depois de quitá-las, você pode ativar o cartão automático para a mensalidade do mês corrente.</div>' +
        '<button type="button" id="btn-pagar-anteriores" class="btn" style="margin-top:10px;width:100%">Pagar mensalidades anteriores por Pix</button></div>';
      $('btn-pagar-anteriores').onclick = async () => {
        try {
          const resp = await api('/api/portal/contas/pagar', { method: 'POST', body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, cobranca_ids: ant.map((c) => c.id) }) });
          abrirPagamentoPixHub({
            titulo: 'Pagar ' + formatarMoeda(resp.valor_centavos),
            qrCodePix: resp.qr_code_pix,
            qrCodePixImagem: resp.qr_code_pix_imagem,
            statusUrl: '/api/portal/contas/status/' + resp.pagamento_id,
            aoConfirmar: (statusResp) => {
              mostrarComprovanteHub({ saudacao: 'Pagamento aprovado, ' + (statusResp.aluno_nome || '') + '!', itens: statusResp.itens, total: statusResp.valor_centavos });
              carregarResumoContasHub();
            },
          });
        } catch (err) { $('conta-erro').textContent = err.message; }
      };
      return;
    }
    if (!d.disponivel) { btnPix.textContent = 'Pagar com Pix'; btnPix.classList.remove('secundario'); btnPix.classList.add('primario'); return; }
    btnCartao.classList.remove('oculto');
    btnCartao.onclick = async () => {
      btnCartao.classList.add('oculto');
      const ok = await mostrarRecorrenciaHub($('conta-recorrencia'), async ({ modalidade, combo }) => {
        const r = await api('/api/portal/assinatura', { method: 'POST', body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, modalidade, combo }) });
        return r.oferta_url;
      }, $('conta-erro'));
      if (!ok) { $('conta-erro').textContent = 'No momento não há opções de cartão automático disponíveis. Você pode pagar com Pix.'; }
    };
  } catch (e) { /* sem cartão automático: segue só com o Pix */ }
}

// ---------------------------------------------------------------------------
// Assinar / trocar de plano: cria a pré-matrícula e deixa o aluno escolher entre Pix e cartão automático.
// ---------------------------------------------------------------------------
async function assinarPlanoHub(planoId) {
  try {
    const resp = await api('/api/portal/upgrade', {
      method: 'POST',
      body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, plano_id: planoId, escolher: true }),
    });
    const aoConfirmarPlano = (statusResp) => {
      mostrarComprovanteHub({ saudacao: `Plano ativado, ${statusResp.aluno_nome || ''}! Bem-vindo(a).`, itens: null, total: null });
    };
    const iniciarPix = async () => {
      const pix = await api('/api/portal/cadastro/pix', { method: 'POST', body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, cobranca_id: resp.cobranca_id }) });
      abrirPagamentoPixHub({
        titulo: `Assinar plano — ${formatarMoeda(pix.valor_centavos)}`,
        qrCodePix: pix.qr_code_pix,
        qrCodePixImagem: pix.qr_code_pix_imagem,
        statusUrl: `/api/portal/upgrade/status/${resp.cobranca_id}`,
        aoConfirmar: aoConfirmarPlano,
      });
    };

    // Só plano mensal tem cartão automático; os demais vão direto para o Pix, como antes.
    if (resp.plano_tipo !== 'mensal') return await iniciarPix();

    ocultarPaineisHub();
    const $ = (id) => document.getElementById(id);
    $('painel-hub-upgrade-escolha').classList.remove('oculto');
    $('upg-escolha-titulo').textContent = 'Assinar ' + (resp.plano_nome || 'plano');
    $('upg-escolha-texto').textContent = 'Escolha como prefere pagar. Seu plano é ativado assim que o pagamento for confirmado.';
    $('upg-escolha-erro').textContent = '';
    const btnPix = $('btn-upg-pix');
    btnPix.textContent = 'Pagar com Pix — ' + formatarMoeda(resp.valor_centavos);
    btnPix.disabled = false;
    btnPix.onclick = async () => {
      btnPix.disabled = true;
      try { await iniciarPix(); } catch (err) { $('upg-escolha-erro').textContent = err.message; }
      btnPix.disabled = false;
    };
    const ok = await mostrarRecorrenciaHub($('upg-recorrencia'), async ({ modalidade, combo }) => {
      const r = await api('/api/portal/cadastro/recorrencia', { method: 'POST', body: JSON.stringify({ cpf: cpfHubAtual, senha: senhaHubAtual, matricula_id: resp.matricula_id, modalidade, combo }) });
      return r.oferta_url;
    }, $('upg-escolha-erro'));
    if (!ok) $('upg-escolha-texto').textContent = 'Seu plano é ativado assim que o pagamento por Pix for confirmado.';
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
let cadastroPortalCobrancaId = null;
let cadastroPortalMatriculaId = null;
let cadastroPortalCronograma = null;

function resetCadastroPortal() {
  pararPollCadastroPortal();
  pararCamera();
  cadastroPortalCpfAtual = null;
  cadastroPortalSenhaAtual = null;
  cadastroPortalCobrancaId = null;
  cadastroPortalMatriculaId = null;
  cadastroPortalCronograma = null;
  document.getElementById('portal-cadastro-nome').value = '';
  document.getElementById('portal-cadastro-cpf').value = '';
  document.getElementById('portal-cadastro-telefone').value = '';
  document.getElementById('portal-cadastro-email').value = '';
  document.getElementById('portal-cadastro-nascimento').value = '';
  document.getElementById('portal-cadastro-indicado-cpf').value = '';
  document.getElementById('portal-cadastro-erro').textContent = '';
  document.getElementById('portal-cadastro-senha-caixa').textContent = '';
  document.getElementById('portal-cadastro-senha-pendente').textContent = '';
  document.getElementById('painel-cadastro-portal-form').classList.remove('oculto');
  document.getElementById('painel-cadastro-portal-pagamento').classList.add('oculto');
  document.getElementById('cadastro-pix-conteudo').classList.add('oculto');
  document.getElementById('oferta-recorrencia-novo-aluno').classList.remove('oculto');
  document.getElementById('oferta-recorrencia-novo-aluno').innerHTML = '';
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
  const nome=document.getElementById('portal-cadastro-nome').value.trim(),cpf=document.getElementById('portal-cadastro-cpf').value.trim();
  const telefone=document.getElementById('portal-cadastro-telefone').value.trim(),email=document.getElementById('portal-cadastro-email').value.trim();
  const dataNascimento=document.getElementById('portal-cadastro-nascimento').value,planoId=document.getElementById('portal-cadastro-plano').value;
  const indicadoPorCpf=document.getElementById('portal-cadastro-indicado-cpf').value.trim(),erroEl=document.getElementById('portal-cadastro-erro');
  const btn=document.getElementById('btn-portal-cadastro-continuar');erroEl.textContent='';
  if(!nome||!cpf||!telefone||!email||!dataNascimento||!planoId){erroEl.textContent='Preencha nome, CPF, telefone, e-mail, data de nascimento e escolha um plano.';return;}
  btn.disabled=true;btn.textContent='Salvando cadastro…';
  try{
    const resp=await api('/api/portal/cadastro',{method:'POST',body:JSON.stringify({nome,cpf,telefone,email,data_nascimento:dataNascimento,plano_id:planoId,indicado_por_cpf:indicadoPorCpf||null})});
    cadastroPortalCpfAtual=cpf;
    if(resp.visitante){document.getElementById('painel-cadastro-portal-form').classList.add('oculto');document.getElementById('painel-cadastro-portal-sucesso').classList.remove('oculto');document.getElementById('portal-cadastro-sucesso-msg').textContent='Cadastro de visitante concluído! Bem-vindo(a), '+(resp.aluno_nome||'')+'. Use "Já sou aluno" com seu CPF para acessar o portal e ver sua senha.';document.getElementById('portal-cadastro-senha-caixa').textContent='';return;}
    cadastroPortalSenhaAtual=resp.senha_acesso;cadastroPortalCobrancaId=resp.cobranca_id;cadastroPortalMatriculaId=resp.matricula_id;cadastroPortalCronograma=resp.cronograma_recorrencia||null;
    document.getElementById('painel-cadastro-portal-form').classList.add('oculto');document.getElementById('painel-cadastro-portal-pagamento').classList.remove('oculto');
    document.getElementById('portal-cadastro-valor').textContent='Plano escolhido: '+formatarMoeda(resp.valor_centavos);
    document.getElementById('portal-cadastro-senha-pendente').textContent=cadastroPortalSenhaAtual||'';
    document.getElementById('portal-cadastro-senha-caixa').textContent=cadastroPortalSenhaAtual||'';
    document.getElementById('cadastro-pix-conteudo').classList.add('oculto');
    carregarOfertaRecorrenciaNovoAluno();
  }catch(err){erroEl.textContent=err.message;}finally{btn.disabled=false;btn.textContent='Continuar';}
});

function formatarDataBR(iso){const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||''));return m?m[3]+'/'+m[2]+'/'+m[1]:'';}
function blocoExplicativoRecorrencia(){
 const c=cadastroPortalCronograma;
 const prox=c&&c.proxima_cobranca?formatarDataBR(c.proxima_cobranca):'';
 const primeira='A primeira cobrança acontece assim que você cadastrar o cartão, na próxima página, e a matrícula é ativada na hora.';
 const proxima=prox?'<div style="margin-top:6px">📅 <strong>Próxima cobrança automática: dia '+prox+'</strong>, e depois todo mês no mesmo dia da sua adesão.</div>':'<div style="margin-top:6px">📅 <strong>As próximas cobranças são automáticas, todo mês, no mesmo dia da sua adesão.</strong></div>';
 return '<div style="background:#0f172a;border:1px solid #10b981;border-radius:10px;padding:12px;margin:10px 0;font-size:14px;line-height:1.45">'
  +'<div style="font-weight:800;color:#10b981">🔁 Como funciona o pagamento recorrente</div>'
  +'<div style="margin-top:6px">Na próxima página você cadastra o cartão uma única vez. A mensalidade passa a ser <strong>cobrada automaticamente no cartão</strong> a cada vencimento — você não precisa se preocupar nem lembrar de pagar.</div>'
  +'<div style="margin-top:6px">'+primeira+'</div>'
  +proxima
  +'<div style="margin-top:6px">💳 <strong>Não ocupa o limite do cartão:</strong> é cobrado somente o valor de cada mês, não o total do contrato.</div>'
  +'<div style="margin-top:6px">🙋 Quer cancelar? É só falar com a <strong>recepção</strong>.</div>'
  +'</div>';
}
async function carregarOfertaRecorrenciaNovoAluno(){
 const container=document.getElementById('oferta-recorrencia-novo-aluno');if(!container)return;
 let opcoes=[];
 try{const dados=await api('/api/portal/cadastro/recorrencia/planos?cpf='+encodeURIComponent(String(cadastroPortalCpfAtual||'').replace(/\D/g,'')));opcoes=Array.isArray(dados.opcoes)?dados.opcoes:[];}catch(e){/* Pix continua disponível mesmo se a lista não carregar. */}
 const cards=opcoes.map((p,i)=>{
  const mensal=formatarMoeda(p.valor_final_centavos);
  const detalhe=p.limite_cobrancas?String(p.limite_cobrancas)+' cobranças mensais de '+mensal+' (uma por mês, durante '+p.limite_cobrancas+' meses)':'Cobrança automática todo mês, por tempo indeterminado • Sem permanência mínima';
  const desconto=p.desconto_centavos>0?'<small style="display:block;color:#64748b">De '+formatarMoeda(p.valor_centavos)+' por mês</small>':'';
  const classe=i===0?'primario':'secundario';
  return '<div style="background:#0f172a;border-radius:10px;padding:12px;margin:10px 0"><strong>'+escapeHtml(p.nome)+'</strong><div data-preco-de="'+escapeHtml(p.id)+'" style="font-size:23px;font-weight:800;color:#10b981">'+mensal+'/mês</div>'+desconto+'<small>'+escapeHtml(detalhe)+'</small>'+seletorComboHtml(p)+'<button type="button" data-modalidade="'+escapeHtml(p.id)+'" data-rotulo="'+escapeHtml(p.nome)+'" class="botao-grande '+classe+'" style="margin-top:8px">Escolher '+escapeHtml(p.nome)+'</button></div>';
 }).join('');
 container.innerHTML=`
  <div style="text-align:left"><div style="font-weight:800;color:#10b981">⚡ ESCOLHA COMO DESEJA PAGAR</div>
  <h3 style="margin:8px 0">Pagamento automático no cartão</h3>
  <p>Seu cadastro e sua matrícula foram registrados, mas ainda não ativados. Escolha uma opção:</p>
  ${cards?blocoExplicativoRecorrencia():''}
  ${cards||'<p>No momento não há modalidades de recorrência disponíveis.</p>'}
  <button type="button" data-escolher-pix class="botao-grande primario" style="width:100%;margin-top:12px">Continuar com Pix do plano escolhido</button>
  <small>Se sair agora, seu cadastro ficará salvo como pendente, sem cobrança nem ativação.</small><div class="erro-msg" data-erro-recorrencia></div></div>`;
 // Sem modalidades (recurso desligado ou todas inativas): segue direto para o Pix.
 if(!opcoes.length)setTimeout(()=>container.querySelector('[data-escolher-pix]')?.click(),0);
 ligarSeletoresCombo(container);
 container.querySelectorAll('[data-modalidade]').forEach(btn=>btn.addEventListener('click',async()=>{
  const modalidade=btn.dataset.modalidade,combo=comboEscolhido(container,modalidade),botoes=Array.from(container.querySelectorAll('button'));botoes.forEach(b=>b.disabled=true);btn.textContent='Abrindo Mercado Pago…';
  try{const r=await api('/api/portal/cadastro/recorrencia',{method:'POST',body:JSON.stringify({cpf:cadastroPortalCpfAtual,senha:cadastroPortalSenhaAtual,matricula_id:cadastroPortalMatriculaId,modalidade,combo})});if(!r.oferta_url)throw new Error('O Mercado Pago não retornou o endereço da oferta.');window.location.href=r.oferta_url;}
  catch(err){container.querySelector('[data-erro-recorrencia]').textContent=err.message||'Não foi possível abrir a recorrência.';botoes.forEach(b=>b.disabled=false);btn.textContent='Escolher '+btn.dataset.rotulo;}
 }));
 container.querySelector('[data-escolher-pix]').addEventListener('click',async ev=>{
  const btn=ev.currentTarget;btn.disabled=true;btn.textContent='Gerando Pix…';
  try{
   const pix=await api('/api/portal/cadastro/pix',{method:'POST',body:JSON.stringify({cpf:cadastroPortalCpfAtual,senha:cadastroPortalSenhaAtual,cobranca_id:cadastroPortalCobrancaId})});
   container.classList.add('oculto');document.getElementById('cadastro-pix-conteudo').classList.remove('oculto');
   document.getElementById('portal-cadastro-valor').textContent='Valor: '+formatarMoeda(pix.valor_centavos);
   document.getElementById('portal-cadastro-status').textContent='Aguardando pagamento…';
   const alvo=document.getElementById('qrcode-cadastro-portal');alvo.innerHTML='';const copiar=document.getElementById('btn-copiar-pix-cadastro-portal');
   if(pix.qr_code_pix_imagem){const img=document.createElement('img');img.src='data:image/png;base64,'+pix.qr_code_pix_imagem;img.style.width='220px';img.style.height='220px';img.style.borderRadius='12px';alvo.appendChild(img);}
   else if(pix.qr_code_pix)new QRCode(alvo,{text:pix.qr_code_pix,width:220,height:220,colorDark:'#0f172a',colorLight:'#ffffff'});
   if(pix.qr_code_pix){copiar.classList.remove('oculto');copiar.onclick=async()=>{try{await navigator.clipboard.writeText(pix.qr_code_pix);copiar.textContent='Código copiado!';setTimeout(()=>{copiar.textContent='Copiar código Pix';},2000);}catch{alert('Não foi possível copiar automaticamente. Código Pix:\\n'+pix.qr_code_pix);}};}else copiar.classList.add('oculto');
   iniciarPollCadastroPortal(pix.cobranca_id);
  }catch(err){btn.disabled=false;btn.textContent='Continuar com Pix do plano escolhido';container.querySelector('[data-erro-recorrencia]').textContent=err.message||'Não foi possível gerar o Pix.';}
 });
}

function iniciarPollCadastroPortal(cobrancaId){
 pararPollCadastroPortal();const statusEl=document.getElementById('portal-cadastro-status');
 cadastroPortalPollTimer=setInterval(async()=>{try{const resp=await api('/api/portal/cadastro/status/'+cobrancaId);if(resp.pago){pararPollCadastroPortal();document.getElementById('painel-cadastro-portal-pagamento').classList.add('oculto');document.getElementById('painel-cadastro-portal-sucesso').classList.remove('oculto');document.getElementById('portal-cadastro-sucesso-msg').textContent='Pagamento confirmado! Bem-vindo(a), '+(resp.aluno_nome||'')+'. Sua matrícula já está ativa.';document.getElementById('portal-cadastro-senha-caixa').textContent=cadastroPortalSenhaAtual||'';}}catch(err){statusEl.textContent='Erro ao consultar pagamento: '+err.message;}},4000);
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

// ---------------- Retorno do pagamento no cartão ----------------
// O Mercado Pago devolve o aluno para portal.html?cartao=<id da assinatura>. Esta tela confirma o pagamento NA HORA
// (o servidor consulta o Mercado Pago) e mostra o aviso certo: confirmado, aguardando (quantos minutos) ou não concluído.
function tratarRetornoCartao() {
  const idAssinatura = new URLSearchParams(location.search).get('cartao');
  if (!idAssinatura) return false;
  const $ = (id) => document.getElementById(id);
  const mostrar = (icone, titulo, texto, contato) => {
    $('retorno-cartao-icone').textContent = icone;
    $('retorno-cartao-titulo').textContent = titulo;
    $('retorno-cartao-texto').textContent = texto;
    $('retorno-cartao-contato').textContent = contato || '';
  };
  $('btn-retorno-cartao-portal').addEventListener('click', () => { history.replaceState(null, '', location.pathname); mostrarPagina('pagina-inicio'); });
  mostrarPagina('pagina-retorno-cartao');
  mostrar('⏳', 'Confirmando seu pagamento…', 'Só um instante: estamos conferindo com o Mercado Pago. Isso costuma levar menos de 2 minutos.');

  const formatarData = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  let tentativas = 0, terminou = false, rodando = false, ultimaResposta = 'sem resposta';
  const verificarAgora = async () => {
    if (terminou || rodando) return;
    rodando = true;
    tentativas += 1;
    try {
      // Limite de 12s por consulta: se uma não responder, não trava as próximas.
      const ctrl = new AbortController(); // (AbortSignal.timeout não existe em iPhones mais antigos)
      const limite = setTimeout(() => ctrl.abort(), 12000);
      let o;
      const pre = new URLSearchParams(location.search).get('preapproval_id'); // o Mercado Pago acrescenta este código na volta
      try { o = await api('/api/pagamentos/assinaturas/oferta/' + encodeURIComponent(idAssinatura) + '/verificar' + (pre ? '?preapproval_id=' + encodeURIComponent(pre) : ''), { method: 'POST', signal: ctrl.signal }); }
      finally { clearTimeout(limite); }
      ultimaResposta = `${o.status}, ${Number(o.cobrancas_processadas || 0)} cobrança(s) baixada(s)`;
      const contato = 'Dúvidas? Fale com a recepção da academia.';
      if (['authorized', 'completed'].includes(o.status) && Number(o.cobrancas_processadas || 0) > 0) {
        terminou = true; clearInterval(timer);
        return mostrar('✅', `Pagamento confirmado${o.aluno ? ', ' + o.aluno : ''}!`, 'Sua matrícula está ativa e seu acesso foi liberado. Pode treinar. As próximas mensalidades serão cobradas automaticamente no cartão, e para cancelar é só falar com a recepção.', contato);
      }
      if (o.status === 'authorized' && o.primeira_cobranca && String(o.primeira_cobranca).slice(0, 10) > new Date().toISOString().slice(0, 10)) {
        terminou = true; clearInterval(timer);
        return mostrar('✅', 'Cartão cadastrado!', `Sua primeira cobrança no cartão será em ${formatarData(o.primeira_cobranca)}. Até lá, seu acesso segue como está.`, contato);
      }
      if (o.status === 'cancelled') {
        terminou = true; clearInterval(timer);
        return mostrar('⚠️', 'O pagamento não foi concluído', 'O cartão foi recusado ou o cadastro foi cancelado, e nada foi cobrado. Volte ao portal para tentar outro cartão ou pagar com Pix.', contato);
      }
      if (o.status === 'paused') {
        terminou = true; clearInterval(timer);
        return mostrar('⏸️', 'Assinatura pausada', 'Fale com a recepção para retomar.', contato);
      }
    } catch (err) { ultimaResposta = 'erro: ' + (err.message || 'falha de conexão'); }
    finally { rodando = false; }
    if (tentativas >= 40 && !terminou) { // ~2 minutos de consulta ativa
      terminou = true; clearInterval(timer);
      mostrar('🕒', 'Recebemos seu cadastro no cartão', 'A confirmação do Mercado Pago ainda está chegando e pode levar até 5 minutos. Assim que confirmar, sua matrícula é ativada e seu acesso liberado automaticamente. Se passar desse tempo, fale com a recepção. Você também pode reabrir esta página para conferir.', `Última resposta: ${ultimaResposta}`);
    }
  };
  const timer = setInterval(verificarAgora, 3000);
  verificarAgora(); // já confere na abertura, sem esperar o primeiro ciclo de 3s
  // Navegadores de celular congelam a página em segundo plano (ex.: voltando do Mercado Pago): ao reaparecer, confere de novo.
  const reconferir = () => { if (!terminou) verificarAgora(); };
  window.addEventListener('pageshow', reconferir);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconferir(); });
  return true;
}

carregarConfigPublica();
if (!tratarRetornoCartao()) tentarAutoLoginHub();
