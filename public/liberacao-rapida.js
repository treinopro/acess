// Liberação rápida da catraca — tela dedicada para funcionários (ver
// comentário no topo de liberacao-rapida.html). Reaproveita o mesmo token
// JWT salvo em localStorage pelo login do painel (public/app.js) — mesma
// chave ("token"/"usuario"), mesmo endpoint de login.

function mostrarTela(id) {
  document.querySelectorAll('.tela').forEach((el) => el.classList.remove('ativa'));
  document.getElementById(id).classList.add('ativa');
}

async function api(caminho, opcoes = {}) {
  const token = localStorage.getItem('token');
  const headers = { 'Content-Type': 'application/json', ...(opcoes.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(caminho, { ...opcoes, headers });
  const corpo = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(corpo.erro || `Erro ${resp.status}`);
  }
  return corpo;
}

// ---------------- Aviso sonoro local (feedback pro funcionário) ----------------
// Mesma técnica do totem (ver public/terminal.js/tocarBeep) — beep curto via
// Web Audio, sem depender de nenhum arquivo de áudio.
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
      ganho.gain.setValueAtTime(0.0001, inicio);
      ganho.gain.exponentialRampToValueAtTime(0.3, inicio + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.18);
      osc.connect(ganho);
      ganho.connect(ctx.destination);
      osc.start(inicio);
      osc.stop(inicio + 0.2);
    }
  } catch {
    // Web Audio pode falhar em navegadores muito antigos — não deve travar a liberação.
  }
}

// ---------------- Identidade (mesmo nome de "Licenciado para" do totem) ----------------
async function aplicarIdentidade() {
  try {
    const config = await api('/api/config');
    const nome = (config.licenciado_para || config.nome_app || 'ACADEMIA GESTÃO').trim();
    document.getElementById('logo-liberar').textContent = nome.toUpperCase();
  } catch {
    // Fica com o texto padrão do HTML se a busca falhar.
  }
}

// ---------------- Login ----------------
document.getElementById('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = document.getElementById('btn-login');
  const erro = document.getElementById('erro-login');
  erro.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  try {
    const identificador = document.getElementById('login-identificador').value.trim();
    const senha = document.getElementById('login-senha').value;
    const resp = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identificador, senha }) });
    localStorage.setItem('token', resp.token);
    localStorage.setItem('usuario', JSON.stringify(resp.usuario));
    iniciar();
  } catch (err) {
    erro.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

document.getElementById('btn-sair').addEventListener('click', () => {
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  mostrarTela('tela-login');
});

// ---------------- Liberação ----------------
// Mesmo pequeno cooldown de "evitar duplo toque" que outras liberações
// manuais no painel já têm — não é controle de segurança, só evita mandar
// dois comandos de liberação seguidos por um toque duplo sem querer na tela.
const COOLDOWN_LIBERACAO_MS = 3000;
let ultimaLiberacaoEm = 0;

document.getElementById('btn-liberar').addEventListener('click', async () => {
  const btn = document.getElementById('btn-liberar');
  const status = document.getElementById('status-liberacao');

  const agora = Date.now();
  if (agora - ultimaLiberacaoEm < COOLDOWN_LIBERACAO_MS) return;
  ultimaLiberacaoEm = agora;

  btn.disabled = true;
  btn.classList.add('aguardando');
  status.className = 'status-liberacao';
  status.textContent = 'Liberando...';

  try {
    await api('/api/terminal/catraca/liberar', { method: 'POST', body: JSON.stringify({}) });
    status.className = 'status-liberacao ok';
    status.textContent = 'Catraca liberada!';
    document.body.classList.add('tela-flash-liberado');
    tocarBeep(1);
    setTimeout(() => {
      document.body.classList.remove('tela-flash-liberado');
      status.textContent = '';
      status.className = 'status-liberacao';
    }, 2500);
  } catch (err) {
    status.className = 'status-liberacao erro';
    status.textContent = err.message;
    document.body.classList.add('tela-flash-erro');
    tocarBeep(2);
    setTimeout(() => document.body.classList.remove('tela-flash-erro'), 1200);
  } finally {
    btn.disabled = false;
    btn.classList.remove('aguardando');
  }
});

function iniciar() {
  const token = localStorage.getItem('token');
  if (!token) {
    mostrarTela('tela-login');
    return;
  }
  mostrarTela('tela-liberar');
  aplicarIdentidade();
}

iniciar();
