// ---------------------------------------------------------------------------
// Academia Gestão - painel administrativo (vanilla JS, sem build step)
// Consome a API definida em src/routes/*. Token JWT guardado em localStorage.
// ---------------------------------------------------------------------------

const estado = {
  token: localStorage.getItem('token') || null,
  usuario: JSON.parse(localStorage.getItem('usuario') || 'null'),
};

// ---------------- Helpers de UI ----------------

function mostrarToast(mensagem, erro = false) {
  const toast = document.getElementById('toast');
  toast.textContent = mensagem;
  toast.classList.toggle('erro', erro);
  toast.classList.remove('oculto');
  clearTimeout(mostrarToast._t);
  mostrarToast._t = setTimeout(() => toast.classList.add('oculto'), 3500);
}

function formatarMoeda(centavos) {
  return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ---------------- Botão (x) de limpar dentro das caixas de pesquisa ----------------
// Um único handler genérico cobre todas as caixas de busca do painel (Alunos,
// Pagamento Rápido, Contas a Receber, Relatórios) — cada botão só precisa do
// atributo data-alvo apontando pro id do <input> que ele limpa. O botão
// aparece/some sozinho via CSS (:not(:placeholder-shown), ver style.css),
// sem precisar de JS pra isso. Disparar um evento "input" de verdade (em vez
// de só zerar o .value) garante que o listener de busca de cada campo (que já
// existe e roda a cada digitação) reaja exatamente como se a pessoa tivesse
// apagado o texto na mão. Alguns campos (Relatórios) só buscam ao clicar um
// botão "Filtrar" em vez de reagir à digitação — pra esses, data-buscar
// aponta pro id desse botão, que é clicado logo em seguida.
document.querySelectorAll('.btn-limpar-busca').forEach((botao) => {
  botao.addEventListener('click', () => {
    const alvo = document.getElementById(botao.dataset.alvo);
    if (!alvo) return;
    alvo.value = '';
    alvo.dispatchEvent(new Event('input', { bubbles: true }));
    alvo.focus();
    if (botao.dataset.buscar) document.getElementById(botao.dataset.buscar)?.click();
  });
});

// Mostra o toast certo depois de uma gravação de cadastro/pagamento: se o
// modo totem offline-resiliente guardou a alteração numa fila local (porque
// o Turso não respondeu na hora — ver filaCadastroOffline.service.js), avisa
// isso em vez de dizer que já foi salvo; senão, mostra a mensagem normal de
// sucesso.
function avisarSincronizacaoOuSucesso(resp, mensagemSucesso) {
  if (resp && resp.enfileirado) {
    mostrarToast(resp.aviso || 'Sem conexão com o Turso agora — alteração guardada e será sincronizada quando a internet voltar.');
  } else {
    mostrarToast(mensagemSucesso);
  }
}

// O SQLite grava `datetime('now')` como "AAAA-MM-DD HH:MM:SS" em UTC, sem 'Z' nem
// deslocamento — sem essa marcação, o navegador interpreta a string como se já
// fosse horário local (em vez de UTC), deixando a hora exibida errada (deslocada
// pelo fuso, ex.: 3h adiantada no Brasil). Strings que já vêm com 'Z'/offset
// (geradas por `new Date().toISOString()` em outros pontos do backend) passam
// direto, sem alteração. Usar esta função (em vez de `new Date(...)` puro) em
// qualquer timestamp com hora vindo do servidor (criado_em, pago_em, último acesso etc.).
function parseDataHoraServidor(str) {
  if (!str) return null;
  const temFusoExplicito = /[zZ]|[+-]\d{2}:?\d{2}$/.test(str);
  const pareceDataHoraSemFuso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(str);
  const normalizado = pareceDataHoraSemFuso && !temFusoExplicito ? `${str.replace(' ', 'T')}Z` : str;
  return new Date(normalizado);
}

// Formata uma data-só (YYYY-MM-DD, sem hora — ex: vencimento, data de pagamento)
// pro padrão brasileiro SEM passar por Date/fuso-horário: "new Date('YYYY-MM-DD')"
// é interpretado como meia-noite UTC pelo JS, o que mostra o dia ANTERIOR pra
// qualquer fuso atrás de UTC (Brasil inteiro) — foi esse o bug de "data de
// pagamento um dia antes". Se a string tiver hora, cai pro parser que já trata
// fuso (parseDataHoraServidor). Use esta função pra exibir qualquer campo que
// seja só data (data, vencimento, data_avaliacao, data_inicio, data_fim...).
function formatarDataOuDataHora(str) {
  if (!str) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [ano, mes, dia] = str.split('-');
    return `${dia}/${mes}/${ano}`;
  }
  return parseDataHoraServidor(str).toLocaleDateString('pt-BR');
}

// Data local (YYYY-MM-DD) de HOJE, sem passar por toISOString() — esse método
// converte pra UTC antes de cortar a data, o que mostra o dia SEGUINTE em
// qualquer horário da noite no Brasil (fuso UTC-3). Use esta função em vez de
// `new Date().toISOString().slice(0, 10)` pra pré-preencher campos de data.
function hojeLocalISO() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function el(html) {
  // Usa <template> em vez de <div>: uma <div> descarta elementos de tabela
  // (<tr>, <td>...) quando não há um <table> ancestral, deixando firstChild nulo.
  // <template> faz o parsing correto de qualquer fragmento, inclusive linhas de tabela.
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

// ---------------- Chamadas à API ----------------

async function api(caminho, opcoes = {}) {
  const headers = { ...(opcoes.headers || {}) };
  if (opcoes.body) headers['Content-Type'] = 'application/json';
  if (estado.token) headers.Authorization = `Bearer ${estado.token}`;

  const resp = await fetch(caminho, { ...opcoes, headers });
  const contentType = resp.headers.get('content-type') || '';
  const dados = contentType.includes('application/json') ? await resp.json() : null;

  if (!resp.ok) {
    if (resp.status === 401) fazerLogout();
    throw new Error((dados && dados.erro) || `Erro ${resp.status}`);
  }
  return dados;
}

// Baixa um arquivo autenticado (backup JSON, exportação CSV...) direto pro computador
// do usuário. Precisa ser separado de api() porque a resposta não é JSON, e um <a href>
// comum não consegue mandar o header Authorization exigido por essas rotas.
async function baixarArquivoAutenticado(caminho, nomeArquivoFallback) {
  const headers = {};
  if (estado.token) headers.Authorization = `Bearer ${estado.token}`;
  const resp = await fetch(caminho, { headers });

  if (!resp.ok) {
    let mensagem = `Erro ${resp.status}`;
    try {
      const dados = await resp.json();
      if (dados?.erro) mensagem = dados.erro;
    } catch (err) { /* corpo não era JSON, mantém a mensagem genérica */ }
    throw new Error(mensagem);
  }

  const blob = await resp.blob();
  const disposition = resp.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const nomeArquivo = match ? match[1] : nomeArquivoFallback;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------- Login / Logout ----------------

function confirmar(mensagem) {
  return window.confirm(mensagem);
}

function mostrarApp() {
  document.getElementById('tela-login').classList.add('oculto');
  document.getElementById('tela-app').classList.remove('oculto');
  document.getElementById('usuario-nome').textContent = estado.usuario?.nome || '';
  document.getElementById('nav-usuarios').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  document.getElementById('nav-config').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  document.getElementById('nav-catraca').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  document.getElementById('nav-recuperacao').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  document.getElementById('btn-acessos-recentes').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  document.getElementById('grupo-gerar-recorrentes').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  carregarSecao('alunos');
  // Aviso de aniversariantes de hoje (feature de Recuperação de Clientes) —
  // roda logo após o login, sem precisar abrir a aba, pra quem tem permissão vê-la.
  if (estado.usuario?.papel === 'admin') verificarAniversariantesHoje(true);
}

// ---------------- Identidade do app (nome + "licenciado para") ----------------
// Roda antes mesmo do login (tela de login também mostra o nome do app), e de novo
// depois que o admin salva mudanças em Configurações.
async function carregarConfigApp() {
  try {
    const config = await api('/api/config');
    document.title = config.nome_app || 'Academia Gestão';
    document.getElementById('login-nome-app').textContent = config.nome_app || 'Academia Gestão';
    document.getElementById('sidebar-nome-app').textContent = config.nome_app || 'Academia Gestão';

    const licenciadoTexto = config.licenciado_para ? `Licenciado para ${config.licenciado_para}` : '';
    ['login-licenciado-para', 'sidebar-licenciado-para'].forEach((id) => {
      const el = document.getElementById(id);
      el.textContent = licenciadoTexto;
      el.classList.toggle('oculto', !licenciadoTexto);
    });

    aplicarOrdemMenu(config.menu_ordem);
  } catch (err) {
    // Falha em buscar config não pode travar o app — segue com os valores padrão do HTML.
  }
}

// ---------------- Ordem dos menus (reordenável pelo admin em Configurações) ----------------

const LABELS_MENU = {
  alunos: 'Alunos',
  planos: 'Planos',
  agenda: 'Turmas & Agenda',
  pagamentos: 'Contas a Receber',
  'pagamento-rapido': 'Pagamento Rápido',
  relatorios: 'Relatórios',
  recuperacao: 'Recuperação de Clientes',
  usuarios: 'Usuários',
  config: 'Configurações',
  catraca: 'Catraca',
};
const ORDEM_MENU_PADRAO = ['alunos', 'planos', 'agenda', 'pagamentos', 'pagamento-rapido', 'relatorios', 'recuperacao', 'usuarios', 'config', 'catraca'];
let ordemMenuAtual = [...ORDEM_MENU_PADRAO];

// Reordena os botões <nav> de verdade na barra lateral (move os elementos já
// existentes — não recria nada, então os listeners de clique continuam valendo).
function aplicarOrdemMenu(ordem) {
  const nav = document.querySelector('.sidebar nav') || document.querySelector('nav');
  if (!nav || !Array.isArray(ordem) || !ordem.length) return;
  // "Catraca" fica sempre por último, não importa a ordem salva pelo admin —
  // é assim que garantimos que "Acessos recentes"/"Sair" (fixados logo abaixo
  // do <nav> na barra lateral) sempre apareçam imediatamente abaixo dela.
  ordem.filter((secao) => secao !== 'catraca').forEach((secao) => {
    const btn = nav.querySelector(`.nav-btn[data-secao="${secao}"]`);
    if (btn) nav.appendChild(btn);
  });
  const btnCatraca = nav.querySelector('.nav-btn[data-secao="catraca"]');
  if (btnCatraca) nav.appendChild(btnCatraca);
}

// Desenha a listinha com setas ▲▼ na tela de Configurações, a partir do
// estado em memória `ordemMenuAtual` (só é gravado no servidor ao clicar "Salvar ordem").
function renderizarOrdemMenu() {
  const lista = document.getElementById('lista-ordem-menu');
  if (!lista) return;
  lista.innerHTML = '';
  ordemMenuAtual.forEach((secao, idx) => {
    const li = el(`
      <li style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid #e4e7ec;border-radius:8px">
        <span style="flex:1">${LABELS_MENU[secao] || secao}</span>
        <button type="button" class="btn-linha" data-acao="subir" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="btn-linha" data-acao="descer" ${idx === ordemMenuAtual.length - 1 ? 'disabled' : ''}>▼</button>
      </li>
    `);
    li.querySelector('[data-acao="subir"]').addEventListener('click', () => {
      if (idx === 0) return;
      [ordemMenuAtual[idx - 1], ordemMenuAtual[idx]] = [ordemMenuAtual[idx], ordemMenuAtual[idx - 1]];
      renderizarOrdemMenu();
    });
    li.querySelector('[data-acao="descer"]').addEventListener('click', () => {
      if (idx === ordemMenuAtual.length - 1) return;
      [ordemMenuAtual[idx + 1], ordemMenuAtual[idx]] = [ordemMenuAtual[idx], ordemMenuAtual[idx + 1]];
      renderizarOrdemMenu();
    });
    lista.appendChild(li);
  });
}

document.getElementById('btn-salvar-ordem-menu').addEventListener('click', async () => {
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ menu_ordem: ordemMenuAtual }) });
    aplicarOrdemMenu(ordemMenuAtual);
    mostrarToast('Ordem dos menus salva.');
  } catch (err) { mostrarToast(err.message, true); }
});

function mostrarLogin() {
  document.getElementById('tela-app').classList.add('oculto');
  document.getElementById('tela-login').classList.remove('oculto');
}

function fazerLogout() {
  estado.token = null;
  estado.usuario = null;
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  fecharPainelAcessos();
  mostrarLogin();
}

document.getElementById('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const identificador = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-senha').value;
  const erroEl = document.getElementById('login-erro');
  erroEl.textContent = '';

  try {
    const resp = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identificador, senha }) });
    estado.token = resp.token;
    estado.usuario = resp.usuario;
    localStorage.setItem('token', resp.token);
    localStorage.setItem('usuario', JSON.stringify(resp.usuario));
    mostrarApp();
  } catch (err) {
    erroEl.textContent = err.message;
  }
});

document.getElementById('btn-sair').addEventListener('click', fazerLogout);

// ---------------- Navegação entre seções ----------------

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    // Catraca virou uma janela flutuante (sobreposta), não uma seção de página —
    // abre por cima do que já está na tela, sem trocar de aba.
    if (btn.dataset.secao === 'catraca') {
      abrirJanelaCatraca();
      return;
    }
    descartarRascunhoSeExistir();
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('ativo'));
    btn.classList.add('ativo');
    document.querySelectorAll('.secao').forEach((s) => s.classList.add('oculto'));
    document.getElementById(`secao-${btn.dataset.secao}`).classList.remove('oculto');
    carregarSecao(btn.dataset.secao);
  });
});

function carregarSecao(nome) {
  if (nome === 'alunos') carregarAlunos();
  if (nome === 'planos') carregarPlanos();
  if (nome === 'agenda') carregarAgenda();
  if (nome === 'pagamentos') carregarPagamentos();
  if (nome === 'pagamento-rapido') iniciarPagamentoRapido();
  if (nome === 'usuarios') carregarUsuarios();
  if (nome === 'config') { carregarConfiguracoesForm(); carregarPendenciasSincronizacao(); }
  if (nome === 'recuperacao') carregarSecaoRecuperacao();
  if (nome === 'relatorios') carregarSecaoRelatorios();
}

// ---------------- Janela flutuante da catraca (sobreposta, arrastável) ----------------

function abrirJanelaCatraca() {
  document.getElementById('janela-catraca').classList.remove('oculto');
  carregarSecaoCatraca();
}
function fecharJanelaCatraca() {
  document.getElementById('janela-catraca').classList.add('oculto');
}
document.getElementById('btn-fechar-janela-catraca').addEventListener('click', fecharJanelaCatraca);

// Torna uma janela flutuante arrastável a partir de uma "alça" (ex.: a barra do topo).
// Reaproveitável para outras janelas flutuantes que venham a existir no futuro.
function tornarArrastavel(janela, alca) {
  let arrastando = false;
  let deslocX = 0;
  let deslocY = 0;

  alca.addEventListener('mousedown', (ev) => {
    arrastando = true;
    const retangulo = janela.getBoundingClientRect();
    deslocX = ev.clientX - retangulo.left;
    deslocY = ev.clientY - retangulo.top;
    // Passa a posicionar por left/top em pixels absolutos (em vez do CSS inicial).
    janela.style.left = `${retangulo.left}px`;
    janela.style.top = `${retangulo.top}px`;
    ev.preventDefault();
  });

  document.addEventListener('mousemove', (ev) => {
    if (!arrastando) return;
    const larguraJanela = janela.offsetWidth;
    const alturaJanela = janela.offsetHeight;
    let novoX = ev.clientX - deslocX;
    let novoY = ev.clientY - deslocY;
    // Mantém a janela dentro da área visível da tela.
    novoX = Math.max(0, Math.min(novoX, window.innerWidth - larguraJanela));
    novoY = Math.max(0, Math.min(novoY, window.innerHeight - alturaJanela));
    janela.style.left = `${novoX}px`;
    janela.style.top = `${novoY}px`;
  });

  document.addEventListener('mouseup', () => { arrastando = false; });
}

// Adiciona os botões de minimizar/maximizar na barra do topo de uma janela
// flutuante (o fechar já existe em cada janela, esse aqui é genérico/reaproveitável).
// Minimizar recolhe pra só a barra do topo continuar visível (não fecha de fato).
// Maximizar aumenta pra um tamanho maior - NÃO é tela cheia de verdade, só "grande",
// com margem - clicando de novo volta pro tamanho/posição de antes.
function adicionarControlesJanela(janela) {
  if (!janela) return;
  const topo = janela.querySelector('.janela-flutuante-topo');
  const botaoFechar = topo ? topo.querySelector('.btn-fechar-painel') : null;
  if (!topo || !botaoFechar) return;

  const btnMinimizar = document.createElement('button');
  btnMinimizar.type = 'button';
  btnMinimizar.className = 'btn-minimizar-painel';
  btnMinimizar.title = 'Minimizar';
  btnMinimizar.innerHTML = '&#8211;';
  btnMinimizar.addEventListener('click', () => janela.classList.toggle('janela-flutuante-minimizada'));

  const btnMaximizar = document.createElement('button');
  btnMaximizar.type = 'button';
  btnMaximizar.className = 'btn-maximizar-painel';
  btnMaximizar.title = 'Maximizar';
  btnMaximizar.innerHTML = '&#9633;';
  btnMaximizar.addEventListener('click', () => alternarMaximizarJanela(janela));

  topo.insertBefore(btnMinimizar, botaoFechar);
  topo.insertBefore(btnMaximizar, botaoFechar);
}

function alternarMaximizarJanela(janela) {
  if (janela.classList.contains('janela-flutuante-maximizada')) {
    janela.classList.remove('janela-flutuante-maximizada');
    const anterior = janela.dataset.antesMaximizar ? JSON.parse(janela.dataset.antesMaximizar) : null;
    janela.style.width = anterior?.width || '';
    janela.style.height = anterior?.height || '';
    janela.style.top = anterior?.top || '';
    janela.style.left = anterior?.left || '';
    delete janela.dataset.antesMaximizar;
  } else {
    janela.dataset.antesMaximizar = JSON.stringify({
      width: janela.style.width || '',
      height: janela.style.height || '',
      top: janela.style.top || '',
      left: janela.style.left || '',
    });
    janela.classList.remove('janela-flutuante-minimizada');
    janela.classList.add('janela-flutuante-maximizada');
    janela.style.width = '90vw';
    janela.style.height = '85vh';
    janela.style.top = '6vh';
    janela.style.left = '5vw';
  }
}

tornarArrastavel(document.getElementById('janela-catraca'), document.getElementById('janela-catraca-alca'));
adicionarControlesJanela(document.getElementById('janela-catraca'));

tornarArrastavel(document.getElementById('painel-acessos'), document.getElementById('painel-acessos-alca'));
adicionarControlesJanela(document.getElementById('painel-acessos'));

// ---------------- Configurações (nome do app, licenciado para, backup) ----------------

// Padrões espelhando PADROES.som_totem em config.routes.js — usados aqui só
// pra preencher o formulário quando ainda não existe nada salvo.
const SOM_TOTEM_PADRAO = {
  primeiroAcesso: { tipo: 'voz', texto: 'Bom treino!' },
  acessoLiberado: { tipo: 'beep', beeps: 1, texto: 'Acesso liberado' },
  acessoNegado: { tipo: 'beep', beeps: 2, texto: 'Acesso negado' },
};
const SITUACOES_SOM_TOTEM = ['primeiroAcesso', 'acessoLiberado', 'acessoNegado'];

function atualizarVisibilidadeCamposSom(situacao) {
  const linha = document.querySelector(`[data-som-linha="${situacao}"]`);
  if (!linha) return;
  const tipo = linha.querySelector('.som-totem-tipo').value;
  linha.querySelector('.som-totem-campo-texto').classList.toggle('oculto', tipo !== 'voz');
  linha.querySelector('.som-totem-campo-beeps').classList.toggle('oculto', tipo !== 'beep');
}

function preencherLinhaSomTotem(situacao, dados) {
  const linha = document.querySelector(`[data-som-linha="${situacao}"]`);
  if (!linha) return;
  linha.querySelector('.som-totem-tipo').value = dados.tipo || 'beep';
  linha.querySelector('.som-totem-texto').value = dados.texto || '';
  linha.querySelector('.som-totem-beeps').value = dados.beeps || 1;
  atualizarVisibilidadeCamposSom(situacao);
}

function lerLinhaSomTotem(situacao) {
  const linha = document.querySelector(`[data-som-linha="${situacao}"]`);
  return {
    tipo: linha.querySelector('.som-totem-tipo').value,
    texto: linha.querySelector('.som-totem-texto').value.trim(),
    beeps: Number(linha.querySelector('.som-totem-beeps').value) || 1,
  };
}

document.querySelectorAll('.som-totem-tipo').forEach((sel) => {
  sel.addEventListener('change', () => atualizarVisibilidadeCamposSom(sel.dataset.somSituacao));
});

// ---------------- Testar aviso sonoro (admin) ----------------
// Mesma lógica de tocarAvisoSonoro/tocarBeep/falarTexto do totem (ver
// public/terminal.js) — duplicada aqui de propósito: cada página deste
// projeto carrega seu próprio .js isolado, sem sistema de módulos
// compartilhados (mesmo motivo documentado em
// filaCadastroOffline.service.js pra duplicar trechos pequenos em vez de
// arriscar um require circular).
let audioCtxSomAdmin = null;
function tocarBeepAdmin(vezes = 1) {
  try {
    audioCtxSomAdmin = audioCtxSomAdmin || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtxSomAdmin;
    for (let i = 0; i < vezes; i++) {
      const inicio = ctx.currentTime + i * 0.35;
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      ganho.gain.setValueAtTime(0.0001, inicio);
      ganho.gain.exponentialRampToValueAtTime(0.3, inicio + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.18);
      osc.connect(ganho);
      ganho.connect(ctx.destination);
      osc.start(inicio);
      osc.stop(inicio + 0.2);
    }
  } catch { /* som é só reforço, nunca deve travar nada */ }
}

function falarTextoAdmin(texto) {
  try {
    if (!('speechSynthesis' in window) || !texto) return;
    speechSynthesis.cancel();
    const fala = new SpeechSynthesisUtterance(texto);
    fala.lang = 'pt-BR';
    speechSynthesis.speak(fala);
  } catch { /* idem */ }
}

document.querySelectorAll('.btn-testar-som').forEach((btn) => {
  btn.addEventListener('click', () => {
    const dados = lerLinhaSomTotem(btn.dataset.somSituacao);
    if (dados.tipo === 'voz') falarTextoAdmin(dados.texto);
    else if (dados.tipo === 'beep') tocarBeepAdmin(dados.beeps);
    else mostrarToast('Situação configurada como "Nenhum" — não toca som.');
  });
});

document.getElementById('form-config-som-totem').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const somTotem = {};
  SITUACOES_SOM_TOTEM.forEach((situacao) => { somTotem[situacao] = lerLinhaSomTotem(situacao); });
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ som_totem: somTotem }) });
    mostrarToast('Aviso sonoro salvo.');
  } catch (err) { mostrarToast(err.message, true); }
});

async function carregarConfiguracoesForm() {
  try {
    const config = await api('/api/config');
    document.getElementById('config-nome-app').value = config.nome_app || '';
    document.getElementById('config-licenciado-para').value = config.licenciado_para || '';
    document.getElementById('config-treino-app-url').value = config.treino_app_url || '';
    document.getElementById('config-whatsapp-contato').value = config.whatsapp_contato || '';
    document.getElementById('config-link-portal').value = `${window.location.origin}/portal.html`;
    ordemMenuAtual = Array.isArray(config.menu_ordem) && config.menu_ordem.length
      ? [...config.menu_ordem]
      : [...ORDEM_MENU_PADRAO];
    renderizarOrdemMenu();

    const somConfig = config.som_totem && typeof config.som_totem === 'object' ? config.som_totem : {};
    SITUACOES_SOM_TOTEM.forEach((situacao) => {
      preencherLinhaSomTotem(situacao, { ...SOM_TOTEM_PADRAO[situacao], ...(somConfig[situacao] || {}) });
    });
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('form-config-app').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    nome_app: document.getElementById('config-nome-app').value.trim() || 'Academia Gestão',
    licenciado_para: document.getElementById('config-licenciado-para').value.trim(),
    treino_app_url: document.getElementById('config-treino-app-url').value.trim(),
    whatsapp_contato: document.getElementById('config-whatsapp-contato').value.trim(),
  };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(dados) });
    mostrarToast('Configurações salvas.');
    carregarConfigApp();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-copiar-link-portal').addEventListener('click', async () => {
  const input = document.getElementById('config-link-portal');
  try {
    await navigator.clipboard.writeText(input.value);
    mostrarToast('Link copiado.');
  } catch {
    input.select();
    mostrarToast('Selecione e copie manualmente (Ctrl+C).', true);
  }
});

document.getElementById('btn-baixar-backup').addEventListener('click', async () => {
  try {
    mostrarToast('Gerando backup...');
    await baixarArquivoAutenticado('/api/config/backup', `backup-academia-${hojeLocalISO()}.json`);
    mostrarToast('Backup baixado.');
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- Pendências de sincronização (modo totem offline-resiliente) ----------------
// Só aparece algo aqui em academias usando o processo "academia-gestao-totem"
// (ver ecosystem.config.js) — o painel normal na nuvem nunca gera pendência
// nenhuma. O painel busca sempre (é barato, uma linha na tabela config se
// não houver nada) e só mostra o bloco quando existe pelo menos uma pendência.

function descreverCampoPendencia(item) {
  // 2026-07-14: prioriza o nome do aluno (item.alunoNome, resolvido no
  // servidor no momento em que a pendência foi criada) quando disponível.
  // Pendências criadas ANTES dessa correção não têm esse campo — nesses
  // casos cai pro texto antigo (descricaoResumo com o id bruto), que
  // continua funcionando igual, só sem o nome.
  if (item.tipo === 'pagamento') {
    return item.alunoNome
      ? `Pagamento de ${formatarMoeda(item.pagamento?.valor_centavos)} de ${item.alunoNome}`
      : (item.descricaoResumo || `Pagamento de ${formatarMoeda(item.pagamento?.valor_centavos)} (conta ${item.registroId})`);
  }
  return item.descricaoResumo || `Alteração em ${item.tabela} (${item.registroId})`;
}

function renderizarValorPendencia(valor) {
  if (valor === null || valor === undefined || valor === '') return '<em>vazio</em>';
  return String(valor);
}

async function carregarPendenciasSincronizacao() {
  const painel = document.getElementById('painel-pendencias-sincronizacao');
  const lista = document.getElementById('lista-pendencias-sincronizacao');
  try {
    const pendencias = await api('/api/alunos/pendencias-sincronizacao');
    if (!pendencias.length) {
      painel.classList.add('oculto');
      lista.innerHTML = '';
      return;
    }
    painel.classList.remove('oculto');
    lista.innerHTML = pendencias.map((item) => {
      const dataFormatada = parseDataHoraServidor(item.criadoEm).toLocaleString('pt-BR');
      if (!item.conflito) {
        return `
          <div class="form-painel" style="margin-bottom:8px;background:#f9fafb">
            <strong>${descreverCampoPendencia(item)}</strong>
            <p style="margin:4px 0 0;color:#667085;font-size:13px">
              Feito offline em ${dataFormatada} — ainda aguardando a próxima sincronização (nenhum conflito detectado até agora).
            </p>
          </div>`;
      }

      // Pra pagamento, o "editado offline" não é um valor de campo (é uma
      // conta nova sendo inserida) — o que importa comparar é só o status da
      // conta antes/agora. Pra edição de cadastro, mostra campo a campo.
      const camposConflito = item.tipo === 'pagamento'
        ? [{ nome: 'status da conta', atual: item.valoresAtuaisNoConflito?.status, editadoOffline: `(pagamento de ${formatarMoeda(item.pagamento?.valor_centavos)} pendente de aplicar)` }]
        : Object.keys(item.campos || {}).map((campo) => ({
          nome: campo,
          atual: (item.valoresAtuaisNoConflito || {})[campo],
          editadoOffline: item.campos[campo],
        }));

      const linhasConflito = camposConflito.map((c) => `
        <tr>
          <td>${c.nome}</td>
          <td>${renderizarValorPendencia(c.atual)}</td>
          <td>${renderizarValorPendencia(c.editadoOffline)}</td>
        </tr>`).join('');

      return `
        <div class="form-painel" style="margin-bottom:8px;border:1px solid #f59e0b;background:#fffbeb">
          <strong>⚠️ Conflito — ${descreverCampoPendencia(item)}</strong>
          <p style="margin:4px 0 8px;color:#667085;font-size:13px">
            Editado offline em ${dataFormatada}, mas o valor no sistema mudou por outro caminho enquanto a
            academia estava sem internet. Confira abaixo e decida o que manter.
          </p>
          <table class="tabela" style="margin-bottom:8px">
            <thead><tr><th>Campo</th><th>Valor atual no sistema</th><th>Valor editado offline</th></tr></thead>
            <tbody>${linhasConflito}</tbody>
          </table>
          <div class="form-acoes">
            <button type="button" class="btn-secundario" data-pendencia-descartar="${item.id}">Manter valor atual do sistema</button>
            <button type="button" class="btn-primario" data-pendencia-aplicar="${item.id}">Aplicar edição feita offline</button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    painel.classList.add('oculto');
  }
}

document.getElementById('lista-pendencias-sincronizacao').addEventListener('click', async (ev) => {
  const idAplicar = ev.target.dataset.pendenciaAplicar;
  const idDescartar = ev.target.dataset.pendenciaDescartar;
  const id = idAplicar || idDescartar;
  if (!id) return;

  const decisao = idAplicar ? 'aplicar' : 'descartar';
  ev.target.disabled = true;
  try {
    await api(`/api/alunos/pendencias-sincronizacao/${id}/resolver`, { method: 'POST', body: JSON.stringify({ decisao }) });
    mostrarToast(decisao === 'aplicar' ? 'Edição offline aplicada.' : 'Mantido o valor atual do sistema.');
    await carregarPendenciasSincronizacao();
  } catch (err) {
    mostrarToast(err.message, true);
    ev.target.disabled = false;
  }
});

// Sai do perfil do aluno e volta para a listagem, reativando o item de navegação.
function voltarParaAlunos() {
  descartarRascunhoSeExistir();
  if (typeof pararCameraPerfil === 'function') pararCameraPerfil();
  document.getElementById('secao-perfil-aluno').classList.add('oculto');
  document.querySelectorAll('.secao').forEach((s) => s.classList.add('oculto'));
  document.getElementById('secao-alunos').classList.remove('oculto');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('ativo'));
  document.querySelector('.nav-btn[data-secao="alunos"]').classList.add('ativo');
  carregarAlunos();
}
document.getElementById('btn-voltar-alunos').addEventListener('click', voltarParaAlunos);

// ---------------- ALUNOS ----------------

// Estado de ordenação da tabela de Alunos (clique no título da coluna).
// "id" ordena por data de criação de verdade (o id é um UUID, não sequencial) —
// primeiro clique mostra do mais recente ao mais antigo, como pedido.
const DIRECAO_INICIAL_COLUNA_ALUNOS = { id: 'desc', nome: 'asc', contato: 'asc', status: 'asc' };
// Padrão da tela: mais recente cadastrado primeiro (mesma regra do clique na coluna ID).
let ordenacaoAlunos = { campo: 'id', direcao: 'desc' };

function alternarOrdenacaoAlunos(campo) {
  if (ordenacaoAlunos.campo === campo) {
    ordenacaoAlunos.direcao = ordenacaoAlunos.direcao === 'asc' ? 'desc' : 'asc';
  } else {
    ordenacaoAlunos = { campo, direcao: DIRECAO_INICIAL_COLUNA_ALUNOS[campo] || 'asc' };
  }
  carregarAlunos();
}

function ordenarAlunos(lista) {
  if (!ordenacaoAlunos.campo) return lista;
  const { campo, direcao } = ordenacaoAlunos;
  const mult = direcao === 'asc' ? 1 : -1;
  const valorDe = (aluno) => {
    if (campo === 'id') return aluno.criado_em || '';
    if (campo === 'contato') return [aluno.email, aluno.telefone].filter(Boolean).join(' · ');
    return (aluno[campo] || '').toString().toLowerCase();
  };
  return [...lista].sort((a, b) => {
    const va = valorDe(a);
    const vb = valorDe(b);
    if (va < vb) return -1 * mult;
    if (va > vb) return 1 * mult;
    return 0;
  });
}

function atualizarSetasOrdenacaoAlunos() {
  document.querySelectorAll('#secao-alunos .seta-ordenacao').forEach((span) => {
    const campo = span.dataset.seta;
    span.textContent = ordenacaoAlunos.campo !== campo ? '' : (ordenacaoAlunos.direcao === 'asc' ? '▲' : '▼');
  });
}

document.querySelectorAll('#secao-alunos .th-ordenavel').forEach((th) => {
  th.addEventListener('click', () => alternarOrdenacaoAlunos(th.dataset.sort));
});

async function carregarAlunos() {
  try {
    const busca = document.getElementById('busca-aluno').value.trim();
    const mostrarInativos = document.getElementById('mostrar-inativos-alunos').checked;
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    if (mostrarInativos) params.set('incluir_inativos', 'true');
    const alunosBrutos = await api(`/api/alunos${params.toString() ? '?' + params.toString() : ''}`);
    const alunos = ordenarAlunos(alunosBrutos);
    atualizarSetasOrdenacaoAlunos();
    const tbody = document.getElementById('lista-alunos');
    tbody.innerHTML = '';
    alunos.forEach((aluno) => {
      const contato = [aluno.email, aluno.telefone].filter(Boolean).join(' · ') || '—';
      const tr = el(`
        <tr>
          <td title="${aluno.id}">${aluno.id.slice(0, 8)}</td>
          <td><span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${aluno.nome}</span></td>
          <td>${contato}</td>
          <td><span class="badge ${aluno.status}">${aluno.status}</span></td>
          <td>
            <button class="btn-linha" data-acao="perfil">Perfil</button>
            <button class="btn-linha" data-acao="editar">Editar</button>
            <select class="btn-linha" data-acao="status" style="padding:5px">
              <option value="ativo">ativo</option>
              <option value="inativo">inativo</option>
              <option value="trancado">trancado</option>
              <option value="inadimplente">inadimplente</option>
            </select>
            <button class="btn-linha perigo" data-acao="excluir">Excluir</button>
          </td>
        </tr>
      `);
      tr.querySelector('[data-acao="status"]').value = aluno.status;
      tr.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(aluno.id));
      tr.querySelector('[data-acao="perfil"]').addEventListener('click', () => abrirPerfilAluno(aluno.id));
      tr.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirFormAluno(aluno));
      tr.querySelector('[data-acao="status"]').addEventListener('change', async (ev) => {
        try {
          await api(`/api/alunos/${aluno.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: ev.target.value }) });
          mostrarToast('Status atualizado.');
          carregarAlunos();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tr.querySelector('[data-acao="excluir"]').addEventListener('click', async () => {
        if (!confirmar(`Excluir o aluno "${aluno.nome}"? Isso também remove matrículas, agendamentos e cobranças dele. Esta ação não pode ser desfeita.`)) return;
        try {
          await api(`/api/alunos/${aluno.id}`, { method: 'DELETE' });
          mostrarToast('Aluno excluído.');
          carregarAlunos();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

let buscaAlunoTimeout = null;
document.getElementById('busca-aluno').addEventListener('input', () => {
  clearTimeout(buscaAlunoTimeout);
  buscaAlunoTimeout = setTimeout(carregarAlunos, 300);
});
document.getElementById('mostrar-inativos-alunos').addEventListener('change', () => {
  carregarAlunos();
});

// ---------------- Importar / exportar alunos (CSV) ----------------

document.getElementById('btn-exportar-alunos').addEventListener('click', async () => {
  try {
    await baixarArquivoAutenticado('/api/alunos/exportar', `alunos-${hojeLocalISO()}.csv`);
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-importar-alunos').addEventListener('click', () => {
  document.getElementById('input-importar-alunos').click();
});

document.getElementById('input-importar-alunos').addEventListener('change', async (ev) => {
  const arquivo = ev.target.files[0];
  ev.target.value = ''; // permite selecionar o mesmo arquivo de novo depois
  if (!arquivo) return;
  if (!confirmar(`Importar alunos do arquivo "${arquivo.name}"? Alunos com o mesmo CPF ou e-mail já cadastrados serão atualizados; os demais serão criados.`)) return;

  try {
    const texto = await arquivo.text();
    const resp = await api('/api/alunos/importar', { method: 'POST', body: JSON.stringify({ csv: texto }) });
    const resumo = `${resp.criados} criado(s), ${resp.atualizados} atualizado(s)${resp.erros.length ? `, ${resp.erros.length} erro(s)` : ''}.`;
    mostrarToast(`Importação concluída: ${resumo}`, resp.erros.length > 0);
    if (resp.erros.length) console.warn('Erros na importação de alunos:', resp.erros);
    carregarAlunos();
  } catch (err) { mostrarToast(err.message, true); }
});

async function popularSelectPlanoDoFormAluno() {
  try {
    const planos = await api('/api/planos');
    const select = document.getElementById('aluno-plano');
    select.innerHTML = '<option value="">Nenhum (matricular depois)</option>' +
      planos.map((p) => `<option value="${p.id}">${p.nome} (${formatarMoeda(p.valor_centavos)})</option>`).join('');
  } catch (err) { mostrarToast(err.message, true); }
}

async function abrirFormAluno(aluno = null) {
  const form = document.getElementById('form-aluno');
  form.classList.remove('oculto');
  document.getElementById('aluno-id').value = aluno?.id || '';
  document.getElementById('aluno-nome').value = aluno?.nome || '';
  document.getElementById('aluno-email').value = aluno?.email || '';
  document.getElementById('aluno-telefone').value = aluno?.telefone || '';
  document.getElementById('aluno-cpf').value = aluno?.cpf || '';
  document.getElementById('aluno-nascimento').value = aluno?.data_nascimento || '';
  document.getElementById('aluno-observacoes').value = aluno?.observacoes || '';
  document.getElementById('aluno-plano-data').value = hojeLocalISO();
  await popularSelectPlanoDoFormAluno();
  document.getElementById('aluno-plano').value = '';

  // A avaliação física inicial só faz sentido no cadastro de um aluno novo —
  // para alunos já existentes, use a aba "Perfil" para adicionar avaliações.
  document.getElementById('bloco-avaliacao-inicial').classList.toggle('oculto', Boolean(aluno));
  document.getElementById('aluno-avaliacao-peso').value = '';
  document.getElementById('aluno-avaliacao-altura').value = '';
  document.getElementById('aluno-avaliacao-gordura').value = '';
  document.getElementById('aluno-avaliacao-objetivo').value = '';

  form.querySelector('h3').textContent = aluno ? 'Editar aluno' : 'Novo aluno';
  form.scrollIntoView({ behavior: 'smooth' });
}

// "+ Novo aluno" já cria o registro (com nome provisório) e abre direto no perfil
// completo — as mesmas abas de um aluno existente (Biometria, Financeiro, Avaliações,
// Matrículas...). Enquanto a aba "Dados pessoais" não for salva pelo menos uma vez,
// esse registro é só um rascunho: sair sem salvar apaga ele (ver descartarRascunhoSeExistir).
document.getElementById('btn-novo-aluno').addEventListener('click', async () => {
  try {
    const criado = await api('/api/alunos', { method: 'POST', body: JSON.stringify({ nome: 'Novo aluno' }) });
    rascunhoNovoAlunoId = criado.id;
    await abrirPerfilAluno(criado.id);
    const campoNome = document.getElementById('perfil-nome');
    campoNome.focus();
    campoNome.select();
    mostrarToast('Preencha os dados e clique em "Salvar dados". Se sair sem salvar, o cadastro é descartado.');
  } catch (err) { mostrarToast(err.message, true); }
});
document.getElementById('btn-cancelar-aluno').addEventListener('click', () => {
  document.getElementById('form-aluno').classList.add('oculto');
});

document.getElementById('form-aluno').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = document.getElementById('aluno-id').value;
  const planoId = document.getElementById('aluno-plano').value;
  const planoData = document.getElementById('aluno-plano-data').value;
  const dados = {
    nome: document.getElementById('aluno-nome').value.trim(),
    email: document.getElementById('aluno-email').value.trim() || null,
    telefone: document.getElementById('aluno-telefone').value.trim() || null,
    cpf: document.getElementById('aluno-cpf').value.trim() || null,
    data_nascimento: document.getElementById('aluno-nascimento').value || null,
    observacoes: document.getElementById('aluno-observacoes').value.trim() || null,
  };

  try {
    let alunoId = id;
    if (id) {
      const respPut = await api(`/api/alunos/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      avisarSincronizacaoOuSucesso(respPut, 'Aluno atualizado.');
    } else {
      const criado = await api('/api/alunos', { method: 'POST', body: JSON.stringify(dados) });
      alunoId = criado.id;
      mostrarToast('Aluno cadastrado.');
    }

    if (planoId) {
      try {
        await api('/api/planos/matricular', {
          method: 'POST',
          body: JSON.stringify({ aluno_id: alunoId, plano_id: planoId, data_inicio: planoData || hojeLocalISO() }),
        });
        mostrarToast('Aluno matriculado no plano. Primeira cobrança gerada em Contas a Receber.');
      } catch (err) {
        mostrarToast(`Aluno salvo, mas não foi possível matricular: ${err.message}`, true);
      }
    }

    if (!id) {
      const peso = document.getElementById('aluno-avaliacao-peso').value;
      const altura = document.getElementById('aluno-avaliacao-altura').value;
      const gordura = document.getElementById('aluno-avaliacao-gordura').value;
      const objetivo = document.getElementById('aluno-avaliacao-objetivo').value.trim();
      if (peso || altura || gordura || objetivo) {
        try {
          await api(`/api/alunos/${alunoId}/avaliacoes`, {
            method: 'POST',
            body: JSON.stringify({
              data_avaliacao: hojeLocalISO(),
              peso_kg: peso ? Number(peso) : null,
              altura_cm: altura ? Number(altura) : null,
              percentual_gordura: gordura ? Number(gordura) : null,
              objetivo: objetivo || null,
            }),
          });
        } catch (err) {
          mostrarToast(`Aluno salvo, mas não foi possível registrar a avaliação física: ${err.message}`, true);
        }
      }
    }

    document.getElementById('form-aluno').classList.add('oculto');
    ev.target.reset();
    carregarAlunos();
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- PERFIL DO ALUNO ----------------

let perfilAtualId = null;

// Id do aluno "rascunho" criado pelo fluxo de "+ Novo aluno" (ver mais abaixo). Enquanto
// não for salvo pelo menos uma vez na aba "Dados pessoais", sair do perfil sem salvar
// apaga esse registro — assim nenhum cadastro vazio/incompleto fica esquecido no banco.
let rascunhoNovoAlunoId = null;

// Chamada sempre que o usuário sai do perfil (Voltar, trocar de menu, etc.) — se havia um
// rascunho de aluno novo ainda não salvo, descarta (apaga) e avisa; senão não faz nada.
async function descartarRascunhoSeExistir() {
  if (!rascunhoNovoAlunoId) return;
  const id = rascunhoNovoAlunoId;
  rascunhoNovoAlunoId = null;
  try {
    await api(`/api/alunos/${id}`, { method: 'DELETE' });
    mostrarToast('Cadastro não concluído — descartado.');
  } catch (err) {
    // Se der erro ao apagar (ex.: já tinha sido salvo por outra aba), não trava a navegação.
  }
}

// Aviso nativo do navegador ao fechar a aba/janela com um rascunho aberto. Não consegue
// apagar o registro nesse caso (não dá pra fazer chamada autenticada de forma confiável
// no evento de descarregar a página) — só avisa, pra reduzir a chance de esquecer aberto.
window.addEventListener('beforeunload', (ev) => {
  if (!rascunhoNovoAlunoId) return;
  ev.preventDefault();
  ev.returnValue = '';
});

async function abrirPerfilAluno(alunoId) {
  perfilAtualId = alunoId;
  document.querySelectorAll('.secao').forEach((s) => s.classList.add('oculto'));
  document.getElementById('secao-perfil-aluno').classList.remove('oculto');
  trocarAbaPerfil('dados'); // sempre volta pra primeira aba ao abrir um aluno diferente
  await carregarPerfilAluno();
}

// ---------------- Abas do perfil do aluno (Dados / Biometria / Anamnese / Avaliações / Matrículas / Agendamentos / Financeiro) ----------------

function trocarAbaPerfil(nomeAba) {
  document.querySelectorAll('.perfil-tab-btn').forEach((b) => b.classList.toggle('ativo', b.dataset.tab === nomeAba));
  document.querySelectorAll('.perfil-tab-painel').forEach((p) => p.classList.toggle('oculto', p.dataset.tabPainel !== nomeAba));
}

document.querySelectorAll('.perfil-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => trocarAbaPerfil(btn.dataset.tab));
});

async function carregarPerfilAluno() {
  try {
    const perfil = await api(`/api/alunos/${perfilAtualId}/perfil`);
    const { aluno, anamnese, avaliacoes, matriculas, agendamentos, cobrancas } = perfil;

    document.getElementById('perfil-nome-aluno').textContent = `Perfil de ${aluno.nome}`;
    document.getElementById('perfil-aluno-id').value = aluno.id;
    document.getElementById('perfil-nome').value = aluno.nome || '';
    document.getElementById('perfil-email').value = aluno.email || '';
    document.getElementById('perfil-telefone').value = aluno.telefone || '';
    document.getElementById('perfil-cpf').value = aluno.cpf || '';
    document.getElementById('perfil-nascimento').value = aluno.data_nascimento || '';
    document.getElementById('perfil-observacoes').value = aluno.observacoes || '';
    document.getElementById('perfil-biometria-id').value = aluno.biometria_id || '';
    document.getElementById('perfil-link-acesso').value = aluno.codigo_acesso
      ? `${window.location.origin}/meu-acesso.html?codigo=${aluno.codigo_acesso}`
      : '';

    document.getElementById('anamnese-peso').value = anamnese?.peso_kg ?? '';
    document.getElementById('anamnese-altura').value = anamnese?.altura_cm ?? '';
    document.getElementById('anamnese-historico').value = anamnese?.historico_saude || '';
    document.getElementById('anamnese-restricoes').value = anamnese?.restricoes || '';
    document.getElementById('anamnese-observacoes').value = anamnese?.observacoes_medicas || '';

    const tbodyAval = document.getElementById('lista-avaliacoes');
    tbodyAval.innerHTML = avaliacoes.length ? '' : '<tr><td colspan="5">Nenhuma avaliação registrada.</td></tr>';
    avaliacoes.forEach((av) => {
      const tr = el(`
        <tr>
          <td>${av.data_avaliacao}</td>
          <td>${av.peso_kg ? av.peso_kg + ' kg' : '—'}</td>
          <td>${av.percentual_gordura ? av.percentual_gordura + '%' : '—'}</td>
          <td>${av.objetivo || '—'}</td>
          <td><button class="btn-linha perigo" data-acao="excluir-avaliacao">Excluir</button></td>
        </tr>
      `);
      tr.querySelector('[data-acao="excluir-avaliacao"]').addEventListener('click', async () => {
        if (!confirmar('Excluir esta avaliação física?')) return;
        try {
          await api(`/api/alunos/avaliacoes/${av.id}`, { method: 'DELETE' });
          mostrarToast('Avaliação excluída.');
          carregarPerfilAluno();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbodyAval.appendChild(tr);
    });

    const tbodyMatriculas = document.getElementById('perfil-lista-matriculas');
    tbodyMatriculas.innerHTML = matriculas.length ? '' : '<tr><td colspan="5">Nenhuma matrícula.</td></tr>';
    matriculas.forEach((m) => {
      const tr = el(`
        <tr>
          <td>${m.plano_nome}</td>
          <td>${m.data_inicio}</td>
          <td>${m.data_fim || '—'}</td>
          <td><span class="badge ${m.status}">${m.status}</span></td>
          <td>${(m.status === 'ativa' || m.status === 'pendente') ? '<button class="btn-linha perigo" data-acao="cancelar-matricula">Cancelar</button>' : '—'}</td>
        </tr>`);
      const botaoCancelar = tr.querySelector('[data-acao="cancelar-matricula"]');
      if (botaoCancelar) {
        botaoCancelar.addEventListener('click', async () => {
          const msg = m.status === 'pendente'
            ? `Cancelar a pré-matrícula pendente de "${aluno.nome}" no plano "${m.plano_nome}" (aguardando 1º pagamento no totem)?`
            : `Cancelar a matrícula de "${aluno.nome}" no plano "${m.plano_nome}"? Isso interrompe a geração automática das próximas mensalidades.`;
          if (!confirmar(msg)) return;
          try {
            await api(`/api/planos/matriculas/${m.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelada' }) });
            mostrarToast('Matrícula cancelada.');
            carregarPerfilAluno();
          } catch (err) { mostrarToast(err.message, true); }
        });
      }
      tbodyMatriculas.appendChild(tr);
    });

    await popularSelectPlanosDoPerfil();
    if (!document.getElementById('perfil-matricula-data').value) {
      document.getElementById('perfil-matricula-data').value = hojeLocalISO();
    }

    document.getElementById('perfil-lista-agendamentos').innerHTML = agendamentos.length
      ? agendamentos.map((a) => `
        <tr>
          <td>${a.data_aula}</td>
          <td>${a.turma_nome}</td>
          <td><span class="badge ${a.status}">${a.status}</span></td>
        </tr>`).join('')
      : '<tr><td colspan="3">Nenhum agendamento.</td></tr>';

    // A aba Financeiro usa carregarFinanceiroPerfil() (endpoint com valor pago/ações),
    // não o array "cobrancas" simplificado que já vem no /perfil — evita ficarem dessincronizados.
    await carregarFinanceiroPerfil();

    inicializarAbaTreino(aluno.treino_modo || 'nativo');
  } catch (err) {
    mostrarToast(err.message, true);
  }
}

// ---------------- Aba Treino do perfil ----------------

const DIAS_SEMANA_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
let treinosCache = [];
let treinoAtivoId = null;

function inicializarAbaTreino(modoAtual) {
  document.getElementById(modoAtual === 'app_externo' ? 'treino-modo-externo' : 'treino-modo-nativo').checked = true;
  atualizarPainelModoTreino(modoAtual);
  if (modoAtual === 'nativo') {
    carregarTreinosPerfil();
  } else {
    atualizarLinkTreinoExterno();
  }
}

function atualizarPainelModoTreino(modo) {
  document.getElementById('treino-painel-nativo').classList.toggle('oculto', modo !== 'nativo');
  document.getElementById('treino-painel-externo').classList.toggle('oculto', modo !== 'app_externo');
}

document.querySelectorAll('input[name="treino-modo"]').forEach((radio) => {
  radio.addEventListener('change', async (ev) => {
    const modo = ev.target.value;
    atualizarPainelModoTreino(modo);
    try {
      const respModo = await api(`/api/alunos/${perfilAtualId}`, { method: 'PUT', body: JSON.stringify({ treino_modo: modo }) });
      if (respModo && respModo.enfileirado) mostrarToast(respModo.aviso);
      if (modo === 'nativo') carregarTreinosPerfil(); else atualizarLinkTreinoExterno();
    } catch (err) { mostrarToast(err.message, true); }
  });
});

async function atualizarLinkTreinoExterno() {
  try {
    const config = await api('/api/config');
    const link = document.getElementById('link-treino-app-externo');
    const aviso = document.getElementById('aviso-sem-link-app');
    if (config.treino_app_url) {
      link.href = config.treino_app_url;
      link.classList.remove('oculto');
      aviso.classList.add('oculto');
    } else {
      link.classList.add('oculto');
      aviso.classList.remove('oculto');
    }
  } catch (err) { /* silencioso — não é crítico pra tela abrir */ }
}

async function carregarTreinosPerfil() {
  try {
    treinosCache = await api(`/api/treinos?aluno_id=${perfilAtualId}`);
    renderizarAbasTreino();
  } catch (err) { mostrarToast(err.message, true); }
}

function renderizarAbasTreino() {
  const caixa = document.getElementById('treino-abas');
  caixa.innerHTML = '';
  if (!treinosCache.length) {
    document.getElementById('treino-sem-treinos').classList.remove('oculto');
    document.getElementById('treino-conteudo-ativo').classList.add('oculto');
    treinoAtivoId = null;
    return;
  }
  document.getElementById('treino-sem-treinos').classList.add('oculto');

  if (!treinoAtivoId || !treinosCache.some((t) => t.id === treinoAtivoId)) {
    treinoAtivoId = treinosCache[0].id;
  }

  treinosCache.forEach((t) => {
    const btn = el(`<button type="button" class="btn-linha ${t.id === treinoAtivoId ? 'btn-primario' : ''}">${t.nome}</button>`);
    btn.addEventListener('click', () => { treinoAtivoId = t.id; renderizarAbasTreino(); });
    caixa.appendChild(btn);
  });

  renderizarTreinoAtivo();
}

function renderizarTreinoAtivo() {
  const treino = treinosCache.find((t) => t.id === treinoAtivoId);
  document.getElementById('treino-conteudo-ativo').classList.toggle('oculto', !treino);
  if (!treino) return;

  document.getElementById('treino-nome-ativo').textContent = treino.nome;

  const diasBox = document.getElementById('treino-dias-semana');
  diasBox.innerHTML = '';
  DIAS_SEMANA_LABELS.forEach((label, idx) => {
    const marcado = treino.dias_semana.includes(idx);
    const wrapper = el(`
      <label style="display:flex;align-items:center;gap:4px;font-size:13px">
        <input type="checkbox" style="width:auto" ${marcado ? 'checked' : ''} /> ${label}
      </label>
    `);
    wrapper.querySelector('input').addEventListener('change', async (ev) => {
      const dias = new Set(treino.dias_semana);
      if (ev.target.checked) dias.add(idx); else dias.delete(idx);
      treino.dias_semana = [...dias].sort();
      try {
        await api(`/api/treinos/${treino.id}`, { method: 'PUT', body: JSON.stringify({ dias_semana: treino.dias_semana }) });
      } catch (err) { mostrarToast(err.message, true); }
    });
    diasBox.appendChild(wrapper);
  });

  const tbody = document.getElementById('treino-lista-exercicios');
  tbody.innerHTML = treino.exercicios.length ? '' : '<tr><td colspan="6">Nenhum exercício cadastrado ainda.</td></tr>';
  treino.exercicios.forEach((ex) => {
    const tr = el(`
      <tr>
        <td>${ex.exercicio}</td>
        <td>${ex.series || '—'}</td>
        <td>${ex.carga || '—'}</td>
        <td>${ex.intervalo || '—'}</td>
        <td>${ex.observacao || '—'}</td>
        <td>
          <button type="button" class="btn-linha" data-acao="editar">Editar</button>
          <button type="button" class="btn-linha perigo" data-acao="excluir">Excluir</button>
        </td>
      </tr>
    `);
    tr.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirFormExercicio(ex));
    tr.querySelector('[data-acao="excluir"]').addEventListener('click', async () => {
      if (!confirmar('Excluir este exercício?')) return;
      try {
        await api(`/api/treinos/exercicios/${ex.id}`, { method: 'DELETE' });
        mostrarToast('Exercício excluído.');
        carregarTreinosPerfil();
      } catch (err) { mostrarToast(err.message, true); }
    });
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-novo-treino').addEventListener('click', async () => {
  const nome = prompt('Nome do treino (ex: Treino A):', `Treino ${String.fromCharCode(65 + treinosCache.length)}`);
  if (!nome || !nome.trim()) return;
  try {
    const novo = await api('/api/treinos', {
      method: 'POST',
      body: JSON.stringify({ aluno_id: perfilAtualId, nome: nome.trim(), dias_semana: [] }),
    });
    treinoAtivoId = novo.id;
    await carregarTreinosPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-renomear-treino').addEventListener('click', async () => {
  const treino = treinosCache.find((t) => t.id === treinoAtivoId);
  if (!treino) return;
  const novoNome = prompt('Novo nome do treino:', treino.nome);
  if (!novoNome || !novoNome.trim()) return;
  try {
    await api(`/api/treinos/${treino.id}`, { method: 'PUT', body: JSON.stringify({ nome: novoNome.trim() }) });
    await carregarTreinosPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-excluir-treino').addEventListener('click', async () => {
  const treino = treinosCache.find((t) => t.id === treinoAtivoId);
  if (!treino) return;
  if (!confirmar(`Excluir o treino "${treino.nome}" e todos os exercícios dele?`)) return;
  try {
    await api(`/api/treinos/${treino.id}`, { method: 'DELETE' });
    treinoAtivoId = null;
    await carregarTreinosPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

function abrirFormExercicio(exercicio) {
  document.getElementById('exercicio-id').value = exercicio?.id || '';
  document.getElementById('exercicio-nome').value = exercicio?.exercicio || '';
  document.getElementById('exercicio-series').value = exercicio?.series || '';
  document.getElementById('exercicio-carga').value = exercicio?.carga || '';
  document.getElementById('exercicio-intervalo').value = exercicio?.intervalo || '';
  document.getElementById('exercicio-observacao').value = exercicio?.observacao || '';
  document.getElementById('form-exercicio').classList.remove('oculto');
}

document.getElementById('btn-toggle-exercicio').addEventListener('click', () => abrirFormExercicio(null));
document.getElementById('btn-cancelar-exercicio').addEventListener('click', () => {
  document.getElementById('form-exercicio').classList.add('oculto');
});

document.getElementById('form-exercicio').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = document.getElementById('exercicio-id').value;
  const dados = {
    exercicio: document.getElementById('exercicio-nome').value.trim(),
    series: document.getElementById('exercicio-series').value.trim() || null,
    carga: document.getElementById('exercicio-carga').value.trim() || null,
    intervalo: document.getElementById('exercicio-intervalo').value.trim() || null,
    observacao: document.getElementById('exercicio-observacao').value.trim() || null,
  };
  try {
    if (id) {
      await api(`/api/treinos/exercicios/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
    } else {
      await api(`/api/treinos/${treinoAtivoId}/exercicios`, { method: 'POST', body: JSON.stringify(dados) });
    }
    mostrarToast('Exercício salvo.');
    document.getElementById('form-exercicio').classList.add('oculto');
    await carregarTreinosPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- Aba Financeiro do perfil (espelha Contas a Receber, filtrado no aluno) ----------------

async function carregarFinanceiroPerfil() {
  const alunoId = document.getElementById('perfil-aluno-id').value;
  const tbody = document.getElementById('perfil-lista-cobrancas');
  if (!alunoId) { tbody.innerHTML = ''; return; }
  try {
    const contas = await api(`/api/pagamentos/cobrancas?aluno_id=${alunoId}`);
    tbody.innerHTML = contas.length ? '' : '<tr><td colspan="7">Nenhuma conta encontrada.</td></tr>';
    contas.forEach((c) => {
      const valorPago = Number(c.valor_pago_centavos || 0) || (c.status === 'pago' ? c.valor_centavos : 0);
      const dataPago = c.data_pago_calc || (c.status === 'pago' ? c.pago_em : null);
      const tr = el(`
        <tr>
          <td>${c.descricao || '—'}</td>
          <td>${formatarMoeda(c.valor_centavos)}</td>
          <td>${c.vencimento || '—'}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
          <td>${formatarDataOuDataHora(dataPago)}</td>
          <td>${valorPago > 0 ? formatarMoeda(valorPago) : '—'}</td>
          <td>
            <button class="btn-linha" data-acao="editar">Alterar</button>
            <button class="btn-linha" data-acao="parcelar">Parcelar</button>
            <button class="btn-linha perigo" data-acao="excluir">Excluir</button>
          </td>
        </tr>
      `);
      tr.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirModalConta(c));
      tr.querySelector('[data-acao="parcelar"]').addEventListener('click', () => abrirModalParcelamento({ modo: 'existente', conta: c }));
      tr.querySelector('[data-acao="excluir"]').addEventListener('click', async () => {
        if (!confirmar('Excluir esta conta a receber?')) return;
        try {
          await api(`/api/pagamentos/cobrancas/${c.id}`, { method: 'DELETE' });
          mostrarToast('Conta excluída.');
          carregarFinanceiroPerfil();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('btn-toggle-conta-perfil').addEventListener('click', () => {
  document.getElementById('form-conta-perfil').classList.toggle('oculto');
  popularSelectPlanoParaConta(document.getElementById('conta-perfil-plano'));
});
document.getElementById('btn-cancelar-conta-perfil').addEventListener('click', () => {
  document.getElementById('form-conta-perfil').classList.add('oculto');
});

document.getElementById('form-conta-perfil').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    aluno_id: perfilAtualId,
    descricao: document.getElementById('conta-perfil-descricao').value.trim() || 'Mensalidade',
    valor_centavos: Math.round(parseFloat(document.getElementById('conta-perfil-valor').value) * 100),
    vencimento: document.getElementById('conta-perfil-vencimento').value || null,
    status: document.getElementById('conta-perfil-status').value,
  };
  try {
    await api('/api/pagamentos/cobrancas', { method: 'POST', body: JSON.stringify(dados) });
    mostrarToast('Conta cadastrada.');
    ev.target.reset();
    document.getElementById('conta-perfil-descricao').value = 'Mensalidade';
    document.getElementById('form-conta-perfil').classList.add('oculto');
    carregarFinanceiroPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-nova-conta-parcelada-perfil').addEventListener('click', () => {
  abrirModalParcelamento({ modo: 'novo', alunoIdPreselect: perfilAtualId });
});

document.getElementById('form-perfil-dados').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    nome: document.getElementById('perfil-nome').value.trim(),
    email: document.getElementById('perfil-email').value.trim() || null,
    telefone: document.getElementById('perfil-telefone').value.trim() || null,
    cpf: document.getElementById('perfil-cpf').value.trim() || null,
    data_nascimento: document.getElementById('perfil-nascimento').value || null,
    observacoes: document.getElementById('perfil-observacoes').value.trim() || null,
  };
  try {
    const respDados = await api(`/api/alunos/${perfilAtualId}`, { method: 'PUT', body: JSON.stringify(dados) });
    if (rascunhoNovoAlunoId === perfilAtualId) rascunhoNovoAlunoId = null; // confirmado: não é mais rascunho
    avisarSincronizacaoOuSucesso(respDados, 'Dados do aluno atualizados.');
    document.getElementById('perfil-nome-aluno').textContent = `Perfil de ${dados.nome}`;
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-excluir-aluno').addEventListener('click', async () => {
  const nome = document.getElementById('perfil-nome').value;
  if (!confirmar(`Excluir o aluno "${nome}"? Isso também remove matrículas, agendamentos e cobranças dele. Esta ação não pode ser desfeita.`)) return;
  try {
    await api(`/api/alunos/${perfilAtualId}`, { method: 'DELETE' });
    mostrarToast('Aluno excluído.');
    voltarParaAlunos();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('form-biometria').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const biometriaId = document.getElementById('perfil-biometria-id').value.trim();
  if (!biometriaId) return mostrarToast('Informe o ID biométrico retornado pelo leitor.', true);
  try {
    await api(`/api/alunos/${perfilAtualId}/biometria`, { method: 'PATCH', body: JSON.stringify({ biometria_id: biometriaId }) });
    mostrarToast('ID biométrico salvo.');
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-remover-biometria').addEventListener('click', async () => {
  try {
    await api(`/api/alunos/${perfilAtualId}/biometria`, { method: 'DELETE' });
    document.getElementById('perfil-biometria-id').value = '';
    mostrarToast('Cadastro biométrico removido.');
  } catch (err) { mostrarToast(err.message, true); }
});

// "Capturar pela catraca": pede pro agente local aguardar a próxima leitura de
// digital na catraca (só funciona se BIOMETRIA_CATRACA_ATIVA=true no agente-local
// e ele estiver conectado) e preenche o campo com o id lido — não salva sozinho,
// o admin ainda confirma clicando em "Salvar ID biométrico" depois de conferir.
document.getElementById('btn-capturar-biometria-catraca').addEventListener('click', async () => {
  const btn = document.getElementById('btn-capturar-biometria-catraca');
  const status = document.getElementById('status-captura-biometria');
  btn.disabled = true;
  status.textContent = 'Aguardando leitura... peça pro aluno tocar o dedo no leitor da catraca agora (até 25s).';
  try {
    const resultado = await api('/api/alunos/biometria/capturar-catraca', { method: 'POST', body: JSON.stringify({}) });
    document.getElementById('perfil-biometria-id').value = resultado.biometria_id;
    status.textContent = `Leitura capturada: ${resultado.biometria_id}. Confira e clique em "Salvar ID biométrico".`;
  } catch (err) {
    status.textContent = '';
    mostrarToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

async function copiarParaClipboard(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    mostrarToast('Link copiado para a área de transferência.');
  } catch {
    mostrarToast('Link gerado (copie manualmente do campo).');
  }
}

document.getElementById('btn-gerar-link-acesso').addEventListener('click', async () => {
  try {
    const resp = await api(`/api/alunos/${perfilAtualId}/codigo-acesso`, { method: 'PATCH' });
    const link = `${window.location.origin}/meu-acesso.html?codigo=${resp.codigo_acesso}`;
    document.getElementById('perfil-link-acesso').value = link;
    await copiarParaClipboard(link);
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-regenerar-link-acesso').addEventListener('click', async () => {
  if (!confirmar('Gerar um novo link invalida o QR/link antigo do aluno. Continuar?')) return;
  try {
    const resp = await api(`/api/alunos/${perfilAtualId}/codigo-acesso?regenerar=1`, { method: 'PATCH' });
    const link = `${window.location.origin}/meu-acesso.html?codigo=${resp.codigo_acesso}`;
    document.getElementById('perfil-link-acesso').value = link;
    await copiarParaClipboard(link);
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-remover-face').addEventListener('click', async () => {
  if (!confirmar('Remover o reconhecimento facial cadastrado deste aluno?')) return;
  try {
    await api(`/api/alunos/${perfilAtualId}/face`, { method: 'DELETE' });
    mostrarToast('Reconhecimento facial removido.');
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- Cadastro facial direto pelo painel (câmera do PC) ----------------

const FACE_MODELS_URL_PERFIL = 'vendor/face-api/weights';
let faceModelsCarregados = false;
let streamCameraPerfil = null;

async function garantirModelosFaciais() {
  if (faceModelsCarregados) return;
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL_PERFIL),
    faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL_PERFIL),
    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL_PERFIL),
  ]);
  faceModelsCarregados = true;
}

function pararCameraPerfil() {
  if (streamCameraPerfil) {
    streamCameraPerfil.getTracks().forEach((t) => t.stop());
    streamCameraPerfil = null;
  }
  const video = document.getElementById('video-facial-perfil');
  video.style.display = 'none';
  video.srcObject = null;
  document.getElementById('btn-abrir-camera-perfil').classList.remove('oculto');
  document.getElementById('btn-capturar-facial-perfil').classList.add('oculto');
  document.getElementById('btn-cancelar-camera-perfil').classList.add('oculto');
  document.getElementById('status-facial-perfil').textContent = '';
}

document.getElementById('btn-abrir-camera-perfil').addEventListener('click', async () => {
  const status = document.getElementById('status-facial-perfil');
  try {
    status.textContent = 'Carregando modelos e abrindo câmera...';
    await garantirModelosFaciais();
    streamCameraPerfil = await navigator.mediaDevices.getUserMedia({ video: {} });
    const video = document.getElementById('video-facial-perfil');
    video.srcObject = streamCameraPerfil;
    video.style.display = 'block';
    document.getElementById('btn-abrir-camera-perfil').classList.add('oculto');
    document.getElementById('btn-capturar-facial-perfil').classList.remove('oculto');
    document.getElementById('btn-cancelar-camera-perfil').classList.remove('oculto');
    status.textContent = 'Posicione o rosto do aluno no centro e clique em "Capturar rosto".';
  } catch (err) {
    status.textContent = `Não foi possível abrir a câmera: ${err.message}`;
  }
});

document.getElementById('btn-cancelar-camera-perfil').addEventListener('click', pararCameraPerfil);

document.getElementById('btn-capturar-facial-perfil').addEventListener('click', async () => {
  const status = document.getElementById('status-facial-perfil');
  const video = document.getElementById('video-facial-perfil');
  try {
    status.textContent = 'Analisando rosto...';
    const deteccao = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!deteccao) {
      status.textContent = 'Nenhum rosto detectado. Ajuste a posição/iluminação e tente novamente.';
      return;
    }

    await api(`/api/alunos/${perfilAtualId}/face`, {
      method: 'PUT',
      body: JSON.stringify({ descriptor: Array.from(deteccao.descriptor) }),
    });
    mostrarToast('Rosto cadastrado com sucesso.');
    pararCameraPerfil();
  } catch (err) {
    status.textContent = `Erro ao cadastrar rosto: ${err.message}`;
  }
});

document.getElementById('form-anamnese').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    peso_kg: document.getElementById('anamnese-peso').value ? Number(document.getElementById('anamnese-peso').value) : null,
    altura_cm: document.getElementById('anamnese-altura').value ? Number(document.getElementById('anamnese-altura').value) : null,
    historico_saude: document.getElementById('anamnese-historico').value.trim() || null,
    restricoes: document.getElementById('anamnese-restricoes').value.trim() || null,
    observacoes_medicas: document.getElementById('anamnese-observacoes').value.trim() || null,
  };
  try {
    await api(`/api/alunos/${perfilAtualId}/anamnese`, { method: 'PUT', body: JSON.stringify(dados) });
    mostrarToast('Anamnese salva.');
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('form-avaliacao').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const numOuNull = (id) => (document.getElementById(id).value ? Number(document.getElementById(id).value) : null);
  const dados = {
    data_avaliacao: document.getElementById('avaliacao-data').value,
    peso_kg: numOuNull('avaliacao-peso'),
    altura_cm: numOuNull('avaliacao-altura'),
    percentual_gordura: numOuNull('avaliacao-gordura'),
    medida_cintura_cm: numOuNull('avaliacao-cintura'),
    medida_quadril_cm: numOuNull('avaliacao-quadril'),
    medida_peito_cm: numOuNull('avaliacao-peito'),
    medida_braco_cm: numOuNull('avaliacao-braco'),
    medida_coxa_cm: numOuNull('avaliacao-coxa'),
    objetivo: document.getElementById('avaliacao-objetivo').value.trim() || null,
    observacoes: document.getElementById('avaliacao-observacoes').value.trim() || null,
  };
  try {
    await api(`/api/alunos/${perfilAtualId}/avaliacoes`, { method: 'POST', body: JSON.stringify(dados) });
    mostrarToast('Avaliação registrada.');
    ev.target.reset();
    carregarPerfilAluno();
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- PLANOS ----------------

async function carregarPlanos() {
  try {
    const todos = document.getElementById('chk-planos-todos').checked;
    const planos = await api(`/api/planos${todos ? '?todos=1' : ''}`);
    const tbody = document.getElementById('lista-planos');
    tbody.innerHTML = '';
    planos.forEach((plano) => {
      const tr = el(`
        <tr>
          <td>${plano.nome}</td>
          <td>${plano.tipo}</td>
          <td>${formatarMoeda(plano.valor_centavos)}</td>
          <td>${plano.duracao_dias ? plano.duracao_dias + ' dias' : '—'}</td>
          <td>${formatarDescontoPlano(plano)}</td>
          <td><span class="badge ${plano.ativo ? 'ativo' : 'inativo'}">${plano.ativo ? 'ativo' : 'desativado'}</span></td>
          <td>
            <button class="btn-linha" data-acao="editar">Editar</button>
            <button class="btn-linha" data-acao="alternar">${plano.ativo ? 'Desativar' : 'Reativar'}</button>
            <button class="btn-linha perigo" data-acao="excluir">Excluir</button>
          </td>
        </tr>
      `);
      tr.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirFormPlano(plano));
      tr.querySelector('[data-acao="alternar"]').addEventListener('click', async () => {
        try {
          await api(`/api/planos/${plano.id}/${plano.ativo ? 'desativar' : 'reativar'}`, { method: 'PATCH' });
          mostrarToast(plano.ativo ? 'Plano desativado.' : 'Plano reativado.');
          carregarPlanos();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tr.querySelector('[data-acao="excluir"]').addEventListener('click', async () => {
        if (!confirmar(`Excluir o plano "${plano.nome}" definitivamente?`)) return;
        try {
          await api(`/api/planos/${plano.id}`, { method: 'DELETE' });
          mostrarToast('Plano excluído.');
          carregarPlanos();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });

    await popularSelectAlunos(document.getElementById('matricula-aluno'));
    popularSelectPlanos(document.getElementById('matricula-plano'), planos.filter((p) => p.ativo));
    await carregarMatriculas();
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('chk-planos-todos').addEventListener('change', carregarPlanos);

const ROTULOS_FORMA_PAGAMENTO_PLANO = {
  dinheiro: 'dinheiro', pix: 'Pix', cartao_credito: 'cartão de crédito', cartao_debito: 'cartão de débito',
  transferencia: 'transferência', boleto: 'boleto', outro: 'outra forma',
};

function formatarDescontoPlano(plano) {
  if (!plano.desconto_tipo) return '—';
  const forma = ROTULOS_FORMA_PAGAMENTO_PLANO[plano.desconto_forma_pagamento] || plano.desconto_forma_pagamento || '—';
  const valor = plano.desconto_tipo === 'percentual'
    ? `${plano.desconto_percentual}%`
    : formatarMoeda(plano.desconto_valor_centavos);
  return `${valor} (${forma})`;
}

function abrirFormPlano(plano = null) {
  const form = document.getElementById('form-plano');
  form.classList.remove('oculto');
  form.querySelector('h3').textContent = plano ? 'Editar plano' : 'Novo plano';
  document.getElementById('plano-id').value = plano?.id || '';
  document.getElementById('plano-nome').value = plano?.nome || '';
  document.getElementById('plano-tipo').value = plano?.tipo || 'mensal';
  document.getElementById('plano-valor').value = plano ? (plano.valor_centavos / 100).toFixed(2) : '';
  document.getElementById('plano-duracao').value = plano?.duracao_dias || '';

  const temDesconto = Boolean(plano?.desconto_tipo);
  document.getElementById('plano-tem-desconto').checked = temDesconto;
  document.getElementById('plano-bloco-desconto').classList.toggle('oculto', !temDesconto);
  document.getElementById('plano-desconto-forma').value = plano?.desconto_forma_pagamento || 'dinheiro';
  document.getElementById('plano-desconto-tipo').value = plano?.desconto_tipo || 'percentual';
  document.getElementById('plano-desconto-valor').value = temDesconto
    ? (plano.desconto_tipo === 'percentual' ? plano.desconto_percentual : (plano.desconto_valor_centavos / 100).toFixed(2))
    : '';
  atualizarLabelDescontoPlano();

  form.scrollIntoView({ behavior: 'smooth' });
}

function atualizarLabelDescontoPlano() {
  const tipo = document.getElementById('plano-desconto-tipo').value;
  document.getElementById('label-plano-desconto-valor').textContent = tipo === 'percentual' ? 'Desconto (%)' : 'Desconto (R$)';
}

document.getElementById('plano-tem-desconto').addEventListener('change', (ev) => {
  document.getElementById('plano-bloco-desconto').classList.toggle('oculto', !ev.target.checked);
});
document.getElementById('plano-desconto-tipo').addEventListener('change', atualizarLabelDescontoPlano);

function popularSelectPlanos(select, planos) {
  select.innerHTML = planos.map((p) => `<option value="${p.id}">${p.nome} (${formatarMoeda(p.valor_centavos)})</option>`).join('');
}

// ---------------- Selecionar um plano existente ao incluir conta manual ----------------
// Em vez de digitar a descrição/valor de cabeça, o admin pode escolher um dos
// planos cadastrados (ex: "Musculação") e a descrição/valor já vêm preenchidos
// — "Personalizado" continua disponível pra contas avulsas sem plano.

async function popularSelectPlanoParaConta(select) {
  try {
    const planos = await api('/api/planos');
    select.innerHTML = '<option value="">Personalizado (digitar descrição/valor)</option>'
      + planos.map((p) => `<option value="${p.id}" data-nome="${p.nome}" data-valor="${p.valor_centavos}">${p.nome} (${formatarMoeda(p.valor_centavos)})</option>`).join('');
  } catch (err) { mostrarToast(err.message, true); }
}

function aplicarPlanoNaConta(select, descricaoInput, valorInput) {
  const opt = select.selectedOptions[0];
  if (!select.value || !opt) return; // "Personalizado" — não mexe no que já foi digitado
  descricaoInput.value = `Mensalidade - ${opt.dataset.nome}`;
  valorInput.value = (Number(opt.dataset.valor) / 100).toFixed(2);
}

document.getElementById('conta-plano').addEventListener('change', (ev) => {
  aplicarPlanoNaConta(ev.target, document.getElementById('conta-descricao'), document.getElementById('conta-valor'));
});
document.getElementById('conta-perfil-plano').addEventListener('change', (ev) => {
  aplicarPlanoNaConta(ev.target, document.getElementById('conta-perfil-descricao'), document.getElementById('conta-perfil-valor'));
});

// ---------------- Matricular em um plano direto pela aba Matrículas do perfil ----------------

async function popularSelectPlanosDoPerfil() {
  try {
    const planos = await api('/api/planos');
    popularSelectPlanos(document.getElementById('perfil-matricula-plano'), planos);
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('btn-toggle-matricula-perfil').addEventListener('click', () => {
  document.getElementById('form-matricula-perfil').classList.toggle('oculto');
});

document.getElementById('btn-ir-matricular-perfil').addEventListener('click', () => {
  trocarAbaPerfil('matriculas');
  document.getElementById('form-matricula-perfil').classList.remove('oculto');
  document.getElementById('form-matricula-perfil').scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('form-matricula-perfil').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const planoId = document.getElementById('perfil-matricula-plano').value;
  const dataInicio = document.getElementById('perfil-matricula-data').value;
  if (!planoId) { mostrarToast('Selecione um plano.', true); return; }
  try {
    await api('/api/planos/matricular', {
      method: 'POST',
      body: JSON.stringify({
        aluno_id: perfilAtualId,
        plano_id: planoId,
        data_inicio: dataInicio || hojeLocalISO(),
      }),
    });
    mostrarToast('Aluno matriculado. Primeira cobrança gerada em Contas a Receber.');
    document.getElementById('form-matricula-perfil').classList.add('oculto');
    await carregarPerfilAluno();
    if (typeof carregarFinanceiroPerfil === 'function') carregarFinanceiroPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

async function popularSelectAlunos(select, { incluirInativos = false, comPlaceholder = false } = {}) {
  try {
    const query = incluirInativos ? '?incluir_inativos=true' : '?status=ativo';
    const alunos = await api(`/api/alunos${query}`);
    const placeholder = comPlaceholder ? '<option value="">Selecione...</option>' : '';
    select.innerHTML = placeholder + alunos.map((a) => `<option value="${a.id}">${a.nome}</option>`).join('');
  } catch (err) { mostrarToast(err.message, true); }
}

async function carregarMatriculas() {
  try {
    const matriculas = await api('/api/planos/matriculas');
    const tbody = document.getElementById('lista-matriculas');
    tbody.innerHTML = '';
    matriculas.forEach((m) => {
      const tr = el(`
        <tr>
          <td><span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${m.aluno_nome}</span></td>
          <td>${m.plano_nome}</td>
          <td>${m.data_inicio}</td>
          <td>${m.data_fim || '—'}</td>
          <td><span class="badge ${m.status}">${m.status}</span></td>
          <td>${(m.status === 'ativa' || m.status === 'pendente') ? '<button class="btn-linha perigo" data-acao="cancelar">Cancelar</button>' : '—'}</td>
        </tr>
      `);
      tr.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(m.aluno_id));
      const botaoCancelar = tr.querySelector('[data-acao="cancelar"]');
      if (botaoCancelar) {
        botaoCancelar.addEventListener('click', async () => {
          const msg = m.status === 'pendente'
            ? `Cancelar a pré-matrícula pendente de "${m.aluno_nome}" no plano "${m.plano_nome}" (aguardando 1º pagamento no totem)?`
            : `Cancelar a matrícula de "${m.aluno_nome}" no plano "${m.plano_nome}"? Isso interrompe a geração automática das próximas mensalidades.`;
          if (!confirmar(msg)) return;
          try {
            await api(`/api/planos/matriculas/${m.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelada' }) });
            mostrarToast('Matrícula cancelada.');
            carregarMatriculas();
          } catch (err) { mostrarToast(err.message, true); }
        });
      }
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('btn-novo-plano').addEventListener('click', () => abrirFormPlano());
document.getElementById('btn-cancelar-plano').addEventListener('click', () => {
  document.getElementById('form-plano').classList.add('oculto');
});

document.getElementById('form-plano').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = document.getElementById('plano-id').value;
  const temDesconto = document.getElementById('plano-tem-desconto').checked;
  const tipoDesconto = document.getElementById('plano-desconto-tipo').value;
  const valorDesconto = parseFloat(document.getElementById('plano-desconto-valor').value);
  const dados = {
    nome: document.getElementById('plano-nome').value.trim(),
    tipo: document.getElementById('plano-tipo').value,
    valor_centavos: Math.round(parseFloat(document.getElementById('plano-valor').value) * 100),
    duracao_dias: document.getElementById('plano-duracao').value ? Number(document.getElementById('plano-duracao').value) : null,
    desconto_tipo: temDesconto ? tipoDesconto : null,
    desconto_forma_pagamento: temDesconto ? document.getElementById('plano-desconto-forma').value : null,
    desconto_percentual: temDesconto && tipoDesconto === 'percentual' && !isNaN(valorDesconto) ? valorDesconto : null,
    desconto_valor_centavos: temDesconto && tipoDesconto === 'valor' && !isNaN(valorDesconto) ? Math.round(valorDesconto * 100) : null,
  };
  try {
    if (id) {
      await api(`/api/planos/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      mostrarToast('Plano atualizado.');
    } else {
      await api('/api/planos', { method: 'POST', body: JSON.stringify(dados) });
      mostrarToast('Plano criado.');
    }
    document.getElementById('form-plano').classList.add('oculto');
    ev.target.reset();
    document.getElementById('plano-bloco-desconto').classList.add('oculto');
    carregarPlanos();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('form-matricula').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const botao = ev.target.querySelector('button[type="submit"]');
  const dados = {
    aluno_id: document.getElementById('matricula-aluno').value,
    plano_id: document.getElementById('matricula-plano').value,
    data_inicio: document.getElementById('matricula-data').value,
  };
  botao.disabled = true; // evita matrícula duplicada por duplo clique
  try {
    await api('/api/planos/matricular', { method: 'POST', body: JSON.stringify(dados) });
    mostrarToast('Aluno matriculado. Primeira cobrança já foi gerada em Contas a Receber.');
    carregarMatriculas();
  } catch (err) {
    mostrarToast(err.message, true);
  } finally {
    botao.disabled = false;
  }
});

// ---------------- TURMAS & AGENDA ----------------

async function carregarAgenda() {
  await carregarTurmas();
  await carregarAgendamentos();
  await popularSelectAlunos(document.getElementById('agendamento-aluno'));
  await popularSelectAlunos(document.getElementById('cobranca-aluno'));
}

const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

async function carregarTurmas() {
  try {
    const turmas = await api('/api/agendamentos/turmas');
    const tbody = document.getElementById('lista-turmas');
    tbody.innerHTML = turmas.map((t) => `
      <tr>
        <td>${t.nome}</td>
        <td>${t.modalidade || '—'}</td>
        <td>${DIAS_SEMANA[t.dia_semana]}</td>
        <td>${t.horario_inicio} - ${t.horario_fim}</td>
        <td>${t.capacidade_maxima}</td>
      </tr>
    `).join('');

    const selectTurma = document.getElementById('agendamento-turma');
    selectTurma.innerHTML = turmas.map((t) => `<option value="${t.id}">${t.nome} (${DIAS_SEMANA[t.dia_semana]} ${t.horario_inicio})</option>`).join('');
  } catch (err) { mostrarToast(err.message, true); }
}

async function carregarAgendamentos() {
  try {
    const agendamentos = await api('/api/agendamentos');
    const tbody = document.getElementById('lista-agendamentos');
    tbody.innerHTML = '';
    agendamentos.forEach((a) => {
      const tr = el(`
        <tr>
          <td>${a.data_aula}</td>
          <td>${a.turma_nome}</td>
          <td><span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${a.aluno_nome}</span></td>
          <td><span class="badge ${a.status}">${a.status}</span></td>
          <td>
            <button class="btn-linha" data-acao="checkin">Check-in</button>
            <button class="btn-linha perigo" data-acao="cancelar">Cancelar</button>
          </td>
        </tr>
      `);
      tr.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(a.aluno_id));
      tr.querySelector('[data-acao="checkin"]').addEventListener('click', async () => {
        try {
          await api('/api/agendamentos/checkin', {
            method: 'POST',
            body: JSON.stringify({ aluno_id: a.aluno_id, agendamento_id: a.id, metodo: 'manual' }),
          });
          mostrarToast('Check-in registrado.');
          carregarAgendamentos();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tr.querySelector('[data-acao="cancelar"]').addEventListener('click', async () => {
        try {
          await api(`/api/agendamentos/${a.id}/cancelar`, { method: 'PATCH' });
          mostrarToast('Agendamento cancelado.');
          carregarAgendamentos();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('btn-nova-turma').addEventListener('click', () => {
  document.getElementById('form-turma').classList.remove('oculto');
});
document.getElementById('btn-cancelar-turma').addEventListener('click', () => {
  document.getElementById('form-turma').classList.add('oculto');
});

document.getElementById('form-turma').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    nome: document.getElementById('turma-nome').value.trim(),
    modalidade: document.getElementById('turma-modalidade').value.trim() || null,
    dia_semana: Number(document.getElementById('turma-dia').value),
    capacidade_maxima: Number(document.getElementById('turma-capacidade').value) || 20,
    horario_inicio: document.getElementById('turma-inicio').value,
    horario_fim: document.getElementById('turma-fim').value,
  };
  try {
    await api('/api/agendamentos/turmas', { method: 'POST', body: JSON.stringify(dados) });
    mostrarToast('Turma criada.');
    document.getElementById('form-turma').classList.add('oculto');
    ev.target.reset();
    carregarTurmas();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('form-agendamento').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    aluno_id: document.getElementById('agendamento-aluno').value,
    turma_id: document.getElementById('agendamento-turma').value,
    data_aula: document.getElementById('agendamento-data').value,
  };
  try {
    await api('/api/agendamentos', { method: 'POST', body: JSON.stringify(dados) });
    mostrarToast('Aula agendada.');
    carregarAgendamentos();
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- CONTAS A RECEBER (PAGAMENTOS) ----------------

// Período de "Contas a receber" fica lembrado (localStorage) até o usuário trocar por
// outro — a tela nunca lista tudo sem limite nenhum. Sem período salvo ainda, cai no
// mês corrente (do dia 1 ao último dia do mês).
function inicializarPeriodoContas() {
  const campoDe = document.getElementById('conta-periodo-de');
  const campoAte = document.getElementById('conta-periodo-ate');
  const seletorCampoData = document.getElementById('conta-filtro-data-campo');
  const salvoCampoData = localStorage.getItem('contaFiltroDataCampo');
  if (salvoCampoData === 'pagamento' || salvoCampoData === 'vencimento') seletorCampoData.value = salvoCampoData;
  atualizarLabelPeriodoContas();
  if (campoDe.value || campoAte.value) return; // já tem valor (ex.: veio de uma troca recente), não sobrescreve

  const salvoDe = localStorage.getItem('contaPeriodoDe');
  const salvoAte = localStorage.getItem('contaPeriodoAte');
  if (salvoDe || salvoAte) {
    campoDe.value = salvoDe || '';
    campoAte.value = salvoAte || '';
    return;
  }

  const hoje = new Date();
  const primeiroDia = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
  campoDe.value = primeiroDia.toISOString().slice(0, 10);
  campoAte.value = ultimoDia.toISOString().slice(0, 10);
  localStorage.setItem('contaPeriodoDe', campoDe.value);
  localStorage.setItem('contaPeriodoAte', campoAte.value);
}

async function carregarPagamentos() {
  inicializarPeriodoContas();
  await popularSelectAlunos(document.getElementById('cobranca-aluno'));
  await popularSelectAlunos(document.getElementById('conta-aluno'));
  await popularSelectAlunosComTodos(document.getElementById('filtro-conta-aluno'));
  await carregarContas();
      carregarFinanceiroPerfil();
  if (estado.usuario?.papel === 'admin') carregarStatusGeracaoCobrancas();
}

// ---------------- Gerar Contas a Receber (manual, com escolha de período) ----------------
// 2026-07: deixou de rodar sozinha (nem no boot, nem a cada 24h) — agora só
// gera quando o admin clica o botão, escolhendo até qual mês gerar (mês
// corrente ou um mês futuro, pra adiantar vários meses de uma vez).

function mesAtualISO() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
}

// Preenche o seletor de mês com o mês corrente por padrão, na primeira vez
// que a tela de Contas a Receber é aberta.
(function inicializarSeletorPeriodoRecorrentes() {
  const campoPeriodo = document.getElementById('gerar-recorrentes-periodo');
  if (campoPeriodo && !campoPeriodo.value) campoPeriodo.value = mesAtualISO();
})();

async function carregarStatusGeracaoCobrancas() {
  const texto = document.getElementById('txt-ultima-geracao-cobrancas');
  try {
    const status = await api('/api/pagamentos/gerar-recorrentes/status');
    if (!status.executadoEm) {
      texto.textContent = 'Ainda não foi feita nenhuma geração de contas a receber neste sistema.';
    } else {
      const data = parseDataHoraServidor(status.executadoEm).toLocaleString('pt-BR');
      const periodo = status.ateData ? ` (até ${new Date(`${status.ateData}T00:00:00`).toLocaleDateString('pt-BR')})` : '';
      texto.textContent = `Última geração de contas a receber: ${data}${periodo} — ${status.geradas} cobrança(s) gerada(s) nessa execução. Só roda quando você clicar no botão.`;
    }
    texto.classList.remove('oculto');
  } catch (err) {
    texto.classList.add('oculto');
  }
}

document.getElementById('btn-gerar-recorrentes').addEventListener('click', async () => {
  const btn = document.getElementById('btn-gerar-recorrentes');
  const campoPeriodo = document.getElementById('gerar-recorrentes-periodo');
  const periodo = campoPeriodo.value || mesAtualISO(); // "YYYY-MM"
  const [ano, mes] = periodo.split('-').map(Number);

  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = 'Gerando...';
  try {
    const resp = await api('/api/pagamentos/gerar-recorrentes', { method: 'POST', body: JSON.stringify({ ano, mes }) });
    mostrarToast(resp.geradas > 0
      ? `${resp.geradas} conta(s) a receber gerada(s) até ${new Date(`${resp.ateData}T00:00:00`).toLocaleDateString('pt-BR')}.`
      : 'Nenhuma conta nova pra gerar nesse período — tudo em dia.');
    await carregarContas();
    carregarFinanceiroPerfil();
    await carregarStatusGeracaoCobrancas();
  } catch (err) {
    mostrarToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
});

// ---------------- Pagamento Rápido (busca por nome, resolve na hora) ----------------

let prDebounceTimer = null;
let prAlunoSelecionadoId = null;

function iniciarPagamentoRapido() {
  const campo = document.getElementById('pr-busca-nome');
  campo.value = '';
  campo.focus();
  document.getElementById('pr-sugestoes').classList.add('oculto');
  document.getElementById('pr-resultado').classList.add('oculto');
  prAlunoSelecionadoId = null;
}

document.getElementById('pr-busca-nome').addEventListener('input', (ev) => {
  clearTimeout(prDebounceTimer);
  const termo = ev.target.value.trim();
  document.getElementById('pr-resultado').classList.add('oculto');
  if (termo.length < 2) {
    document.getElementById('pr-sugestoes').classList.add('oculto');
    return;
  }
  prDebounceTimer = setTimeout(() => buscarSugestoesPagamentoRapido(termo), 250);
});

// Fecha a lista de sugestões ao clicar fora dela.
document.addEventListener('click', (ev) => {
  const caixa = document.getElementById('pr-sugestoes');
  const campo = document.getElementById('pr-busca-nome');
  if (caixa && !caixa.contains(ev.target) && ev.target !== campo) caixa.classList.add('oculto');
});

async function buscarSugestoesPagamentoRapido(termo) {
  try {
    // incluir_inativos: aluno trancado/inativo pode continuar devendo — a
    // recepção precisa achar e quitar mesmo assim.
    const alunos = await api(`/api/alunos?busca=${encodeURIComponent(termo)}&incluir_inativos=true`);
    const caixa = document.getElementById('pr-sugestoes');
    if (!alunos.length) {
      caixa.innerHTML = '<div style="padding:10px;color:#667085;font-size:13px">Nenhum aluno encontrado.</div>';
      caixa.classList.remove('oculto');
      return;
    }
    caixa.innerHTML = '';
    alunos.slice(0, 15).forEach((a) => {
      const item = el(`
        <div class="pr-sugestao-item" style="padding:10px 12px;cursor:pointer;border-bottom:1px solid #f0f1f3">
          <div style="font-weight:600">${a.nome}${a.status !== 'ativo' ? ` <span class="badge ${a.status}">${a.status}</span>` : ''}</div>
          <div style="font-size:12px;color:#667085">${a.telefone || a.cpf || ''}</div>
        </div>
      `);
      item.addEventListener('mouseenter', () => { item.style.background = '#f9fafb'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('click', () => selecionarAlunoPagamentoRapido(a));
      caixa.appendChild(item);
    });
    caixa.classList.remove('oculto');
  } catch (err) {
    mostrarToast(err.message, true);
  }
}

async function selecionarAlunoPagamentoRapido(aluno) {
  prAlunoSelecionadoId = aluno.id;
  document.getElementById('pr-busca-nome').value = aluno.nome;
  document.getElementById('pr-sugestoes').classList.add('oculto');
  document.getElementById('pr-aluno-nome').textContent = aluno.nome;
  document.getElementById('pr-resultado').classList.remove('oculto');

  const badgeStatus = document.getElementById('pr-status-acesso');
  badgeStatus.textContent = '...';
  badgeStatus.className = 'badge';
  try {
    const status = await api(`/api/alunos/${aluno.id}/status-acesso`);
    badgeStatus.textContent = status.liberado ? 'Acesso liberado' : `Acesso bloqueado — ${status.motivo}`;
    badgeStatus.className = `badge ${status.liberado ? 'ativo' : 'inadimplente'}`;
  } catch (err) {
    badgeStatus.textContent = '—';
  }

  await carregarContasPagamentoRapido(aluno.id);
}

async function carregarContasPagamentoRapido(alunoId) {
  const tbody = document.getElementById('pr-lista-contas');
  tbody.innerHTML = '<tr><td colspan="5">Carregando...</td></tr>';
  try {
    const contas = await api(`/api/pagamentos/cobrancas?aluno_id=${alunoId}`);
    if (!contas.length) {
      tbody.innerHTML = '<tr><td colspan="5">Nenhuma conta encontrada pra este aluno.</td></tr>';
      return;
    }
    // Em aberto primeiro (pendente/atrasado), depois o resto por vencimento decrescente.
    const ordenadas = [...contas].sort((a, b) => {
      const aAberta = a.status === 'pendente' || a.status === 'atrasado';
      const bAberta = b.status === 'pendente' || b.status === 'atrasado';
      if (aAberta !== bAberta) return aAberta ? -1 : 1;
      return (b.vencimento || '').localeCompare(a.vencimento || '');
    });
    tbody.innerHTML = '';
    ordenadas.forEach((c) => {
      const aberta = c.status === 'pendente' || c.status === 'atrasado';
      const tr = el(`
        <tr>
          <td>${c.descricao || '—'}</td>
          <td>${formatarMoeda(c.valor_centavos)}</td>
          <td>${c.vencimento || '—'}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
          <td><button class="btn-linha ${aberta ? 'btn-primario' : ''}" data-acao="abrir">${aberta ? 'Pagar' : 'Ver'}</button></td>
        </tr>
      `);
      tr.querySelector('[data-acao="abrir"]').addEventListener('click', () => abrirModalConta(c));
      tbody.appendChild(tr);
    });
  } catch (err) {
    mostrarToast(err.message, true);
  }
}

// Select de filtro precisa listar TODOS os alunos (não só ativos), senão não dá
// pra buscar contas de alunos inativos/trancados.
async function popularSelectAlunosComTodos(select) {
  try {
    const alunos = await api('/api/alunos');
    const atual = select.value;
    select.innerHTML = '<option value="">Todos os alunos</option>' +
      alunos.map((a) => `<option value="${a.id}">${a.nome}</option>`).join('');
    select.value = atual;
  } catch (err) { mostrarToast(err.message, true); }
}

// Estado de ordenação da tabela de Contas a Receber (clique no título da
// coluna) — mesmo padrão usado em Alunos (ver alternarOrdenacaoAlunos acima).
const DIRECAO_INICIAL_COLUNA_CONTAS = {
  aluno: 'asc', descricao: 'asc', valor: 'desc', vencimento: 'asc', status: 'asc', data_pago: 'desc', valor_pago: 'desc',
};
let ordenacaoContas = { campo: null, direcao: 'asc' };

function alternarOrdenacaoContas(campo) {
  if (ordenacaoContas.campo === campo) {
    ordenacaoContas.direcao = ordenacaoContas.direcao === 'asc' ? 'desc' : 'asc';
  } else {
    ordenacaoContas = { campo, direcao: DIRECAO_INICIAL_COLUNA_CONTAS[campo] || 'asc' };
  }
  carregarContas();
}

function ordenarContas(lista) {
  if (!ordenacaoContas.campo) return lista;
  const { campo, direcao } = ordenacaoContas;
  const mult = direcao === 'asc' ? 1 : -1;
  const valorDe = (c) => {
    if (campo === 'aluno') return (c.aluno_nome || '').toLowerCase();
    if (campo === 'descricao') return (c.descricao || '').toLowerCase();
    if (campo === 'valor') return Number(c.valor_centavos || 0);
    if (campo === 'vencimento') return c.vencimento || '';
    if (campo === 'status') return c.status || '';
    if (campo === 'data_pago') return c.data_pago_calc || (c.status === 'pago' ? c.pago_em : '') || '';
    if (campo === 'valor_pago') return Number(c.valor_pago_centavos || 0) || (c.status === 'pago' ? c.valor_centavos : 0);
    return '';
  };
  return [...lista].sort((a, b) => {
    const va = valorDe(a);
    const vb = valorDe(b);
    if (va < vb) return -1 * mult;
    if (va > vb) return 1 * mult;
    return 0;
  });
}

function atualizarSetasOrdenacaoContas() {
  document.querySelectorAll('#secao-pagamentos .seta-ordenacao').forEach((span) => {
    const campo = span.dataset.seta;
    span.textContent = ordenacaoContas.campo !== campo ? '' : (ordenacaoContas.direcao === 'asc' ? '▲' : '▼');
  });
}

document.querySelectorAll('#secao-pagamentos .th-ordenavel').forEach((th) => {
  th.addEventListener('click', () => alternarOrdenacaoContas(th.dataset.sort));
});

async function carregarContas() {
  try {
    const alunoId = document.getElementById('filtro-conta-aluno').value;
    const status = document.getElementById('filtro-conta-status').value;
    const busca = document.getElementById('busca-conta-nome').value.trim();
    const mostrarInativos = document.getElementById('mostrar-inativos-contas').checked;
    const campoData = document.getElementById('conta-filtro-data-campo').value || 'vencimento';
    const periodoDe = document.getElementById('conta-periodo-de').value;
    const periodoAte = document.getElementById('conta-periodo-ate').value;
    const params = new URLSearchParams();
    if (alunoId) params.set('aluno_id', alunoId);
    if (status) params.set('status', status);
    if (busca) params.set('busca', busca);
    if (mostrarInativos) params.set('incluir_inativos', 'true');
    if (periodoDe) params.set(campoData === 'pagamento' ? 'pagamento_de' : 'vencimento_de', periodoDe);
    if (periodoAte) params.set(campoData === 'pagamento' ? 'pagamento_ate' : 'vencimento_ate', periodoAte);

    const contasBrutas = await api(`/api/pagamentos/cobrancas${params.toString() ? '?' + params.toString() : ''}`);
    const contas = ordenarContas(contasBrutas);
    atualizarSetasOrdenacaoContas();
    const tbody = document.getElementById('lista-contas');
    const resumoEl = document.getElementById('contas-total-resumo');
    tbody.innerHTML = '';

    if (!contas.length) {
      tbody.innerHTML = '<tr><td colspan="8">Nenhuma conta encontrada.</td></tr>';
      resumoEl.textContent = '';
      return;
    }

    // Totais do período/filtro atual (mesmo formato já usado em Relatórios >
    // Financeiro) — soma sempre o que está sendo mostrado na tabela, então
    // acompanha qualquer combinação de filtros (data, status, aluno, busca).
    let totalValor = 0;
    let totalPago = 0;

    contas.forEach((c) => {
      // Fallback pra contas quitadas via webhook do gateway (Mercado Pago/InfinitePay) ou
      // marcadas como pagas na criação manual antiga, que podem não ter linha em
      // pagamentos_cobranca — nesses casos usa o valor/data cheios da própria conta.
      const valorPago = Number(c.valor_pago_centavos || 0) || (c.status === 'pago' ? c.valor_centavos : 0);
      const dataPago = c.data_pago_calc || (c.status === 'pago' ? c.pago_em : null);
      totalValor += c.valor_centavos;
      totalPago += valorPago;
      const tr = el(`
        <tr>
          <td><span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${c.aluno_nome}</span></td>
          <td>${c.descricao || '—'}</td>
          <td>${formatarMoeda(c.valor_centavos)}</td>
          <td>${c.vencimento || '—'}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
          <td>${formatarDataOuDataHora(dataPago)}</td>
          <td>${valorPago > 0 ? formatarMoeda(valorPago) : '—'}</td>
          <td>
            <button class="btn-linha" data-acao="editar">Alterar</button>
            <button class="btn-linha" data-acao="parcelar">Parcelar</button>
            <button class="btn-linha perigo" data-acao="excluir">Excluir</button>
          </td>
        </tr>
      `);
      tr.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(c.aluno_id));
      tr.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirModalConta(c));
      tr.querySelector('[data-acao="parcelar"]').addEventListener('click', () => abrirModalParcelamento({ modo: 'existente', conta: c }));
      tr.querySelector('[data-acao="excluir"]').addEventListener('click', async () => {
        if (!confirmar('Excluir esta conta a receber?')) return;
        try {
          await api(`/api/pagamentos/cobrancas/${c.id}`, { method: 'DELETE' });
          mostrarToast('Conta excluída.');
          carregarContas();
      carregarFinanceiroPerfil();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });

    resumoEl.textContent = `${contas.length} conta(s) — total ${formatarMoeda(totalValor)}, pago ${formatarMoeda(totalPago)}`;
  } catch (err) { mostrarToast(err.message, true); }
}

// Troca o texto do label "Vencimento de"/"até" conforme o filtro escolhido
// (Vencimento ou Data de pagamento), pra não confundir qual data está sendo filtrada.
function atualizarLabelPeriodoContas() {
  const campoData = document.getElementById('conta-filtro-data-campo').value || 'vencimento';
  document.getElementById('conta-periodo-de-label').textContent =
    campoData === 'pagamento' ? 'Data de pagamento de' : 'Vencimento de';
}

document.getElementById('filtro-conta-aluno').addEventListener('change', carregarContas);
document.getElementById('filtro-conta-status').addEventListener('change', carregarContas);
document.getElementById('mostrar-inativos-contas').addEventListener('change', carregarContas);
document.getElementById('conta-filtro-data-campo').addEventListener('change', (ev) => {
  localStorage.setItem('contaFiltroDataCampo', ev.target.value);
  atualizarLabelPeriodoContas();
  carregarContas();
});
document.getElementById('conta-periodo-de').addEventListener('change', (ev) => {
  localStorage.setItem('contaPeriodoDe', ev.target.value);
  carregarContas();
});
document.getElementById('conta-periodo-ate').addEventListener('change', (ev) => {
  localStorage.setItem('contaPeriodoAte', ev.target.value);
  carregarContas();
});

let buscaContaTimeout = null;
document.getElementById('busca-conta-nome').addEventListener('input', () => {
  clearTimeout(buscaContaTimeout);
  buscaContaTimeout = setTimeout(carregarContas, 300);
});

// Mostrar/ocultar os formulários de "conta manual" e "gerar cobrança" (ficam
// recolhidos por padrão para a tabela de Contas a Receber aparecer primeiro).
document.getElementById('btn-toggle-conta-manual').addEventListener('click', () => {
  document.getElementById('form-conta-manual').classList.toggle('oculto');
  document.getElementById('form-cobranca').classList.add('oculto');
  popularSelectPlanoParaConta(document.getElementById('conta-plano'));
});
document.getElementById('btn-toggle-cobranca').addEventListener('click', () => {
  document.getElementById('form-cobranca').classList.toggle('oculto');
  document.getElementById('form-conta-manual').classList.add('oculto');
});
document.getElementById('btn-cancelar-conta-manual').addEventListener('click', () => {
  document.getElementById('form-conta-manual').classList.add('oculto');
});
document.getElementById('btn-cancelar-cobranca').addEventListener('click', () => {
  document.getElementById('form-cobranca').classList.add('oculto');
});

// ---------------- Modal "Conta" (edição + histórico de pagamentos, estilo Secullum) ----------------

let modalContaAtual = null; // guarda a conta aberta no momento pra saber o id/valor/status atuais
let modalContaTotalPagoCentavos = 0; // soma dos pagamentos já lançados na conta aberta no modal

const ROTULOS_TIPO_PAGAMENTO = {
  dinheiro: 'Dinheiro', pix: 'Pix', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito',
  transferencia: 'Transferência bancária', boleto: 'Boleto', manual: 'Manual', outro: 'Outro',
};

async function abrirModalConta(conta) {
  modalContaAtual = conta;
  document.getElementById('mconta-id').value = conta.id;
  document.getElementById('mconta-aluno-nome').textContent = conta.aluno_nome || '—';
  document.getElementById('mconta-descricao').value = conta.descricao || '';
  document.getElementById('mconta-valor').value = (conta.valor_centavos / 100).toFixed(2);
  document.getElementById('mconta-vencimento').value = conta.vencimento || '';
  document.getElementById('mconta-valor-total').textContent = formatarMoeda(conta.valor_centavos);
  atualizarBadgeStatusModal(conta.status);
  document.getElementById('modal-conta').classList.remove('oculto');
  await carregarPagamentosModal();
}

function fecharModalConta() {
  document.getElementById('modal-conta').classList.add('oculto');
  modalContaAtual = null;
  // Se a tela de Pagamento Rápido estiver com um aluno selecionado, atualiza a
  // lista dele também (o modal pode ter sido aberto a partir de lá).
  if (typeof prAlunoSelecionadoId !== 'undefined' && prAlunoSelecionadoId) carregarContasPagamentoRapido(prAlunoSelecionadoId);
}

function atualizarBadgeStatusModal(status) {
  const badge = document.getElementById('mconta-status-badge');
  badge.textContent = status;
  badge.className = `badge ${status}`;
  document.getElementById('btn-remover-quitacao').classList.toggle('oculto', status !== 'pago');
  // Conta já quitada não aceita novo pagamento — precisa remover a quitação
  // primeiro (mesma regra aplicada no backend, POST .../pagamentos).
  document.getElementById('btn-add-pagamento').classList.toggle('oculto', status === 'pago');
  // Forçar pendente<->atrasado sem esperar o vencimento passar — útil pra
  // testar bloqueio de acesso/totem sem precisar recuar a data do sistema.
  // Não aparece se a conta já estiver paga/cancelada/estornada.
  document.getElementById('btn-marcar-atrasada').classList.toggle('oculto', status !== 'pendente');
  document.getElementById('btn-marcar-pendente').classList.toggle('oculto', status !== 'atrasado');
}

async function alterarStatusModalConta(novoStatus) {
  try {
    const resp = await api(`/api/pagamentos/cobrancas/${modalContaAtual.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: novoStatus }),
    });
    modalContaAtual.status = novoStatus;
    atualizarBadgeStatusModal(novoStatus);
    mostrarToast(novoStatus === 'atrasado' ? 'Conta marcada como atrasada.' : 'Conta marcada como pendente.');
    carregarContas();
    carregarFinanceiroPerfil();
    return resp;
  } catch (err) {
    mostrarToast(err.message, true);
  }
}

document.getElementById('btn-marcar-atrasada').addEventListener('click', () => alterarStatusModalConta('atrasado'));
document.getElementById('btn-marcar-pendente').addEventListener('click', () => alterarStatusModalConta('pendente'));

async function carregarPagamentosModal() {
  try {
    const pagamentos = await api(`/api/pagamentos/cobrancas/${modalContaAtual.id}/pagamentos`);
    const tbody = document.getElementById('mconta-lista-pagamentos');
    tbody.innerHTML = pagamentos.length ? '' : '<tr><td colspan="5">Nenhum pagamento lançado ainda.</td></tr>';
    let totalPago = 0;
    pagamentos.forEach((p) => {
      totalPago += p.valor_centavos;
      const tr = el(`
        <tr>
          <td>${formatarDataOuDataHora(p.data)}</td>
          <td>${formatarMoeda(p.valor_centavos)}</td>
          <td>${ROTULOS_TIPO_PAGAMENTO[p.tipo] || p.tipo || '—'}</td>
          <td>${p.conta_corrente || '—'}</td>
          <td><button type="button" class="btn-linha perigo" data-acao="excluir-pagamento">Excluir</button></td>
        </tr>
      `);
      tr.querySelector('[data-acao="excluir-pagamento"]').addEventListener('click', async () => {
        if (!confirmar('Excluir este pagamento? A conta pode voltar a ficar pendente/atrasada.')) return;
        try {
          const resp = await api(`/api/pagamentos/cobrancas/${modalContaAtual.id}/pagamentos/${p.id}`, { method: 'DELETE' });
          mostrarToast('Pagamento excluído.');
          if (resp.cobranca) atualizarBadgeStatusModal(resp.cobranca.status);
          await carregarPagamentosModal();
          carregarContas();
      carregarFinanceiroPerfil();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });
    modalContaTotalPagoCentavos = totalPago;
    document.getElementById('mconta-total-pago').textContent = formatarMoeda(totalPago);
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('btn-fechar-modal-conta').addEventListener('click', fecharModalConta);

// Lê os campos de edição da conta (descrição/valor/vencimento) direto do formulário.
function dadosEdicaoConta() {
  return {
    descricao: document.getElementById('mconta-descricao').value.trim(),
    valor_centavos: Math.round(parseFloat(document.getElementById('mconta-valor').value) * 100),
    vencimento: document.getElementById('mconta-vencimento').value || null,
  };
}

// Verdadeiro se o usuário mudou algo nos campos de edição (ex: valor, pra aplicar um
// desconto manual) mas ainda não clicou em "Salvar alterações" — usado pra não deixar
// a pessoa lançar um pagamento contra o valor ANTIGO por esquecer de salvar antes.
function edicaoContaTemAlteracoesPendentes() {
  if (!modalContaAtual) return false;
  const dados = dadosEdicaoConta();
  return dados.descricao !== (modalContaAtual.descricao || '')
    || dados.valor_centavos !== modalContaAtual.valor_centavos
    || (dados.vencimento || null) !== (modalContaAtual.vencimento || null);
}

// Salva as edições da conta (descrição/valor/vencimento) no backend e atualiza o
// estado local (modalContaAtual) e a UI do modal, sem necessariamente fechar o modal
// nem mostrar toast — usado tanto pelo submit do formulário quanto, silenciosamente,
// antes de abrir o modal de pagamento quando há uma edição de valor não salva.
async function salvarEdicaoConta({ mostrarFeedback = true } = {}) {
  const id = document.getElementById('mconta-id').value;
  const dados = dadosEdicaoConta();
  await api(`/api/pagamentos/cobrancas/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
  Object.assign(modalContaAtual, dados);
  document.getElementById('mconta-valor-total').textContent = formatarMoeda(modalContaAtual.valor_centavos);
  if (mostrarFeedback) mostrarToast('Conta atualizada.');
  carregarContas();
  carregarFinanceiroPerfil();
}

document.getElementById('form-modal-conta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await salvarEdicaoConta();
    fecharModalConta();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-excluir-conta-modal').addEventListener('click', async () => {
  if (!confirmar('Excluir esta conta a receber?')) return;
  try {
    await api(`/api/pagamentos/cobrancas/${modalContaAtual.id}`, { method: 'DELETE' });
    mostrarToast('Conta excluída.');
    fecharModalConta();
    carregarContas();
      carregarFinanceiroPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-remover-quitacao').addEventListener('click', async () => {
  if (!confirmar('Remover a quitação desta conta? Ela volta a ficar pendente/atrasada (o histórico de pagamentos é mantido).')) return;
  try {
    const resp = await api(`/api/pagamentos/cobrancas/${modalContaAtual.id}/remover-quitacao`, { method: 'POST' });
    mostrarToast('Quitação removida.');
    atualizarBadgeStatusModal(resp.cobranca.status);
    carregarContas();
      carregarFinanceiroPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- Modal "Pagamento" (lançar um recebimento numa conta) ----------------
// Se o plano vinculado à conta tem desconto configurado para uma forma de
// pagamento específica (ex: "5% no dinheiro" — ver aba Planos), esse desconto
// é aplicado automaticamente no campo "Valor" sempre que essa forma é
// selecionada aqui, sem precisar calcular na mão. Some ao trocar de volta pra
// outra forma de pagamento.

let pagamentoSaldoCentavos = 0; // saldo em aberto da conta no momento em que o modal foi aberto

function calcularValorComDesconto(saldoCentavos, plano) {
  if (!plano?.plano_desconto_tipo) return saldoCentavos;
  const desconto = plano.plano_desconto_tipo === 'percentual'
    ? Math.round(saldoCentavos * (plano.plano_desconto_percentual / 100))
    : Math.min(plano.plano_desconto_valor_centavos, saldoCentavos);
  return Math.max(saldoCentavos - desconto, 0);
}

// Calcula, a partir do estado atual da tela (forma de pagamento selecionada + caixinha
// marcada/desmarcada), se o desconto automático vale pra este pagamento e quanto ele
// representa em centavos. Usado tanto pra atualizar o campo "Valor" quanto, no submit,
// pra abater o mesmo desconto do valor OFICIAL da conta (senão o pagamento com desconto
// nunca fecha o valor cheio da conta e ela não sai de "pendente" — o desconto precisa
// valer nos dois lugares, não só no valor digitado do pagamento).
function obterInfoDescontoPagamento() {
  const tipoSelecionado = document.getElementById('pagamento-tipo').value;
  const checkboxEl = document.getElementById('pagamento-aplicar-desconto');
  const plano = modalContaAtual;
  const descontoConfigurado = plano?.plano_desconto_tipo
    && plano.plano_desconto_forma_pagamento === tipoSelecionado;
  const descontoAplicavel = descontoConfigurado && checkboxEl.checked;
  if (!descontoAplicavel) return { descontoConfigurado, descontoAplicavel: false, descontoCentavos: 0, valorComDesconto: pagamentoSaldoCentavos };
  const valorComDesconto = calcularValorComDesconto(pagamentoSaldoCentavos, plano);
  const descontoCentavos = pagamentoSaldoCentavos - valorComDesconto;
  return { descontoConfigurado, descontoAplicavel: true, descontoCentavos, valorComDesconto };
}

function atualizarValorPagamentoComDesconto() {
  const tipoSelecionado = document.getElementById('pagamento-tipo').value;
  const avisoEl = document.getElementById('pagamento-desconto-aviso');
  const campoCheckboxEl = document.getElementById('campo-pagamento-desconto');
  const plano = modalContaAtual;
  const { descontoConfigurado, descontoAplicavel, valorComDesconto } = obterInfoDescontoPagamento();

  // A caixinha só aparece quando existe um desconto configurado (na aba Planos) pra
  // essa forma de pagamento — marcada por padrão (aplica automático, como já era antes),
  // mas dá pra desmarcar na hora se, por algum motivo, esse pagamento específico não
  // deve levar o desconto (ex: aluno já usou o desconto em outro lugar).
  campoCheckboxEl.classList.toggle('oculto', !descontoConfigurado);

  document.getElementById('pagamento-valor').value = (valorComDesconto / 100).toFixed(2);

  if (descontoAplicavel) {
    const rotuloDesconto = plano.plano_desconto_tipo === 'percentual'
      ? `${plano.plano_desconto_percentual}%`
      : formatarMoeda(plano.plano_desconto_valor_centavos);
    avisoEl.textContent = `Desconto de ${rotuloDesconto} aplicado — o valor da conta também será reduzido (pagamento em ${ROTULOS_TIPO_PAGAMENTO[tipoSelecionado] || tipoSelecionado}).`;
    avisoEl.classList.remove('oculto');
  } else {
    avisoEl.classList.add('oculto');
  }
}

function abrirModalPagamento() {
  pagamentoSaldoCentavos = Math.max(modalContaAtual.valor_centavos - modalContaTotalPagoCentavos, 0);

  document.getElementById('pagamento-data').value = hojeLocalISO();
  document.getElementById('pagamento-tipo').value = 'dinheiro';
  document.getElementById('pagamento-conta-corrente').value = 'Caixa da empresa';
  document.getElementById('pagamento-aplicar-desconto').checked = true;
  atualizarValorPagamentoComDesconto();
  document.getElementById('modal-pagamento').classList.remove('oculto');
}

function fecharModalPagamento() {
  document.getElementById('modal-pagamento').classList.add('oculto');
}

document.getElementById('btn-add-pagamento').addEventListener('click', async () => {
  // Se a pessoa mexeu no valor (ex: pra aplicar um desconto manual) mas esqueceu de
  // clicar em "Salvar alterações" antes de lançar o pagamento, salva agora — senão o
  // pagamento seria conferido contra o valor antigo e a conta nunca sairia de "pendente".
  if (edicaoContaTemAlteracoesPendentes()) {
    try {
      await salvarEdicaoConta({ mostrarFeedback: false });
      mostrarToast('O valor da conta foi salvo automaticamente antes de lançar o pagamento.');
    } catch (err) {
      mostrarToast(err.message, true);
      return;
    }
  }
  abrirModalPagamento();
});
document.getElementById('btn-fechar-modal-pagamento').addEventListener('click', fecharModalPagamento);
document.getElementById('btn-cancelar-modal-pagamento').addEventListener('click', fecharModalPagamento);
document.getElementById('pagamento-tipo').addEventListener('change', atualizarValorPagamentoComDesconto);
document.getElementById('pagamento-aplicar-desconto').addEventListener('change', atualizarValorPagamentoComDesconto);

document.getElementById('form-modal-pagamento').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    data: document.getElementById('pagamento-data').value,
    valor_centavos: Math.round(parseFloat(document.getElementById('pagamento-valor').value) * 100),
    tipo: document.getElementById('pagamento-tipo').value,
    conta_corrente: document.getElementById('pagamento-conta-corrente').value.trim() || null,
  };
  try {
    // Quando a caixinha "Aplicar desconto automático" está marcada, o desconto precisa
    // ser abatido do valor OFICIAL da conta também, não só do valor digitado do
    // pagamento — senão o pagamento (já com desconto) nunca fecha o valor cheio da
    // conta no backend e ela nunca sai de "pendente".
    const { descontoAplicavel, descontoCentavos } = obterInfoDescontoPagamento();
    if (descontoAplicavel && descontoCentavos > 0) {
      const novoValorConta = Math.max(modalContaAtual.valor_centavos - descontoCentavos, 0);
      await api(`/api/pagamentos/cobrancas/${modalContaAtual.id}`, {
        method: 'PUT',
        body: JSON.stringify({ valor_centavos: novoValorConta }),
      });
      modalContaAtual.valor_centavos = novoValorConta;
      document.getElementById('mconta-valor').value = (novoValorConta / 100).toFixed(2);
      document.getElementById('mconta-valor-total').textContent = formatarMoeda(novoValorConta);
    }

    const resp = await api(`/api/pagamentos/cobrancas/${modalContaAtual.id}/pagamentos`, { method: 'POST', body: JSON.stringify(dados) });
    if (resp.enfileirado) {
      mostrarToast(resp.aviso);
    } else {
      mostrarToast(resp.cobranca?.status === 'pago' ? 'Pagamento lançado — conta quitada!' : 'Pagamento lançado.');
    }
    if (resp.cobranca) atualizarBadgeStatusModal(resp.cobranca.status);
    fecharModalPagamento();
    await carregarPagamentosModal();
    carregarContas();
      carregarFinanceiroPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- Modal "Parcelamentos" (Parcelar Conta / Incluir Conta Parcelada) ----------------

let modalParcelamentoModo = null; // 'existente' | 'novo'
let modalParcelamentoConta = null; // conta original, só quando modo === 'existente'

// Mesma lógica do backend (gerarParcelas em pagamentos.routes.js) — replicada aqui só
// pra "Prever parcelamento" responder na hora, sem round-trip. Se mudar uma, muda a outra.
function gerarParcelasPreview({
  valorTotalCentavos, numParcelas, dataPrimeiraParcela, diaVencimento,
  valorPrimeiraEspecialCentavos, taxaJurosPercentual, tipoJuros, arredondar,
}) {
  const temPrimeiraEspecial = valorPrimeiraEspecialCentavos != null;
  const restante = temPrimeiraEspecial ? valorTotalCentavos - valorPrimeiraEspecialCentavos : valorTotalCentavos;
  const qtdRestantes = temPrimeiraEspecial ? numParcelas - 1 : numParcelas;
  const valorBase = qtdRestantes > 0 ? restante / qtdRestantes : restante;
  const taxa = (taxaJurosPercentual || 0) / 100;

  const parcelas = [];
  for (let i = 0; i < numParcelas; i++) {
    let valor;
    if (i === 0 && temPrimeiraEspecial) {
      valor = valorPrimeiraEspecialCentavos;
    } else {
      valor = taxa > 0
        ? (tipoJuros === 'composto' ? valorBase * Math.pow(1 + taxa, i) : valorBase * (1 + taxa * i))
        : valorBase;
    }
    valor = arredondar ? Math.round(valor / 100) * 100 : Math.round(valor);

    const data = new Date(`${dataPrimeiraParcela}T00:00:00`);
    data.setMonth(data.getMonth() + i);
    if (diaVencimento) data.setDate(Math.min(diaVencimento, 28));
    parcelas.push({ data: data.toISOString().slice(0, 10), valor_centavos: valor });
  }

  const soma = parcelas.reduce((acc, p) => acc + p.valor_centavos, 0);
  const diferenca = valorTotalCentavos - soma;
  if (diferenca !== 0) parcelas[parcelas.length - 1].valor_centavos += diferenca;

  return parcelas;
}

async function abrirModalParcelamento({ modo, conta, alunoIdPreselect }) {
  modalParcelamentoModo = modo;
  modalParcelamentoConta = conta || null;

  document.getElementById('mparc-bloco-novo').classList.toggle('oculto', modo !== 'novo');
  document.getElementById('mparc-bloco-existente').classList.toggle('oculto', modo !== 'existente');

  const hoje = hojeLocalISO();
  if (modo === 'novo') {
    const selectAluno = document.getElementById('mparc-aluno');
    await popularSelectAlunos(selectAluno);
    // Aberto a partir da aba Financeiro do perfil: já vem com o aluno certo e travado,
    // já que o contexto (qual aluno) já está definido pela página onde o admin está.
    if (alunoIdPreselect) {
      selectAluno.value = alunoIdPreselect;
      selectAluno.disabled = true;
    } else {
      selectAluno.disabled = false;
    }
    document.getElementById('mparc-descricao').value = 'Mensalidade';
    document.getElementById('mparc-valor-total').value = '';
    document.getElementById('mparc-valor-total').disabled = false;
    document.getElementById('mparc-data-primeira').value = hoje;
  } else {
    document.getElementById('mparc-aluno-nome').textContent = conta.aluno_nome || '—';
    document.getElementById('mparc-descricao-existente').textContent = conta.descricao || 'Mensalidade';
    document.getElementById('mparc-valor-total').value = (conta.valor_centavos / 100).toFixed(2);
    document.getElementById('mparc-valor-total').disabled = true; // parcela sempre soma o valor atual da conta
    document.getElementById('mparc-data-primeira').value = conta.vencimento || hoje;
  }

  document.getElementById('mparc-parcelas').value = 2;
  document.getElementById('mparc-dia-vencimento').value = '';
  document.getElementById('mparc-chk-primeira-especial').checked = false;
  document.getElementById('mparc-valor-primeira-especial').value = '';
  document.getElementById('mparc-valor-primeira-especial').disabled = true;
  document.getElementById('mparc-chk-juros').checked = false;
  document.getElementById('mparc-taxa-juros').value = '';
  document.getElementById('mparc-taxa-juros').disabled = true;
  document.getElementById('mparc-tipo-juros').disabled = true;
  document.getElementById('mparc-chk-arredondar').checked = false;
  document.getElementById('mparc-chk-quitadas').checked = false;
  document.getElementById('mparc-lista-preview').innerHTML = '<tr><td colspan="2">Clique em "Prever parcelamento" pra ver as parcelas.</td></tr>';
  document.getElementById('mparc-total-preview').textContent = 'R$ 0,00';

  document.getElementById('modal-parcelamento').classList.remove('oculto');
}

function fecharModalParcelamento() {
  document.getElementById('modal-parcelamento').classList.add('oculto');
}

document.getElementById('mparc-chk-primeira-especial').addEventListener('change', (ev) => {
  document.getElementById('mparc-valor-primeira-especial').disabled = !ev.target.checked;
});
document.getElementById('mparc-chk-juros').addEventListener('change', (ev) => {
  document.getElementById('mparc-taxa-juros').disabled = !ev.target.checked;
  document.getElementById('mparc-tipo-juros').disabled = !ev.target.checked;
});

// Lê os campos do formulário e devolve o payload usado tanto pra prévia (client) quanto
// pro envio real (servidor) — os nomes de campo já saem no formato que a API espera.
function lerFormParcelamento() {
  const chkPrimeira = document.getElementById('mparc-chk-primeira-especial').checked;
  const chkJuros = document.getElementById('mparc-chk-juros').checked;
  const diaVencimento = document.getElementById('mparc-dia-vencimento').value;
  return {
    valor_centavos: Math.round(parseFloat(document.getElementById('mparc-valor-total').value || '0') * 100),
    parcelas: parseInt(document.getElementById('mparc-parcelas').value, 10),
    data_primeira_parcela: document.getElementById('mparc-data-primeira').value,
    dia_vencimento: diaVencimento ? parseInt(diaVencimento, 10) : null,
    valor_primeira_especial_centavos: chkPrimeira
      ? Math.round(parseFloat(document.getElementById('mparc-valor-primeira-especial').value || '0') * 100)
      : null,
    taxa_juros_percentual: chkJuros ? parseFloat(document.getElementById('mparc-taxa-juros').value || '0') : 0,
    tipo_juros: document.getElementById('mparc-tipo-juros').value,
    arredondar: document.getElementById('mparc-chk-arredondar').checked,
    lancar_quitadas: document.getElementById('mparc-chk-quitadas').checked,
  };
}

document.getElementById('btn-prever-parcelamento').addEventListener('click', () => {
  const dados = lerFormParcelamento();
  if (!dados.valor_centavos || !dados.parcelas || !dados.data_primeira_parcela) {
    mostrarToast('Preencha valor total, parcelas e data da 1ª parcela pra prever.', true);
    return;
  }
  const parcelas = gerarParcelasPreview({
    valorTotalCentavos: dados.valor_centavos,
    numParcelas: dados.parcelas,
    dataPrimeiraParcela: dados.data_primeira_parcela,
    diaVencimento: dados.dia_vencimento,
    valorPrimeiraEspecialCentavos: dados.valor_primeira_especial_centavos,
    taxaJurosPercentual: dados.taxa_juros_percentual,
    tipoJuros: dados.tipo_juros,
    arredondar: dados.arredondar,
  });
  const tbody = document.getElementById('mparc-lista-preview');
  tbody.innerHTML = parcelas.map((p) => `
    <tr><td>${new Date(`${p.data}T00:00:00`).toLocaleDateString('pt-BR')}</td><td>${formatarMoeda(p.valor_centavos)}</td></tr>
  `).join('');
  const total = parcelas.reduce((acc, p) => acc + p.valor_centavos, 0);
  document.getElementById('mparc-total-preview').textContent = formatarMoeda(total);
});

document.getElementById('btn-fechar-modal-parcelamento').addEventListener('click', fecharModalParcelamento);
document.getElementById('btn-cancelar-modal-parcelamento').addEventListener('click', fecharModalParcelamento);

document.getElementById('btn-nova-conta-parcelada').addEventListener('click', () => abrirModalParcelamento({ modo: 'novo' }));

document.getElementById('btn-parcelar-conta-modal').addEventListener('click', () => {
  const conta = modalContaAtual;
  fecharModalConta();
  abrirModalParcelamento({ modo: 'existente', conta });
});

document.getElementById('form-modal-parcelamento').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = lerFormParcelamento();

  // Validação manual (não dá pra confiar em `required` nativo aqui: o campo de aluno
  // fica escondido no modo "existente", e o Chrome bloqueia o submit silenciosamente
  // — sem mostrar nada na tela — quando um campo required não é focável).
  if (!dados.valor_centavos) {
    mostrarToast('Informe o valor total.', true);
    return;
  }
  if (!dados.parcelas || dados.parcelas < 2) {
    mostrarToast('Informe pelo menos 2 parcelas.', true);
    return;
  }
  if (!dados.data_primeira_parcela) {
    mostrarToast('Informe a data da 1ª parcela.', true);
    return;
  }
  const alunoId = modalParcelamentoModo === 'novo' ? document.getElementById('mparc-aluno').value : null;
  if (modalParcelamentoModo === 'novo' && !alunoId) {
    mostrarToast('Selecione um aluno.', true);
    return;
  }

  try {
    if (modalParcelamentoModo === 'existente') {
      await api(`/api/pagamentos/cobrancas/${modalParcelamentoConta.id}/parcelar`, { method: 'POST', body: JSON.stringify(dados) });
    } else {
      const payload = {
        ...dados,
        aluno_id: alunoId,
        descricao: document.getElementById('mparc-descricao').value.trim() || 'Mensalidade',
      };
      await api('/api/pagamentos/cobrancas/parceladas', { method: 'POST', body: JSON.stringify(payload) });
    }
    mostrarToast('Parcelamento criado.');
    fecharModalParcelamento();
    carregarContas();
      carregarFinanceiroPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('form-conta-manual').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    aluno_id: document.getElementById('conta-aluno').value,
    descricao: document.getElementById('conta-descricao').value.trim() || 'Mensalidade',
    valor_centavos: Math.round(parseFloat(document.getElementById('conta-valor').value) * 100),
    vencimento: document.getElementById('conta-vencimento').value || null,
    status: document.getElementById('conta-status').value,
  };
  try {
    await api('/api/pagamentos/cobrancas', { method: 'POST', body: JSON.stringify(dados) });
    mostrarToast('Conta cadastrada.');
    ev.target.reset();
    document.getElementById('form-conta-manual').classList.add('oculto');
    carregarContas();
      carregarFinanceiroPerfil();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('form-cobranca').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    aluno_id: document.getElementById('cobranca-aluno').value,
    descricao: document.getElementById('cobranca-descricao').value.trim() || 'Mensalidade',
    valor_centavos: Math.round(parseFloat(document.getElementById('cobranca-valor').value) * 100),
  };
  const resultadoEl = document.getElementById('cobranca-resultado');
  try {
    const resp = await api('/api/pagamentos/cobrar', { method: 'POST', body: JSON.stringify(dados) });
    resultadoEl.classList.remove('oculto');
    resultadoEl.innerHTML = resp.link_pagamento
      ? `Cobrança criada. Link: <a href="${resp.link_pagamento}" target="_blank" rel="noopener">${resp.link_pagamento}</a>`
      : `Cobrança criada, mas o Mercado Pago não retornou um link (verifique as credenciais no .env).`;
    mostrarToast('Cobrança gerada.');
    carregarContas();
      carregarFinanceiroPerfil();
  } catch (err) {
    resultadoEl.classList.remove('oculto');
    resultadoEl.textContent = `Erro ao gerar cobrança: ${err.message}`;
    mostrarToast(err.message, true);
  }
});

// ---------------- USUÁRIOS ----------------

async function carregarUsuarios() {
  try {
    const usuarios = await api('/api/usuarios');
    const tbody = document.getElementById('lista-usuarios');
    tbody.innerHTML = '';
    usuarios.forEach((u) => {
      const tr = el(`
        <tr>
          <td>${u.nome}</td>
          <td>${u.usuario || '—'}</td>
          <td>${u.email}</td>
          <td>
            <select class="btn-linha" data-acao="papel" style="padding:5px">
              <option value="admin">admin</option>
              <option value="professor">professor</option>
              <option value="recepcao">recepcao</option>
            </select>
          </td>
          <td><button class="btn-linha perigo" data-acao="excluir">Excluir</button></td>
        </tr>
      `);
      tr.querySelector('[data-acao="papel"]').value = u.papel;
      tr.querySelector('[data-acao="papel"]').addEventListener('change', async (ev) => {
        try {
          await api(`/api/usuarios/${u.id}/papel`, { method: 'PATCH', body: JSON.stringify({ papel: ev.target.value }) });
          mostrarToast('Papel atualizado.');
        } catch (err) { mostrarToast(err.message, true); }
      });
      tr.querySelector('[data-acao="excluir"]').addEventListener('click', async () => {
        if (!confirmar(`Excluir o usuário "${u.nome}"?`)) return;
        try {
          await api(`/api/usuarios/${u.id}`, { method: 'DELETE' });
          mostrarToast('Usuário excluído.');
          carregarUsuarios();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('form-usuario').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    nome: document.getElementById('usuario-nome-novo').value.trim(),
    email: document.getElementById('usuario-email-novo').value.trim(),
    usuario: document.getElementById('usuario-usuario-novo').value.trim(),
    senha: document.getElementById('usuario-senha-novo').value,
    papel: document.getElementById('usuario-papel-novo').value,
  };
  try {
    await api('/api/usuarios', { method: 'POST', body: JSON.stringify(dados) });
    mostrarToast('Usuário criado.');
    ev.target.reset();
    carregarUsuarios();
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------------- Catraca ----------------

function paramsCatraca() {
  const ip = document.getElementById('catraca-ip').value.trim();
  const porta = document.getElementById('catraca-porta').value.trim();
  const params = new URLSearchParams();
  if (ip) params.set('ip', ip);
  if (porta) params.set('port', porta);
  return { ip, porta, query: params.toString() };
}

function rotuloModo(modo) {
  return modo === 'agente' ? 'via agente local' : 'direto (mesma rede do servidor)';
}

document.getElementById('btn-testar-catraca').addEventListener('click', async () => {
  const resultadoEl = document.getElementById('catraca-resultado');
  const { query } = paramsCatraca();
  resultadoEl.textContent = 'Testando...';
  try {
    const resp = await api(`/api/terminal/catraca/testar${query ? '?' + query : ''}`);
    resultadoEl.textContent = resp.ok
      ? `✅ Conectou em ${resp.ip}:${resp.port} (${rotuloModo(resp.modo)}).`
      : `⛔ Não conectou em ${resp.ip}:${resp.port} — ${resp.erro} (${rotuloModo(resp.modo)})`;
  } catch (err) {
    resultadoEl.textContent = `⚠️ ${err.message}`;
  }
});

// ---------------- Status do agente local (nuvem) / modo direto ----------------

async function atualizarStatusAgenteCatraca() {
  const el = document.getElementById('catraca-status-modo');
  try {
    const resp = await api('/api/terminal/catraca/agente/status');
    el.textContent = resp.conectado
      ? 'agente local conectado'
      : 'modo direto (nenhum agente conectado)';
  } catch (err) {
    el.textContent = 'não foi possível checar';
  }
}

// ---------------- Liberação de pânico (status) ----------------

async function atualizarStatusPanico() {
  try {
    const resp = await api('/api/terminal/catraca/panico/status');
    document.getElementById('panico-status-texto').textContent = resp.ativo ? 'ATIVA — catraca liberando continuamente' : 'inativa';
  } catch (err) {
    document.getElementById('panico-status-texto').textContent = 'não foi possível checar';
  }
}

// ---------------- "Indicar uma pessoa" habilita/desabilita o select de aluno ----------------

document.getElementById('catraca-chk-indicar-pessoa').addEventListener('change', (ev) => {
  document.getElementById('catraca-liberar-aluno').disabled = !ev.target.checked;
});

// ---------------- Botão único "Liberar" — decide a ação pelo rádio marcado ----------------
// (equivalente ao botão "Liberar" da janela "Liberar Equipamentos" do Secullum: um só botão,
// o modo escolhido acima é que determina se libera um acesso, indica uma pessoa, ativa ou
// cancela a liberação contínua/pânico)

document.getElementById('btn-catraca-liberar').addEventListener('click', async () => {
  const resultadoEl = document.getElementById('catraca-resultado');
  const modo = document.querySelector('input[name="catraca-modo"]:checked').value;
  const { ip, porta } = paramsCatraca();

  try {
    if (modo === 'panico') {
      if (!confirmar('Isso vai manter a catraca liberando continuamente até você cancelar. Use apenas em emergência. Continuar?')) return;
      await api('/api/terminal/catraca/panico/ativar', {
        method: 'POST',
        body: JSON.stringify({ ip: ip || undefined, port: porta ? Number(porta) : undefined }),
      });
      resultadoEl.textContent = '✅ Liberação contínua (pânico) ativada.';
      mostrarToast('Liberação de pânico ativada.');
      atualizarStatusPanico();
      carregarAcessosCatraca();
      return;
    }

    if (modo === 'cancelar-panico') {
      if (!confirmar('Cancelar a liberação de pânico e voltar a catraca ao funcionamento normal?')) return;
      await api('/api/terminal/catraca/panico/cancelar', { method: 'POST' });
      resultadoEl.textContent = '✅ Liberação contínua (pânico) cancelada.';
      mostrarToast('Liberação de pânico cancelada.');
      atualizarStatusPanico();
      carregarAcessosCatraca();
      return;
    }

    // modo === 'unico'
    const indicarPessoa = document.getElementById('catraca-chk-indicar-pessoa').checked;
    const alunoId = document.getElementById('catraca-liberar-aluno').value;
    const lado = document.getElementById('catraca-lado').value;
    const rotuloLado = { ambos: 'Ambos os lados', entrada: 'Entrada', saida: 'Saída' }[lado] || '';
    // Nota: o hardware Henry usado aqui libera sempre nos dois lados por comando — o
    // "lado" escolhido acima fica registrado no histórico, mas não altera o comando físico.
    // Sem confirmação de propósito: liberação manual é uma ação de uso frequente no dia a
    // dia da recepção, e um "Continuar?" a cada clique só atrapalha o fluxo.

    if (indicarPessoa) {
      if (!alunoId) { mostrarToast('Selecione o aluno em "Indicar uma pessoa".', true); return; }
      await api('/api/terminal/catraca/liberar-aluno', {
        method: 'POST',
        body: JSON.stringify({
          aluno_id: alunoId, ip: ip || undefined, port: porta ? Number(porta) : undefined,
          mensagem: `Liberação manual pelo painel (${rotuloLado})`,
        }),
      });
      resultadoEl.textContent = '✅ Catraca liberada para o aluno selecionado.';
    } else {
      await api('/api/terminal/catraca/liberar', {
        method: 'POST',
        body: JSON.stringify({ ip: ip || undefined, port: porta ? Number(porta) : undefined, mensagem: `Liberação manual do painel (${rotuloLado})` }),
      });
      resultadoEl.textContent = '✅ Comando de liberação enviado. Confira se a catraca abriu fisicamente.';
    }
    mostrarToast('Catraca liberada.');
    carregarAcessosCatraca();
  } catch (err) {
    resultadoEl.textContent = `⚠️ ${err.message}`;
    mostrarToast(err.message, true);
  }
});

document.getElementById('btn-fechar-janela-catraca-2').addEventListener('click', fecharJanelaCatraca);

async function carregarSecaoCatraca() {
  await popularSelectAlunos(document.getElementById('catraca-liberar-aluno'));
  await atualizarStatusPanico();
  await atualizarStatusAgenteCatraca();
  await carregarAcessosCatraca();
}

async function carregarAcessosCatraca() {
  try {
    const lista = await api('/api/terminal/acessos');
    const tbody = document.getElementById('lista-acessos-catraca');
    tbody.innerHTML = lista.length ? '' : '<tr><td colspan="3">Nenhuma tentativa registrada ainda.</td></tr>';
    lista.slice(0, 15).forEach((a) => {
      const nomeCel = a.aluno_id
        ? `<span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${a.aluno_nome}</span>`
        : (a.aluno_nome || '—');
      const tr = el(`
        <tr>
          <td>${parseDataHoraServidor(a.criado_em).toLocaleString('pt-BR')}</td>
          <td>${nomeCel}</td>
          <td title="${a.mensagem || ''}"><span class="badge ${a.resultado === 'liberado' ? 'ativo' : 'inadimplente'}">${a.resultado}</span></td>
        </tr>
      `);
      tr.querySelector('.nome-clicavel')?.addEventListener('click', () => abrirPerfilAluno(a.aluno_id));
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

// ---------------- RELATÓRIOS ----------------
// Relatórios > Financeiro (Contas a Receber com filtros) e Relatórios > Acessos
// (Acesso Diário / Acesso Pessoal / Último Acesso). Cada um tem seu próprio filtro de
// data/período, conforme pedido.

document.querySelectorAll('.relatorio-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    trocarAbaRelatorio(btn.dataset.relatorio);
    if (btn.dataset.relatorio === 'pessoas') buscarRelatorioPessoas();
  });
});

function trocarAbaRelatorio(nome) {
  document.querySelectorAll('.relatorio-tab-btn').forEach((b) => b.classList.toggle('ativo', b.dataset.relatorio === nome));
  document.querySelectorAll('.relatorio-painel').forEach((p) => p.classList.toggle('oculto', p.dataset.relatorioPainel !== nome));
}

async function carregarSecaoRelatorios() {
  await popularSelectAlunosComTodos(document.getElementById('rel-fin-aluno'));
  await popularSelectAlunos(document.getElementById('rel-pessoal-aluno'), { comPlaceholder: true });
  const hoje = hojeLocalISO();
  if (!document.getElementById('rel-diario-data').value) document.getElementById('rel-diario-data').value = hoje;
  await buscarRelatorioFinanceiro();
  await buscarRelatorioAcessoDiario();
}

// ---- Relatório: Financeiro (Contas a Receber) ----
async function buscarRelatorioFinanceiro() {
  try {
    const params = new URLSearchParams();
    const vencDe = document.getElementById('rel-fin-vencimento-de').value;
    const vencAte = document.getElementById('rel-fin-vencimento-ate').value;
    const alunoId = document.getElementById('rel-fin-aluno').value;
    const status = document.getElementById('rel-fin-status').value;
    const ordenarPor = document.getElementById('rel-fin-ordenar').value;
    const decrescente = document.getElementById('rel-fin-decrescente').checked;
    const mostrarInativos = document.getElementById('rel-fin-mostrar-inativos').checked;
    if (vencDe) params.set('vencimento_de', vencDe);
    if (vencAte) params.set('vencimento_ate', vencAte);
    if (alunoId) params.set('aluno_id', alunoId);
    if (status) params.set('status', status);
    if (ordenarPor) params.set('ordenar_por', ordenarPor);
    if (decrescente) params.set('decrescente', 'true');
    if (mostrarInativos) params.set('incluir_inativos', 'true');

    const contas = await api(`/api/pagamentos/cobrancas${params.toString() ? '?' + params.toString() : ''}`);
    const tbody = document.getElementById('rel-fin-lista');
    tbody.innerHTML = contas.length ? '' : '<tr><td colspan="7">Nenhuma conta encontrada.</td></tr>';
    let totalValor = 0;
    let totalPago = 0;
    contas.forEach((c) => {
      const valorPago = Number(c.valor_pago_centavos || 0) || (c.status === 'pago' ? c.valor_centavos : 0);
      const dataPago = c.data_pago_calc || (c.status === 'pago' ? c.pago_em : null);
      totalValor += c.valor_centavos;
      totalPago += valorPago;
      const trFin = el(`
        <tr>
          <td><span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${c.aluno_nome}</span></td>
          <td>${c.descricao || '—'}</td>
          <td>${formatarMoeda(c.valor_centavos)}</td>
          <td>${c.vencimento || '—'}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
          <td>${formatarDataOuDataHora(dataPago)}</td>
          <td>${valorPago > 0 ? formatarMoeda(valorPago) : '—'}</td>
        </tr>
      `);
      trFin.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(c.aluno_id));
      tbody.appendChild(trFin);
    });
    document.getElementById('rel-fin-total').textContent = contas.length
      ? `${contas.length} conta(s) — total ${formatarMoeda(totalValor)}, pago ${formatarMoeda(totalPago)}`
      : '';
  } catch (err) { mostrarToast(err.message, true); }
}
document.getElementById('btn-rel-fin-buscar').addEventListener('click', buscarRelatorioFinanceiro);
document.getElementById('rel-fin-mostrar-inativos').addEventListener('change', buscarRelatorioFinanceiro);

// ---- Relatório: Acesso Diário (todos os acessos de um dia) ----
async function buscarRelatorioAcessoDiario() {
  try {
    const data = document.getElementById('rel-diario-data').value;
    const busca = document.getElementById('rel-diario-busca').value.trim();
    const modo = document.getElementById('rel-diario-modo').value;
    const params = new URLSearchParams();
    if (data) params.set('data', data);
    if (busca) params.set('busca', busca);
    if (modo === 'primeiro') params.set('apenas_primeiro', 'true');

    const lista = await api(`/api/terminal/acessos${params.toString() ? '?' + params.toString() : ''}`);
    const tbody = document.getElementById('rel-diario-lista');
    tbody.innerHTML = lista.length ? '' : '<tr><td colspan="5">Nenhum acesso nessa data.</td></tr>';
    lista.forEach((a) => {
      const nomeCel = a.aluno_id
        ? `<span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${a.aluno_nome}</span>`
        : (a.aluno_nome || '—');
      const trDiario = el(`
        <tr>
          <td>${parseDataHoraServidor(a.criado_em).toLocaleTimeString('pt-BR')}</td>
          <td>${nomeCel}</td>
          <td>${a.metodo}</td>
          <td><span class="badge ${a.resultado === 'liberado' ? 'ativo' : 'inadimplente'}">${a.resultado}</span></td>
          <td>${a.mensagem || '—'}</td>
        </tr>
      `);
      trDiario.querySelector('.nome-clicavel')?.addEventListener('click', () => abrirPerfilAluno(a.aluno_id));
      tbody.appendChild(trDiario);
    });
  } catch (err) { mostrarToast(err.message, true); }
}
document.getElementById('btn-rel-diario-buscar').addEventListener('click', buscarRelatorioAcessoDiario);

// ---- Relatório: Acesso Pessoal (histórico de um aluno específico) ----
async function buscarRelatorioAcessoPessoal() {
  const alunoId = document.getElementById('rel-pessoal-aluno').value;
  const tbody = document.getElementById('rel-pessoal-lista');
  if (!alunoId) {
    tbody.innerHTML = '<tr><td colspan="4">Selecione um aluno.</td></tr>';
    return;
  }
  try {
    const params = new URLSearchParams({ aluno_id: alunoId });
    const de = document.getElementById('rel-pessoal-de').value;
    const ate = document.getElementById('rel-pessoal-ate').value;
    if (de) params.set('data_inicio', de);
    if (ate) params.set('data_fim', ate);

    const lista = await api(`/api/terminal/acessos?${params.toString()}`);
    tbody.innerHTML = lista.length ? '' : '<tr><td colspan="4">Nenhum acesso no período.</td></tr>';
    lista.forEach((a) => {
      tbody.appendChild(el(`
        <tr>
          <td>${parseDataHoraServidor(a.criado_em).toLocaleString('pt-BR')}</td>
          <td>${a.metodo}</td>
          <td><span class="badge ${a.resultado === 'liberado' ? 'ativo' : 'inadimplente'}">${a.resultado}</span></td>
          <td>${a.mensagem || '—'}</td>
        </tr>
      `));
    });
  } catch (err) { mostrarToast(err.message, true); }
}
document.getElementById('btn-rel-pessoal-buscar').addEventListener('click', buscarRelatorioAcessoPessoal);
document.getElementById('rel-pessoal-aluno').addEventListener('change', buscarRelatorioAcessoPessoal);
document.getElementById('rel-pessoal-mostrar-inativos').addEventListener('change', async (ev) => {
  const select = document.getElementById('rel-pessoal-aluno');
  await popularSelectAlunos(select, { incluirInativos: ev.target.checked, comPlaceholder: true });
  await buscarRelatorioAcessoPessoal();
});

// ---- Relatório: Último Acesso (um registro por aluno) ----
async function buscarRelatorioUltimoAcesso() {
  try {
    const params = new URLSearchParams();
    const de = document.getElementById('rel-ultimo-de').value;
    const ate = document.getElementById('rel-ultimo-ate').value;
    const busca = document.getElementById('rel-ultimo-busca').value.trim();
    const mostrarInativos = document.getElementById('rel-ultimo-mostrar-inativos').checked;
    if (de) params.set('data_inicio', de);
    if (ate) params.set('data_fim', ate);
    if (busca) params.set('busca', busca);
    if (mostrarInativos) params.set('incluir_inativos', 'true');

    const lista = await api(`/api/terminal/acessos/ultimo-por-aluno${params.toString() ? '?' + params.toString() : ''}`);
    const tbody = document.getElementById('rel-ultimo-lista');
    tbody.innerHTML = lista.length ? '' : '<tr><td colspan="2">Nenhum acesso encontrado.</td></tr>';
    lista.forEach((a) => {
      const trUltimo = el(`
        <tr>
          <td><span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${a.aluno_nome}</span></td>
          <td>${parseDataHoraServidor(a.ultimo_acesso).toLocaleString('pt-BR')}</td>
        </tr>
      `);
      trUltimo.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(a.aluno_id));
      tbody.appendChild(trUltimo);
    });
  } catch (err) { mostrarToast(err.message, true); }
}
document.getElementById('btn-rel-ultimo-buscar').addEventListener('click', buscarRelatorioUltimoAcesso);
document.getElementById('rel-ultimo-mostrar-inativos').addEventListener('change', buscarRelatorioUltimoAcesso);

// ---- Relatório: Pessoas (dados cadastrais básicos, pra achar cadastro incompleto) ----
// Não é um relatório financeiro nem de acesso — reaproveita GET /api/alunos (que já
// devolve todas as colunas) só pra dar uma visão rápida de quem está faltando CPF,
// telefone, e-mail ou biometria, sem precisar abrir o perfil de cada aluno um por um.
async function buscarRelatorioPessoas() {
  try {
    const busca = document.getElementById('rel-pessoas-busca').value.trim();
    const mostrarInativos = document.getElementById('rel-pessoas-mostrar-inativos').checked;
    const soIncompletos = document.getElementById('rel-pessoas-so-incompletos').checked;
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    if (mostrarInativos) params.set('incluir_inativos', 'true');

    const alunosBrutos = await api(`/api/alunos${params.toString() ? '?' + params.toString() : ''}`);
    const alunos = [...alunosBrutos].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const tbody = document.getElementById('rel-pessoas-lista');
    const resumoEl = document.getElementById('rel-pessoas-total');

    const CAMPOS = [
      { chave: 'biometria_id', rotulo: 'Biometria' },
      { chave: 'cpf', rotulo: 'CPF' },
      { chave: 'telefone', rotulo: 'Telefone' },
      { chave: 'email', rotulo: 'E-mail' },
    ];
    const celulaCampo = (valor) => (valor
      ? valor
      : '<span style="color:#c2410c;font-weight:600">— faltando</span>');

    let linhas = alunos.map((a) => {
      const faltando = CAMPOS.filter((c) => !a[c.chave]).map((c) => c.rotulo);
      return { aluno: a, faltando };
    });
    if (soIncompletos) linhas = linhas.filter((l) => l.faltando.length > 0);

    tbody.innerHTML = linhas.length ? '' : '<tr><td colspan="7">Nenhuma pessoa encontrada.</td></tr>';
    let totalIncompletos = 0;
    linhas.forEach(({ aluno: a, faltando }) => {
      if (faltando.length) totalIncompletos += 1;
      const trPessoa = el(`
        <tr>
          <td><span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${a.nome}</span></td>
          <td>${celulaCampo(a.biometria_id)}</td>
          <td>${celulaCampo(a.cpf)}</td>
          <td>${celulaCampo(a.telefone)}</td>
          <td>${celulaCampo(a.email)}</td>
          <td><span class="badge ${a.status}">${a.status}</span></td>
          <td>${faltando.length ? `<span style="color:#c2410c;font-weight:600">${faltando.join(', ')}</span>` : '<span style="color:#15803d">Completo</span>'}</td>
        </tr>
      `);
      trPessoa.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(a.id));
      tbody.appendChild(trPessoa);
    });

    resumoEl.textContent = linhas.length
      ? `${linhas.length} pessoa(s) — ${totalIncompletos} com cadastro incompleto`
      : '';
  } catch (err) { mostrarToast(err.message, true); }
}
document.getElementById('btn-rel-pessoas-buscar').addEventListener('click', buscarRelatorioPessoas);
document.getElementById('rel-pessoas-mostrar-inativos').addEventListener('change', buscarRelatorioPessoas);
document.getElementById('rel-pessoas-so-incompletos').addEventListener('change', buscarRelatorioPessoas);

// ---------------- Painel lateral "Acessos recentes" (persiste entre abas) ----------------
// Reaproveita o mesmo endpoint /api/terminal/acessos usado na aba Catraca. O painel fica
// fora das <section class="secao">, então trocar de aba não fecha ele; só o botão de X fecha.

let acessosRecentesTimer = null;

function formatarTipoAcesso(a) {
  if (a.resultado === 'liberado') return '<span class="badge ativo">Liberado</span>';
  return `<span class="badge inadimplente">${a.mensagem && /venc/i.test(a.mensagem) ? 'Vencido' : 'Negado'}</span>`;
}

async function carregarAcessosRecentes() {
  try {
    const lista = await api('/api/terminal/acessos');
    const tbody = document.getElementById('lista-acessos-recentes');
    tbody.innerHTML = lista.length ? '' : '<tr><td colspan="4">Nenhum acesso registrado ainda.</td></tr>';
    lista.forEach((a) => {
      const quando = parseDataHoraServidor(a.criado_em);
      const nomeCel = a.aluno_id
        ? `<span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${a.aluno_nome}</span>`
        : (a.aluno_nome || '—');
      const tr = el(`
        <tr>
          <td>${quando.toLocaleDateString('pt-BR')}</td>
          <td>${quando.toLocaleTimeString('pt-BR')}</td>
          <td>${nomeCel}</td>
          <td>${formatarTipoAcesso(a)}</td>
        </tr>
      `);
      tr.querySelector('.nome-clicavel')?.addEventListener('click', () => abrirPerfilAluno(a.aluno_id));
      tbody.appendChild(tr);
    });
  } catch (err) {
    // Silencioso: esse painel pode ficar aberto em qualquer aba, não queremos
    // toasts repetidos de erro a cada atualização automática.
  }
}

function abrirPainelAcessos() {
  document.getElementById('painel-acessos').classList.remove('oculto');
  document.getElementById('painel-acessos').classList.remove('janela-flutuante-minimizada');
  carregarAcessosRecentes();
  clearInterval(acessosRecentesTimer);
  acessosRecentesTimer = setInterval(carregarAcessosRecentes, 8000);
}

function fecharPainelAcessos() {
  document.getElementById('painel-acessos').classList.add('oculto');
  clearInterval(acessosRecentesTimer);
  acessosRecentesTimer = null;
}

document.getElementById('btn-acessos-recentes').addEventListener('click', () => {
  const painel = document.getElementById('painel-acessos');
  if (!painel.classList.contains('oculto')) fecharPainelAcessos();
  else abrirPainelAcessos();
});
document.getElementById('btn-fechar-acessos').addEventListener('click', fecharPainelAcessos);

// ---------------- Recuperação de clientes / prevenção de evasão (2026-07) ----------------
// Ver STATUS-PROJETO.md e src/routes/recuperacao.routes.js. Cobre: lista de
// "dias sem acesso" (quem sumiu), aniversariantes do mês (calendário + lista),
// modelos de mensagem reutilizáveis, envio por e-mail (Gmail SMTP) ou geração
// de link do WhatsApp (SEMPRE manual — o admin clica e manda ele mesmo, nunca
// dispara sozinho) e concessão opcional de acesso especial/gratuito (dias
// grátis) junto do envio.

const recupEstado = {
  diasSelecionados: new Set(),
  diasCache: new Map(), // aluno_id -> linha (evita nova requisição só pra montar a prévia)
  anivSelecionados: new Set(),
  anivCache: new Map(),
  anivMesAtual: new Date().getMonth() + 1,
  anivDiaFiltro: null,
  templates: [],
  enviarContexto: null, // { alunoIds: [...], origem: 'dias' | 'aniversariantes' }
  emailConfigurado: false,
};

async function carregarSecaoRecuperacao() {
  trocarAbaRecuperacao('dias-sem-acesso');
  try {
    const status = await api('/api/recuperacao/status');
    recupEstado.emailConfigurado = Boolean(status?.email_configurado);
  } catch (err) { /* não trava a tela — o composer avisa de novo na hora de enviar */ }
  await carregarRecupTemplates();
  await carregarDiasSemAcesso();
  verificarAniversariantesHoje();
}

document.querySelectorAll('.recup-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => trocarAbaRecuperacao(btn.dataset.recup));
});

function trocarAbaRecuperacao(nome) {
  document.querySelectorAll('.recup-tab-btn').forEach((b) => b.classList.toggle('ativo', b.dataset.recup === nome));
  document.querySelectorAll('.recup-painel').forEach((p) => p.classList.toggle('oculto', p.dataset.recupPainel !== nome));
  if (nome === 'dias-sem-acesso') carregarDiasSemAcesso();
  if (nome === 'aniversariantes') carregarAniversariantes();
  if (nome === 'templates') carregarRecupTemplates();
  if (nome === 'historico') carregarRecupHistorico();
}

// ---------- Dias sem acesso ----------

async function carregarDiasSemAcesso() {
  try {
    const busca = document.getElementById('recup-dias-busca').value.trim();
    const diasMinimo = document.getElementById('recup-dias-minimo').value;
    const mostrarInativos = document.getElementById('recup-dias-mostrar-inativos').checked;
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    if (diasMinimo) params.set('dias_minimo', diasMinimo);
    if (mostrarInativos) params.set('incluir_inativos', 'true');

    const linhas = await api(`/api/recuperacao/dias-sem-acesso${params.toString() ? `?${params.toString()}` : ''}`);
    recupEstado.diasCache.clear();
    recupEstado.diasSelecionados.clear();
    atualizarBotaoEnviarSelecionadosDias();
    document.getElementById('recup-dias-selecionar-todos').checked = false;

    const tbody = document.getElementById('recup-dias-lista');
    tbody.innerHTML = '';
    if (!linhas.length) {
      tbody.innerHTML = '<tr><td colspan="5">Nenhum aluno encontrado com esse filtro.</td></tr>';
      document.getElementById('recup-dias-total').textContent = '';
      return;
    }

    linhas.forEach((linha) => {
      recupEstado.diasCache.set(linha.aluno_id, linha);
      const statusTexto = linha.nunca_acessou
        ? 'Nunca acessou'
        : `${linha.dias_sem_acesso} dia${linha.dias_sem_acesso === 1 ? '' : 's'} sem acesso`;
      const risco = linha.em_atraso && (linha.dias_sem_acesso === null || linha.dias_sem_acesso >= 15);
      const tr = el(`
        <tr style="${risco ? 'background:#fff7ed' : ''}">
          <td><input type="checkbox" class="recup-dias-check" style="width:auto" /></td>
          <td>
            <span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${linha.nome}</span>${risco ? ' ⚠️' : ''}
            ${linha.concessao_ativa ? ' <span class="badge ativo" title="Já tem acesso especial ativo">acesso grátis ativo</span>' : ''}
          </td>
          <td>${statusTexto}</td>
          <td>
            ${linha.em_atraso ? '<span class="badge atrasado">Em atraso</span>' : ''}
            ${linha.status !== 'ativo' ? `<span class="badge ${linha.status}">${linha.status}</span>` : ''}
          </td>
          <td>
            <button type="button" class="btn-linha" data-acao="enviar">Enviar mensagem</button>
            <button type="button" class="btn-linha" data-acao="conceder">Conceder acesso</button>
          </td>
        </tr>
      `);
      tr.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(linha.aluno_id));
      tr.querySelector('.recup-dias-check').addEventListener('change', (ev) => {
        if (ev.target.checked) recupEstado.diasSelecionados.add(linha.aluno_id);
        else recupEstado.diasSelecionados.delete(linha.aluno_id);
        atualizarBotaoEnviarSelecionadosDias();
      });
      tr.querySelector('[data-acao="enviar"]').addEventListener('click', () => abrirModalRecupEnviar([linha.aluno_id], 'dias'));
      tr.querySelector('[data-acao="conceder"]').addEventListener('click', async () => {
        const diasStr = prompt('Quantos dias de acesso especial conceder?', '5');
        if (diasStr === null) return;
        const dias = Number(diasStr);
        if (!Number.isInteger(dias) || dias < 1 || dias > 90) { mostrarToast('Informe um número inteiro de dias entre 1 e 90.', true); return; }
        const motivo = prompt('Motivo (opcional, aparece no histórico):', 'Recuperação de cliente');
        if (!confirmar(`Conceder ${dias} dia(s) de acesso especial para ${linha.nome}, liberando a catraca mesmo com mensalidade em atraso?`)) return;
        try {
          await api('/api/recuperacao/conceder-acesso', { method: 'POST', body: JSON.stringify({ aluno_id: linha.aluno_id, dias, motivo: motivo || null }) });
          mostrarToast('Acesso especial concedido.');
          carregarDiasSemAcesso();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });

    document.getElementById('recup-dias-total').textContent = `${linhas.length} aluno(s) encontrado(s).`;
  } catch (err) { mostrarToast(err.message, true); }
}

function atualizarBotaoEnviarSelecionadosDias() {
  const n = recupEstado.diasSelecionados.size;
  document.getElementById('btn-recup-dias-enviar-selecionados').disabled = n === 0;
  document.getElementById('recup-dias-selecionados-contagem').textContent = n ? `${n} selecionado(s)` : '';
}

document.getElementById('btn-recup-dias-buscar').addEventListener('click', carregarDiasSemAcesso);
document.getElementById('recup-dias-busca').addEventListener('input', () => {
  clearTimeout(carregarDiasSemAcesso._t);
  carregarDiasSemAcesso._t = setTimeout(carregarDiasSemAcesso, 400);
});
document.getElementById('recup-dias-minimo').addEventListener('change', carregarDiasSemAcesso);
document.getElementById('recup-dias-mostrar-inativos').addEventListener('change', carregarDiasSemAcesso);
document.getElementById('recup-dias-selecionar-todos').addEventListener('change', (ev) => {
  document.querySelectorAll('.recup-dias-check').forEach((chk) => {
    chk.checked = ev.target.checked;
    chk.dispatchEvent(new Event('change'));
  });
});
document.getElementById('btn-recup-dias-enviar-selecionados').addEventListener('click', () => {
  abrirModalRecupEnviar([...recupEstado.diasSelecionados], 'dias');
});

// ---------- Aniversariantes ----------

const NOMES_MESES_RECUP = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function popularSelectMesAniversario() {
  const select = document.getElementById('recup-aniv-mes');
  if (select.options.length) return;
  select.innerHTML = NOMES_MESES_RECUP.map((nome, idx) => `<option value="${idx + 1}">${nome}</option>`).join('');
  select.value = String(new Date().getMonth() + 1);
}

async function carregarAniversariantes() {
  try {
    popularSelectMesAniversario();
    const mes = document.getElementById('recup-aniv-mes').value || String(new Date().getMonth() + 1);
    const mostrarInativos = document.getElementById('recup-aniv-mostrar-inativos').checked;
    recupEstado.anivMesAtual = Number(mes);
    const params = new URLSearchParams({ mes });
    if (mostrarInativos) params.set('incluir_inativos', 'true');

    const linhas = await api(`/api/recuperacao/aniversariantes?${params.toString()}`);
    recupEstado.anivCache.clear();
    linhas.forEach((l) => recupEstado.anivCache.set(l.aluno_id, l));
    recupEstado.anivSelecionados.clear();
    atualizarBotaoEnviarSelecionadosAniv();

    renderizarCalendarioAniversariantes(linhas);
    renderizarListaAniversariantes(linhas);
  } catch (err) { mostrarToast(err.message, true); }
}

function diasNoMesRecup(mes, ano) {
  return new Date(ano, mes, 0).getDate();
}

function renderizarCalendarioAniversariantes(linhas) {
  const container = document.getElementById('recup-aniv-calendario');
  container.innerHTML = '';
  const ano = new Date().getFullYear();
  const totalDias = diasNoMesRecup(recupEstado.anivMesAtual, ano);
  // Quantas células vazias antes do dia 1, pra alinhar com o dia da semana certo (0=domingo).
  const primeiroDiaSemana = new Date(ano, recupEstado.anivMesAtual - 1, 1).getDay();

  const porDia = new Map();
  linhas.forEach((l) => {
    if (!porDia.has(l.dia_aniversario)) porDia.set(l.dia_aniversario, []);
    porDia.get(l.dia_aniversario).push(l);
  });

  for (let i = 0; i < primeiroDiaSemana; i += 1) {
    container.appendChild(el('<div class="recup-aniv-dia vazio">-</div>'));
  }

  for (let dia = 1; dia <= totalDias; dia += 1) {
    const nomesDoDia = porDia.get(dia) || [];
    const celula = el(`
      <div class="recup-aniv-dia ${nomesDoDia.length ? 'tem-aniversariante' : ''}">
        <span class="recup-aniv-dia-num">${dia}</span>
        <span class="recup-aniv-dia-nomes">${nomesDoDia.slice(0, 2).map((n) => n.nome.split(' ')[0]).join(', ')}${nomesDoDia.length > 2 ? ` +${nomesDoDia.length - 2}` : ''}</span>
      </div>
    `);
    if (recupEstado.anivDiaFiltro === dia) celula.classList.add('selecionado');
    celula.addEventListener('click', () => {
      recupEstado.anivDiaFiltro = recupEstado.anivDiaFiltro === dia ? null : dia;
      renderizarCalendarioAniversariantes(linhas);
      renderizarListaAniversariantes(linhas);
    });
    container.appendChild(celula);
  }
}

function renderizarListaAniversariantes(linhas) {
  const tbody = document.getElementById('recup-aniv-lista');
  tbody.innerHTML = '';
  const filtradas = recupEstado.anivDiaFiltro
    ? linhas.filter((l) => l.dia_aniversario === recupEstado.anivDiaFiltro)
    : linhas;

  document.getElementById('recup-aniv-filtro-dia-label').textContent = recupEstado.anivDiaFiltro
    ? `Mostrando dia ${recupEstado.anivDiaFiltro} (clique de novo no dia pra ver o mês inteiro)`
    : `${linhas.length} aniversariante(s) em ${NOMES_MESES_RECUP[recupEstado.anivMesAtual - 1]}`;

  if (!filtradas.length) {
    tbody.innerHTML = '<tr><td colspan="5">Nenhum aniversariante encontrado.</td></tr>';
    return;
  }

  filtradas.forEach((linha) => {
    const tr = el(`
      <tr>
        <td><input type="checkbox" class="recup-aniv-check" style="width:auto" /></td>
        <td>${linha.dia_aniversario}/${String(recupEstado.anivMesAtual).padStart(2, '0')}</td>
        <td><span class="nome-clicavel" style="cursor:pointer;color:#1d4ed8;text-decoration:underline">${linha.nome}</span></td>
        <td>${linha.telefone || '—'}</td>
        <td>${linha.email || '—'}</td>
      </tr>
    `);
    tr.querySelector('.nome-clicavel').addEventListener('click', () => abrirPerfilAluno(linha.aluno_id));
    tr.querySelector('.recup-aniv-check').addEventListener('change', (ev) => {
      if (ev.target.checked) recupEstado.anivSelecionados.add(linha.aluno_id);
      else recupEstado.anivSelecionados.delete(linha.aluno_id);
      atualizarBotaoEnviarSelecionadosAniv();
    });
    tbody.appendChild(tr);
  });
}

function atualizarBotaoEnviarSelecionadosAniv() {
  document.getElementById('btn-recup-aniv-enviar-selecionados').disabled = recupEstado.anivSelecionados.size === 0;
}

document.getElementById('btn-recup-aniv-buscar').addEventListener('click', () => { recupEstado.anivDiaFiltro = null; carregarAniversariantes(); });
document.getElementById('recup-aniv-mostrar-inativos').addEventListener('change', carregarAniversariantes);
document.getElementById('btn-recup-aniv-enviar-selecionados').addEventListener('click', () => {
  abrirModalRecupEnviar([...recupEstado.anivSelecionados], 'aniversariantes');
});

// Roda logo após o login (ver mostrarApp) — busca só os aniversariantes de
// HOJE (mês + dia) pra mostrar o aviso no topo da seção e, na primeira
// checagem da sessão, um toast — sem precisar abrir a aba Aniversariantes.
async function verificarAniversariantesHoje(mostrarAvisoToast = false) {
  try {
    const hoje = new Date();
    const params = new URLSearchParams({ mes: String(hoje.getMonth() + 1), dia: String(hoje.getDate()) });
    const linhas = await api(`/api/recuperacao/aniversariantes?${params.toString()}`);
    const badge = document.getElementById('recup-aviso-aniversariantes-hoje');
    if (linhas.length) {
      const nomes = linhas.map((l) => l.nome.split(' ')[0]).join(', ');
      badge.textContent = `🎂 ${linhas.length} aniversariante(s) hoje: ${nomes}`;
      badge.classList.remove('oculto');
      if (mostrarAvisoToast) mostrarToast(`🎂 Hoje é aniversário de ${nomes}!`);
    } else {
      badge.classList.add('oculto');
    }
  } catch (err) { /* aviso não pode travar a tela */ }
}

// ---------- Modelos de mensagem ----------

async function carregarRecupTemplates() {
  try {
    const templates = await api('/api/recuperacao/templates');
    recupEstado.templates = templates;

    const tbody = document.getElementById('recup-templates-lista');
    tbody.innerHTML = '';
    if (!templates.length) {
      tbody.innerHTML = '<tr><td colspan="5">Nenhum modelo cadastrado ainda.</td></tr>';
    } else {
      const labelLink = { portal: 'Acesso do aluno', oferta: 'Personalizado', nenhum: 'Sem link' };
      templates.forEach((t) => {
        const tr = el(`
          <tr>
            <td>${t.nome}</td>
            <td>${labelLink[t.link_tipo] || t.link_tipo}</td>
            <td>${t.conceder_dias_gratis ? `${t.conceder_dias_gratis} dia(s)` : '—'}</td>
            <td><span class="badge ${t.ativo ? 'ativo' : 'inativo'}">${t.ativo ? 'Ativo' : 'Inativo'}</span></td>
            <td><button type="button" class="btn-linha" data-acao="editar">Editar</button></td>
          </tr>
        `);
        tr.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirModalRecupTemplate(t));
        tbody.appendChild(tr);
      });
    }

    // Popula o <select> de modelos usado no composer de envio, preservando a escolha atual.
    const selectEnviar = document.getElementById('recup-enviar-template');
    const atual = selectEnviar.value;
    selectEnviar.innerHTML = `<option value="">Escrever mensagem manualmente</option>${
      templates.filter((t) => t.ativo).map((t) => `<option value="${t.id}">${t.nome}</option>`).join('')}`;
    selectEnviar.value = atual;
  } catch (err) { mostrarToast(err.message, true); }
}

function abrirModalRecupTemplate(template) {
  document.getElementById('form-recup-template').reset();
  document.getElementById('rtpl-id').value = template?.id || '';
  document.getElementById('recup-template-titulo').textContent = template ? 'Editar modelo' : 'Novo modelo';
  document.getElementById('rtpl-nome').value = template?.nome || '';
  document.getElementById('rtpl-saudacao').value = template?.saudacao || 'Olá {nome}!';
  document.getElementById('rtpl-corpo').value = template?.corpo || '';
  document.getElementById('rtpl-link-tipo').value = template?.link_tipo || 'portal';
  document.getElementById('rtpl-link-oferta-texto').value = template?.link_oferta_texto || '';
  document.getElementById('rtpl-link-oferta-url').value = template?.link_oferta_url || '';
  document.getElementById('rtpl-oferta-campos').classList.toggle('oculto', (template?.link_tipo || 'portal') !== 'oferta');
  document.getElementById('rtpl-conceder-check').checked = Boolean(template?.conceder_dias_gratis);
  document.getElementById('rtpl-conceder-dias').value = template?.conceder_dias_gratis || 5;
  document.getElementById('rtpl-conceder-campos').classList.toggle('oculto', !template?.conceder_dias_gratis);
  document.getElementById('rtpl-ativo').checked = template ? Boolean(template.ativo) : true;
  document.getElementById('btn-excluir-recup-template').classList.toggle('oculto', !template);
  document.getElementById('modal-recup-template').classList.remove('oculto');
}

document.getElementById('btn-novo-recup-template').addEventListener('click', () => abrirModalRecupTemplate(null));
document.getElementById('btn-fechar-modal-recup-template').addEventListener('click', () => {
  document.getElementById('modal-recup-template').classList.add('oculto');
});
document.getElementById('rtpl-link-tipo').addEventListener('change', (ev) => {
  document.getElementById('rtpl-oferta-campos').classList.toggle('oculto', ev.target.value !== 'oferta');
});
document.getElementById('rtpl-conceder-check').addEventListener('change', (ev) => {
  document.getElementById('rtpl-conceder-campos').classList.toggle('oculto', !ev.target.checked);
});

document.getElementById('form-recup-template').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = document.getElementById('rtpl-id').value;
  const payload = {
    nome: document.getElementById('rtpl-nome').value.trim(),
    saudacao: document.getElementById('rtpl-saudacao').value.trim() || 'Olá {nome}!',
    corpo: document.getElementById('rtpl-corpo').value.trim(),
    link_tipo: document.getElementById('rtpl-link-tipo').value,
    link_oferta_texto: document.getElementById('rtpl-link-oferta-texto').value.trim() || null,
    link_oferta_url: document.getElementById('rtpl-link-oferta-url').value.trim() || null,
    conceder_dias_gratis: document.getElementById('rtpl-conceder-check').checked
      ? Number(document.getElementById('rtpl-conceder-dias').value) : null,
    ativo: document.getElementById('rtpl-ativo').checked,
  };
  try {
    if (id) await api(`/api/recuperacao/templates/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/recuperacao/templates', { method: 'POST', body: JSON.stringify(payload) });
    mostrarToast('Modelo salvo.');
    document.getElementById('modal-recup-template').classList.add('oculto');
    carregarRecupTemplates();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-excluir-recup-template').addEventListener('click', async () => {
  const id = document.getElementById('rtpl-id').value;
  if (!id || !confirmar('Excluir este modelo de mensagem?')) return;
  try {
    await api(`/api/recuperacao/templates/${id}`, { method: 'DELETE' });
    mostrarToast('Modelo excluído.');
    document.getElementById('modal-recup-template').classList.add('oculto');
    carregarRecupTemplates();
  } catch (err) { mostrarToast(err.message, true); }
});

// ---------- Envio de mensagens (composer: e-mail real | link do WhatsApp manual) ----------

function primeiroNomeRecup(nomeCompleto) {
  return String(nomeCompleto || '').trim().split(/\s+/)[0] || nomeCompleto;
}

// Réplica simplificada do que o servidor monta de verdade (ver montarMensagem
// em src/routes/recuperacao.routes.js) — só pra dar uma prévia razoável antes
// de enviar. O texto final enviado é sempre montado no backend.
function montarPreviaMensagemRecup({
  nome, saudacao, corpo, linkTipo, linkOfertaUrl, linkOfertaTexto, codigoAcesso,
}) {
  const saudacaoFinal = String(saudacao || 'Olá {nome}!').replace(/\{nome\}/g, primeiroNomeRecup(nome));
  let linkLinha = '';
  if (linkTipo === 'portal') {
    linkLinha = codigoAcesso ? `${window.location.origin}/meu-acesso.html?codigo=${codigoAcesso}` : `${window.location.origin}/portal.html`;
  } else if (linkTipo === 'oferta' && linkOfertaUrl) {
    linkLinha = linkOfertaTexto ? `${linkOfertaTexto}: ${linkOfertaUrl}` : linkOfertaUrl;
  }
  return [saudacaoFinal, corpo || ''].filter(Boolean).concat(linkLinha ? [linkLinha] : []).join('\n\n');
}

function obterAlunoParaPreviaRecup(alunoId) {
  return recupEstado.diasCache.get(alunoId) || recupEstado.anivCache.get(alunoId) || null;
}

function abrirModalRecupEnviar(alunoIds, origem) {
  if (!alunoIds.length) { mostrarToast('Selecione ao menos um aluno.', true); return; }
  recupEstado.enviarContexto = { alunoIds, origem };

  const nomes = alunoIds.map((id) => obterAlunoParaPreviaRecup(id)?.nome || id);
  document.getElementById('recup-enviar-destinatarios').textContent = alunoIds.length === 1
    ? `Para: ${nomes[0]}`
    : `Para ${alunoIds.length} alunos: ${nomes.slice(0, 4).join(', ')}${nomes.length > 4 ? '...' : ''}`;

  document.querySelector('input[name="recup-enviar-canal"][value="whatsapp"]').checked = true;
  document.getElementById('recup-enviar-template').value = '';
  document.getElementById('recup-enviar-saudacao').value = 'Olá {nome}!';
  document.getElementById('recup-enviar-assunto').value = 'Sentimos sua falta na Academia Superação!';
  document.getElementById('recup-enviar-corpo').value = '';
  document.getElementById('recup-enviar-link-tipo').value = 'portal';
  document.getElementById('recup-enviar-oferta-campos').classList.add('oculto');
  document.getElementById('recup-enviar-link-oferta-texto').value = '';
  document.getElementById('recup-enviar-link-oferta-url').value = '';
  document.getElementById('recup-enviar-conceder-check').checked = false;
  document.getElementById('recup-enviar-conceder-campos').classList.add('oculto');
  document.getElementById('recup-enviar-conceder-dias').value = 5;
  document.getElementById('recup-enviar-resultado').innerHTML = '';

  atualizarDisponibilidadeCanalEmail();
  atualizarPreviaRecupEnviar();
  document.getElementById('modal-recup-enviar').classList.remove('oculto');
}

document.getElementById('btn-fechar-modal-recup-enviar').addEventListener('click', () => {
  document.getElementById('modal-recup-enviar').classList.add('oculto');
});

function atualizarDisponibilidadeCanalEmail() {
  const radioEmail = document.querySelector('input[name="recup-enviar-canal"][value="email"]');
  const aviso = document.getElementById('recup-enviar-email-indisponivel');
  radioEmail.disabled = !recupEstado.emailConfigurado;
  aviso.classList.toggle('oculto', recupEstado.emailConfigurado);
  if (!recupEstado.emailConfigurado && radioEmail.checked) {
    document.querySelector('input[name="recup-enviar-canal"][value="whatsapp"]').checked = true;
  }
}

document.getElementById('recup-enviar-template').addEventListener('change', (ev) => {
  const template = recupEstado.templates.find((t) => t.id === ev.target.value);
  if (!template) { atualizarPreviaRecupEnviar(); return; }
  document.getElementById('recup-enviar-saudacao').value = template.saudacao || 'Olá {nome}!';
  document.getElementById('recup-enviar-corpo').value = template.corpo || '';
  document.getElementById('recup-enviar-link-tipo').value = template.link_tipo || 'portal';
  document.getElementById('recup-enviar-oferta-campos').classList.toggle('oculto', template.link_tipo !== 'oferta');
  document.getElementById('recup-enviar-link-oferta-texto').value = template.link_oferta_texto || '';
  document.getElementById('recup-enviar-link-oferta-url').value = template.link_oferta_url || '';
  document.getElementById('recup-enviar-conceder-check').checked = Boolean(template.conceder_dias_gratis);
  document.getElementById('recup-enviar-conceder-campos').classList.toggle('oculto', !template.conceder_dias_gratis);
  if (template.conceder_dias_gratis) document.getElementById('recup-enviar-conceder-dias').value = template.conceder_dias_gratis;
  atualizarPreviaRecupEnviar();
});

document.getElementById('recup-enviar-link-tipo').addEventListener('change', (ev) => {
  document.getElementById('recup-enviar-oferta-campos').classList.toggle('oculto', ev.target.value !== 'oferta');
  atualizarPreviaRecupEnviar();
});
document.getElementById('recup-enviar-conceder-check').addEventListener('change', (ev) => {
  document.getElementById('recup-enviar-conceder-campos').classList.toggle('oculto', !ev.target.checked);
});
['recup-enviar-saudacao', 'recup-enviar-corpo', 'recup-enviar-link-oferta-texto', 'recup-enviar-link-oferta-url'].forEach((id) => {
  document.getElementById(id).addEventListener('input', atualizarPreviaRecupEnviar);
});

function atualizarPreviaRecupEnviar() {
  const ctx = recupEstado.enviarContexto;
  if (!ctx || !ctx.alunoIds.length) return;
  const aluno = obterAlunoParaPreviaRecup(ctx.alunoIds[0]);
  const texto = montarPreviaMensagemRecup({
    nome: aluno?.nome || 'Aluno',
    saudacao: document.getElementById('recup-enviar-saudacao').value,
    corpo: document.getElementById('recup-enviar-corpo').value,
    linkTipo: document.getElementById('recup-enviar-link-tipo').value,
    linkOfertaUrl: document.getElementById('recup-enviar-link-oferta-url').value,
    linkOfertaTexto: document.getElementById('recup-enviar-link-oferta-texto').value,
    codigoAcesso: aluno?.codigo_acesso,
  });
  document.getElementById('recup-enviar-preview').textContent = texto;
}

document.getElementById('btn-recup-enviar-confirmar').addEventListener('click', async () => {
  const ctx = recupEstado.enviarContexto;
  if (!ctx) return;
  const canal = document.querySelector('input[name="recup-enviar-canal"]:checked').value;
  const corpo = document.getElementById('recup-enviar-corpo').value.trim();
  if (!corpo && !document.getElementById('recup-enviar-template').value) {
    mostrarToast('Escreva o corpo da mensagem ou escolha um modelo.', true);
    return;
  }
  const concederCheck = document.getElementById('recup-enviar-conceder-check').checked;
  if (concederCheck) {
    const dias = document.getElementById('recup-enviar-conceder-dias').value;
    if (!confirmar(`Isso também vai liberar ${dias} dia(s) de acesso especial para ${ctx.alunoIds.length} aluno(s), mesmo com mensalidade em atraso. Confirmar?`)) return;
  }

  const payload = {
    aluno_ids: ctx.alunoIds,
    canal,
    template_id: document.getElementById('recup-enviar-template').value || null,
    saudacao: document.getElementById('recup-enviar-saudacao').value || null,
    corpo: corpo || null,
    assunto: document.getElementById('recup-enviar-assunto').value || null,
    link_tipo: document.getElementById('recup-enviar-link-tipo').value,
    link_oferta_url: document.getElementById('recup-enviar-link-oferta-url').value || null,
    link_oferta_texto: document.getElementById('recup-enviar-link-oferta-texto').value || null,
    conceder_dias_gratis: concederCheck ? Number(document.getElementById('recup-enviar-conceder-dias').value) : null,
  };

  try {
    const resp = await api('/api/recuperacao/enviar', { method: 'POST', body: JSON.stringify(payload) });
    renderizarResultadoEnvioRecup(resp);
    if (ctx.origem === 'dias') carregarDiasSemAcesso();
    if (ctx.origem === 'aniversariantes') carregarAniversariantes();
  } catch (err) { mostrarToast(err.message, true); }
});

function renderizarResultadoEnvioRecup(resp) {
  const container = document.getElementById('recup-enviar-resultado');
  container.innerHTML = '';
  const sucesso = resp.resultados.filter((r) => r.ok).length;
  const falhas = resp.resultados.length - sucesso;
  container.appendChild(el(`
    <p style="font-weight:600;margin:0 0 10px">
      ${sucesso} de ${resp.resultados.length} processado(s) com sucesso${falhas ? `, ${falhas} com erro` : ''}.
      ${resp.concessoes_criadas.length ? ` ${resp.concessoes_criadas.length} concessão(ões) de acesso especial criada(s).` : ''}
    </p>
  `));

  resp.resultados.forEach((r) => {
    if (r.canal === 'whatsapp' && r.ok && r.link) {
      const linha = el(`
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f2f4f7">
          <span style="flex:1;font-size:13px">${r.nome}</span>
          <button type="button" class="btn-secundario">Abrir WhatsApp</button>
        </div>
      `);
      linha.querySelector('button').addEventListener('click', () => window.open(r.link, '_blank', 'noopener'));
      container.appendChild(linha);
    } else if (!r.ok) {
      container.appendChild(el(`<div style="font-size:13px;color:#d92d20;padding:4px 0">${r.nome || r.aluno_id}: ${r.erro}</div>`));
    } else {
      container.appendChild(el(`<div style="font-size:13px;color:#067647;padding:4px 0">${r.nome}: enviado por e-mail (${r.destino || ''})</div>`));
    }
  });
}

// ---------- Histórico ----------

async function carregarRecupHistorico() {
  try {
    const selectAluno = document.getElementById('recup-hist-aluno');
    if (selectAluno.options.length <= 1) await popularSelectAlunosComTodos(selectAluno);

    const alunoId = selectAluno.value;
    const canal = document.getElementById('recup-hist-canal').value;
    const params = new URLSearchParams();
    if (alunoId) params.set('aluno_id', alunoId);
    if (canal) params.set('canal', canal);

    const linhas = await api(`/api/recuperacao/historico${params.toString() ? `?${params.toString()}` : ''}`);
    const tbody = document.getElementById('recup-hist-lista');
    tbody.innerHTML = '';
    if (!linhas.length) {
      tbody.innerHTML = '<tr><td colspan="5">Nenhuma mensagem registrada ainda.</td></tr>';
      return;
    }
    const labelStatus = { enviado: 'Enviado', erro: 'Erro', link_gerado: 'Link gerado (WhatsApp)' };
    linhas.forEach((m) => {
      const mensagemCurta = (m.mensagem || '').slice(0, 200) + ((m.mensagem || '').length > 200 ? '…' : '');
      const tr = el(`
        <tr>
          <td>${formatarDataOuDataHora(m.criado_em)}</td>
          <td>${m.aluno_nome}</td>
          <td>${m.canal === 'email' ? 'E-mail' : 'WhatsApp'}</td>
          <td><span class="badge ${m.status === 'erro' ? 'atrasado' : 'ativo'}">${labelStatus[m.status] || m.status}</span></td>
          <td style="max-width:320px;white-space:pre-wrap;font-size:12.5px">${mensagemCurta}</td>
        </tr>
      `);
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('btn-recup-hist-buscar').addEventListener('click', carregarRecupHistorico);

// ---------------- Inicialização ----------------

carregarConfigApp();

if (estado.token && estado.usuario) {
  mostrarApp();
} else {
  mostrarLogin();
}
