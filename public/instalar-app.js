/* Mini tutorial "Instale o app" (PWA). Aparece só enquanto o app NÃO está instalado e some de vez depois de instalar.
 * Uso: <script src="/instalar-app.js" data-nome="Nome do app" data-chave="identificador"></script>
 * - Mostra uma faixa fina no topo com "Como instalar". Toque abre o passo a passo do sistema da pessoa
 *   (iPhone/iPad, Android, Windows/Mac/Linux, e navegadores dentro de outros apps).
 * - Se o navegador permite instalar com um toque (Chrome/Edge/Android), mostra o botão "Instalar agora".
 * - "Agora não" esconde por 7 dias; "Já instalei" esconde para sempre neste aparelho.
 * Arquivo único, sem dependências. Mesma cópia nos projetos Treino pro e portal da academia. */
(function () {
  var tag = document.currentScript;
  var NOME = (tag && tag.getAttribute('data-nome')) || 'o app'; // nome sem artigo (ex.: Treino Pro)
  var CHAVE = (tag && tag.getAttribute('data-chave')) || 'app';
  var COR = (tag && tag.getAttribute('data-cor')) || '#10b981';
  var K_OK = 'instalar-app-ok-' + CHAVE;
  var K_ADIA = 'instalar-app-adiado-' + CHAVE;
  var DIAS_ADIADO = 7;

  function ler(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function gravar(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } }

  // Já está rodando como app instalado?
  function instalado() {
    try {
      if (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches ||
          window.matchMedia('(display-mode: fullscreen)').matches || window.matchMedia('(display-mode: minimal-ui)').matches)) return true;
    } catch (e) { /* segue */ }
    if (window.navigator.standalone === true) return true; // iOS
    return ler(K_OK) === '1';
  }
  if (instalado()) return;
  var adiadoEm = Number(ler(K_ADIA) || 0);
  if (adiadoEm && Date.now() - adiadoEm < DIAS_ADIADO * 86400000) return;

  var ua = navigator.userAgent || '';
  var ehIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var ehAndroid = /Android/i.test(ua);
  var emOutroApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|TikTok|Snapchat|; wv\)/i.test(ua);
  var ehSafariIOS = ehIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua);
  var ehFirefox = /Firefox|FxiOS/.test(ua);
  var ehEdge = /Edg\//.test(ua);
  var ehSamsung = /SamsungBrowser/.test(ua);
  var ehSafariMac = !ehIOS && /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  var promptAdiado = null;

  function passos() {
    if (emOutroApp) {
      return { titulo: 'Abra no navegador primeiro', itens: [
        'Você está dentro de outro app (Instagram, Facebook...), que não permite instalar.',
        'Toque nos <b>três pontinhos</b> (⋯ ou ⋮) no canto da tela.',
        'Escolha <b>Abrir no navegador</b> (Safari ou Chrome).',
        'Depois, volte aqui e toque em <b>Como instalar</b> de novo.' ] };
    }
    if (ehIOS) {
      return { titulo: 'Instalar no iPhone / iPad', itens: [
        ehSafariIOS ? 'Toque no botão <b>Compartilhar</b> (o quadrado com a seta para cima ⬆️), na barra de baixo do Safari.'
                    : 'Toque no botão <b>Compartilhar</b> (o quadrado com a seta ⬆️) do seu navegador. Se não achar, abra esta página no <b>Safari</b>.',
        'Role a lista e toque em <b>Adicionar à Tela de Início</b> ➕.',
        'Confirme em <b>Adicionar</b>. O ícone de ' + NOME + ' aparece na sua tela inicial.' ] };
    }
    if (ehAndroid) {
      if (ehSamsung) return { titulo: 'Instalar no Android (Samsung Internet)', itens: [
        'Toque no menu <b>☰</b> (três linhas) na barra de baixo.',
        'Toque em <b>Adicionar página a</b> e escolha <b>Tela inicial</b>.',
        'Confirme em <b>Adicionar</b>.' ] };
      if (ehFirefox) return { titulo: 'Instalar no Android (Firefox)', itens: [
        'Toque nos <b>três pontinhos ⋮</b> do Firefox.',
        'Toque em <b>Instalar</b> (ou <b>Adicionar à tela inicial</b>).',
        'Confirme. O ícone de ' + NOME + ' aparece na sua tela inicial.' ] };
      return { titulo: 'Instalar no Android (Chrome)', itens: [
        'Toque nos <b>três pontinhos ⋮</b> no canto de cima do Chrome.',
        'Toque em <b>Instalar app</b> (ou <b>Adicionar à tela inicial</b>).',
        'Confirme em <b>Instalar</b>. O ícone de ' + NOME + ' aparece na sua tela inicial.' ] };
    }
    if (ehSafariMac) return { titulo: 'Instalar no Mac (Safari)', itens: [
      'No menu do topo, clique em <b>Arquivo</b>.',
      'Clique em <b>Adicionar ao Dock…</b>.',
      'Confirme em <b>Adicionar</b>. ' + '<b>' + NOME + '</b> abre como um app, direto do Dock.' ] };
    if (ehFirefox) return { titulo: 'Instalar no computador', itens: [
      'O Firefox no computador <b>não instala</b> apps deste tipo.',
      'Abra esta página no <b>Google Chrome</b> ou no <b>Microsoft Edge</b>.',
      'Lá, clique no ícone de instalar ⬇️ no fim da barra de endereço, ou no menu ⋮ → <b>Instalar</b>.' ] };
    return { titulo: 'Instalar no computador (' + (ehEdge ? 'Edge' : 'Chrome') + ')', itens: [
      'Olhe o <b>fim da barra de endereço</b> (onde fica o endereço do site): aparece um ícone de instalar ⬇️ (um monitor com uma seta).',
      'Clique nele e depois em <b>Instalar</b>. Se não aparecer, abra o menu <b>⋮</b> → <b>Salvar e compartilhar</b> → <b>Instalar</b>.',
      '<b>' + NOME + '</b> abre em uma janela própria e fica no menu Iniciar / Dock.' ] };
  }

  var css = '.iapp-bar{position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;align-items:center;gap:10px;padding:calc(8px + env(safe-area-inset-top,0px)) 12px 8px;' +
    'background:#0f172a;color:#fff;font:14px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.35)}' +
    '.iapp-bar span.t{flex:1;min-width:0}.iapp-bar button{font:inherit;cursor:pointer;border-radius:8px;border:0;padding:8px 12px}' +
    '.iapp-go{background:' + COR + ';color:#04130c;font-weight:700}.iapp-x{background:transparent;color:#cbd5e1;font-size:18px;padding:4px 8px!important}' +
    '.iapp-bg{position:fixed;inset:0;z-index:2147483001;background:rgba(2,6,23,.75);display:flex;align-items:flex-end;justify-content:center;padding:0}' +
    '@media(min-width:640px){.iapp-bg{align-items:center;padding:16px}}' +
    '.iapp-box{width:100%;max-width:460px;background:#fff;color:#0f172a;border-radius:18px 18px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom,0px));' +
    'font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-height:92vh;overflow:auto}' +
    '@media(min-width:640px){.iapp-box{border-radius:18px}}' +
    '.iapp-box h2{margin:0 0 4px;font-size:19px}.iapp-box p.s{margin:0 0 14px;color:#475569;font-size:14px}' +
    '.iapp-box ol{margin:0 0 16px;padding:0;list-style:none;counter-reset:p}' +
    '.iapp-box li{counter-increment:p;position:relative;padding:10px 0 10px 40px;border-top:1px solid #e2e8f0}' +
    '.iapp-box li:first-child{border-top:0}' +
    '.iapp-box li::before{content:counter(p);position:absolute;left:0;top:10px;width:28px;height:28px;border-radius:50%;background:' + COR + ';color:#04130c;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:14px}' +
    '.iapp-box .b{display:block;width:100%;margin-top:8px;padding:13px;border-radius:10px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;font:inherit;font-weight:600;cursor:pointer}' +
    '.iapp-box .b.p{background:' + COR + ';border-color:' + COR + ';color:#04130c}' +
    '@media(prefers-color-scheme:dark){.iapp-box{background:#1e293b;color:#f1f5f9}.iapp-box p.s{color:#94a3b8}.iapp-box li{border-top-color:#334155}.iapp-box .b{background:#0f172a;border-color:#334155;color:#f1f5f9}}';

  function montar() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var bar = document.createElement('div'); bar.className = 'iapp-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Instalar o app');
    bar.innerHTML = '<span class="t">📲 Instale o app <b>' + NOME + '</b></span><button class="iapp-go" type="button">Como instalar</button><button class="iapp-x" type="button" aria-label="Fechar">✕</button>';
    document.body.appendChild(bar);
    var go = bar.querySelector('.iapp-go');
    function fechar() { if (bar.parentNode) bar.parentNode.removeChild(bar); }
    bar.querySelector('.iapp-x').addEventListener('click', function () { gravar(K_ADIA, String(Date.now())); fechar(); });
    go.addEventListener('click', function () { if (promptAdiado) instalarAgora(fechar); else abrirPassos(fechar); });
    atualizarBotao = function () { go.textContent = promptAdiado ? 'Instalar agora' : 'Como instalar'; };
    atualizarBotao();
    window.addEventListener('appinstalled', function () { gravar(K_OK, '1'); fechar(); var m = document.querySelector('.iapp-bg'); if (m) m.remove(); });
  }
  var atualizarBotao = function () {};

  function instalarAgora(fecharBarra) {
    var p = promptAdiado; promptAdiado = null;
    p.prompt();
    p.userChoice.then(function (r) { if (r && r.outcome === 'accepted') { gravar(K_OK, '1'); fecharBarra(); } else atualizarBotao(); }).catch(function () {});
  }

  function abrirPassos(fecharBarra) {
    var d = passos();
    var bg = document.createElement('div'); bg.className = 'iapp-bg';
    bg.innerHTML = '<div class="iapp-box" role="dialog" aria-modal="true"><h2>' + d.titulo + '</h2><p class="s">Leva menos de 1 minuto e abre como um app, sem digitar o endereço.</p><ol>' +
      d.itens.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ol>' +
      (promptAdiado ? '<button class="b p" type="button" data-a="inst">Instalar agora</button>' : '') +
      '<button class="b" type="button" data-a="ja">Já instalei</button><button class="b" type="button" data-a="fechar">Agora não</button></div>';
    document.body.appendChild(bg);
    function sair() { bg.remove(); }
    bg.addEventListener('click', function (ev) {
      if (ev.target === bg) { sair(); return; }
      var a = ev.target.getAttribute && ev.target.getAttribute('data-a');
      if (a === 'fechar') { sair(); }
      else if (a === 'ja') { gravar(K_OK, '1'); sair(); fecharBarra(); }
      else if (a === 'inst') { sair(); instalarAgora(fecharBarra); }
    });
  }

  window.addEventListener('beforeinstallprompt', function (ev) { ev.preventDefault(); promptAdiado = ev; atualizarBotao(); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
})();
