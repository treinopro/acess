// Pareamento do aparelho do totem (2026-11). Carregado ANTES de terminal.js / terminal-teste-pi.js.
//
// O totem não carrega mais nenhum segredo no código da página. Na primeira vez (ou depois de limpar os dados do
// navegador, ou de a recepção revogar o aparelho) aparece a tela "Parear este aparelho": a recepção gera um
// código no painel (Configurações > Aparelhos do totem), digita-se aqui, e o servidor devolve uma chave própria
// deste aparelho, guardada neste navegador e enviada em cada requisição (cabeçalho X-Device-Key).
const TotemAparelho = (() => {
  const CHAVE_LS = 'totem_chave_aparelho';
  let overlay = null;

  function chave() {
    try { return localStorage.getItem(CHAVE_LS) || ''; } catch { return ''; }
  }
  function salvar(valor) {
    try { localStorage.setItem(CHAVE_LS, valor); } catch { /* sem armazenamento: o pareamento não persiste */ }
  }
  function esquecer() {
    try { localStorage.removeItem(CHAVE_LS); } catch { /* ignora */ }
  }
  function cabecalhos() {
    const c = chave();
    return c ? { 'X-Device-Key': c } : {};
  }

  function mostrarPareamento(mensagemInicial) {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif';
    overlay.innerHTML = `
      <div style="max-width:380px;width:100%;text-align:center">
        <h2 style="margin:0 0 8px">Parear este aparelho</h2>
        <p style="margin:0 0 16px;color:#94a3b8;font-size:15px">Peça à recepção um código em <b>Configurações &gt; Aparelhos do totem</b> e digite abaixo. O código vale 10 minutos.</p>
        <input id="totem-codigo" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX"
          style="width:100%;box-sizing:border-box;font-size:28px;letter-spacing:4px;text-align:center;padding:14px;border-radius:12px;border:2px solid #334155;background:#1e293b;color:#fff">
        <div id="totem-pareamento-erro" style="color:#f87171;min-height:22px;margin:10px 0;font-size:14px"></div>
        <button id="totem-parear-btn" style="width:100%;font-size:18px;padding:14px;border:0;border-radius:12px;background:#22c55e;color:#052e16;font-weight:700">Parear</button>
      </div>`;
    document.body.appendChild(overlay);
    const campo = overlay.querySelector('#totem-codigo');
    const erro = overlay.querySelector('#totem-pareamento-erro');
    const botao = overlay.querySelector('#totem-parear-btn');
    if (mensagemInicial) erro.textContent = mensagemInicial;
    async function parear() {
      erro.textContent = '';
      botao.disabled = true;
      try {
        const resp = await fetch('/api/terminal/aparelhos/parear', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: campo.value }),
        });
        const dados = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(dados.erro || 'Não foi possível parear.');
        salvar(dados.chave);
        location.reload();
      } catch (e) {
        erro.textContent = e.message;
        botao.disabled = false;
      }
    }
    botao.addEventListener('click', parear);
    campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') parear(); });
    setTimeout(() => campo.focus(), 100);
  }

  // Ao abrir a página: sem chave, ou com chave que o servidor não reconhece mais (revogada), pede o pareamento.
  async function verificar() {
    if (!chave()) { mostrarPareamento(); return false; }
    try {
      const resp = await fetch('/api/terminal/aparelho/status', { headers: cabecalhos() });
      if (resp.status === 401) { esquecer(); mostrarPareamento('Este aparelho não está mais autorizado. Pareie de novo.'); return false; }
      return true;
    } catch {
      return true; // sem rede agora: segue com a chave que já tem (o servidor do PC reconhece offline)
    }
  }

  return { chave, cabecalhos, mostrarPareamento, esquecer, verificar };
})();
TotemAparelho.verificar();
