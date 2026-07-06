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
  document.getElementById('btn-acessos-recentes').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  carregarSecao('alunos');
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
  relatorios: 'Relatórios',
  usuarios: 'Usuários',
  config: 'Configurações',
  catraca: 'Catraca',
};
const ORDEM_MENU_PADRAO = ['alunos', 'planos', 'agenda', 'pagamentos', 'relatorios', 'usuarios', 'config', 'catraca'];
let ordemMenuAtual = [...ORDEM_MENU_PADRAO];

// Reordena os botões <nav> de verdade na barra lateral (move os elementos já
// existentes — não recria nada, então os listeners de clique continuam valendo).
function aplicarOrdemMenu(ordem) {
  const nav = document.querySelector('.sidebar nav') || document.querySelector('nav');
  if (!nav || !Array.isArray(ordem) || !ordem.length) return;
  ordem.forEach((secao) => {
    const btn = nav.querySelector(`.nav-btn[data-secao="${secao}"]`);
    if (btn) nav.appendChild(btn);
  });
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
  if (nome === 'usuarios') carregarUsuarios();
  if (nome === 'config') carregarConfiguracoesForm();
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

tornarArrastavel(document.getElementById('janela-catraca'), document.getElementById('janela-catraca-alca'));

// ---------------- Configurações (nome do app, licenciado para, backup) ----------------

async function carregarConfiguracoesForm() {
  try {
    const config = await api('/api/config');
    document.getElementById('config-nome-app').value = config.nome_app || '';
    document.getElementById('config-licenciado-para').value = config.licenciado_para || '';
    ordemMenuAtual = Array.isArray(config.menu_ordem) && config.menu_ordem.length
      ? [...config.menu_ordem]
      : [...ORDEM_MENU_PADRAO];
    renderizarOrdemMenu();
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('form-config-app').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    nome_app: document.getElementById('config-nome-app').value.trim() || 'Academia Gestão',
    licenciado_para: document.getElementById('config-licenciado-para').value.trim(),
  };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(dados) });
    mostrarToast('Configurações salvas.');
    carregarConfigApp();
  } catch (err) { mostrarToast(err.message, true); }
});

document.getElementById('btn-baixar-backup').addEventListener('click', async () => {
  try {
    mostrarToast('Gerando backup...');
    await baixarArquivoAutenticado('/api/config/backup', `backup-academia-${new Date().toISOString().slice(0, 10)}.json`);
    mostrarToast('Backup baixado.');
  } catch (err) { mostrarToast(err.message, true); }
});

// Sai do perfil do aluno e volta para a listagem, reativando o item de navegação.
function voltarParaAlunos() {
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

async function carregarAlunos() {
  try {
    const busca = document.getElementById('busca-aluno').value.trim();
    const mostrarInativos = document.getElementById('mostrar-inativos-alunos').checked;
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    if (mostrarInativos) params.set('incluir_inativos', 'true');
    const alunos = await api(`/api/alunos${params.toString() ? '?' + params.toString() : ''}`);
    const tbody = document.getElementById('lista-alunos');
    tbody.innerHTML = '';
    alunos.forEach((aluno) => {
      const contato = [aluno.email, aluno.telefone].filter(Boolean).join(' · ') || '—';
      const tr = el(`
        <tr>
          <td>${aluno.nome}</td>
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
    await baixarArquivoAutenticado('/api/alunos/exportar', `alunos-${new Date().toISOString().slice(0, 10)}.csv`);
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
  document.getElementById('aluno-plano-data').value = new Date().toISOString().slice(0, 10);
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

document.getElementById('btn-novo-aluno').addEventListener('click', () => abrirFormAluno());
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
      await api(`/api/alunos/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      mostrarToast('Aluno atualizado.');
    } else {
      const criado = await api('/api/alunos', { method: 'POST', body: JSON.stringify(dados) });
      alunoId = criado.id;
      mostrarToast('Aluno cadastrado.');
    }

    if (planoId) {
      try {
        await api('/api/planos/matricular', {
          method: 'POST',
          body: JSON.stringify({ aluno_id: alunoId, plano_id: planoId, data_inicio: planoData || new Date().toISOString().slice(0, 10) }),
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
              data_avaliacao: new Date().toISOString().slice(0, 10),
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

    document.getElementById('perfil-lista-matriculas').innerHTML = matriculas.length
      ? matriculas.map((m) => `
        <tr>
          <td>${m.plano_nome}</td>
          <td>${m.data_inicio}</td>
          <td>${m.data_fim || '—'}</td>
          <td><span class="badge ${m.status}">${m.status}</span></td>
        </tr>`).join('')
      : '<tr><td colspan="4">Nenhuma matrícula.</td></tr>';

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
  } catch (err) {
    mostrarToast(err.message, true);
  }
}

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
          <td>${dataPago ? new Date(dataPago).toLocaleDateString('pt-BR') : '—'}</td>
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
    await api(`/api/alunos/${perfilAtualId}`, { method: 'PUT', body: JSON.stringify(dados) });
    mostrarToast('Dados do aluno atualizados.');
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

function abrirFormPlano(plano = null) {
  const form = document.getElementById('form-plano');
  form.classList.remove('oculto');
  form.querySelector('h3').textContent = plano ? 'Editar plano' : 'Novo plano';
  document.getElementById('plano-id').value = plano?.id || '';
  document.getElementById('plano-nome').value = plano?.nome || '';
  document.getElementById('plano-tipo').value = plano?.tipo || 'mensal';
  document.getElementById('plano-valor').value = plano ? (plano.valor_centavos / 100).toFixed(2) : '';
  document.getElementById('plano-duracao').value = plano?.duracao_dias || '';
  form.scrollIntoView({ behavior: 'smooth' });
}

function popularSelectPlanos(select, planos) {
  select.innerHTML = planos.map((p) => `<option value="${p.id}">${p.nome} (${formatarMoeda(p.valor_centavos)})</option>`).join('');
}

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
          <td>${m.aluno_nome}</td>
          <td>${m.plano_nome}</td>
          <td>${m.data_inicio}</td>
          <td>${m.data_fim || '—'}</td>
          <td><span class="badge ${m.status}">${m.status}</span></td>
          <td>${m.status === 'ativa' ? '<button class="btn-linha perigo" data-acao="cancelar">Cancelar</button>' : '—'}</td>
        </tr>
      `);
      const botaoCancelar = tr.querySelector('[data-acao="cancelar"]');
      if (botaoCancelar) {
        botaoCancelar.addEventListener('click', async () => {
          if (!confirmar(`Cancelar a matrícula de "${m.aluno_nome}" no plano "${m.plano_nome}"? Isso interrompe a geração automática das próximas mensalidades.`)) return;
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
  const dados = {
    nome: document.getElementById('plano-nome').value.trim(),
    tipo: document.getElementById('plano-tipo').value,
    valor_centavos: Math.round(parseFloat(document.getElementById('plano-valor').value) * 100),
    duracao_dias: document.getElementById('plano-duracao').value ? Number(document.getElementById('plano-duracao').value) : null,
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
          <td>${a.aluno_nome}</td>
          <td><span class="badge ${a.status}">${a.status}</span></td>
          <td>
            <button class="btn-linha" data-acao="checkin">Check-in</button>
            <button class="btn-linha perigo" data-acao="cancelar">Cancelar</button>
          </td>
        </tr>
      `);
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

async function carregarPagamentos() {
  await popularSelectAlunos(document.getElementById('cobranca-aluno'));
  await popularSelectAlunos(document.getElementById('conta-aluno'));
  await popularSelectAlunosComTodos(document.getElementById('filtro-conta-aluno'));
  await carregarContas();
      carregarFinanceiroPerfil();
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

async function carregarContas() {
  try {
    const alunoId = document.getElementById('filtro-conta-aluno').value;
    const status = document.getElementById('filtro-conta-status').value;
    const busca = document.getElementById('busca-conta-nome').value.trim();
    const mostrarInativos = document.getElementById('mostrar-inativos-contas').checked;
    const params = new URLSearchParams();
    if (alunoId) params.set('aluno_id', alunoId);
    if (status) params.set('status', status);
    if (busca) params.set('busca', busca);
    if (mostrarInativos) params.set('incluir_inativos', 'true');

    const contas = await api(`/api/pagamentos/cobrancas${params.toString() ? '?' + params.toString() : ''}`);
    const tbody = document.getElementById('lista-contas');
    tbody.innerHTML = '';

    if (!contas.length) {
      tbody.innerHTML = '<tr><td colspan="8">Nenhuma conta encontrada.</td></tr>';
      return;
    }

    contas.forEach((c) => {
      // Fallback pra contas quitadas via webhook do gateway (Mercado Pago/InfinitePay) ou
      // marcadas como pagas na criação manual antiga, que podem não ter linha em
      // pagamentos_cobranca — nesses casos usa o valor/data cheios da própria conta.
      const valorPago = Number(c.valor_pago_centavos || 0) || (c.status === 'pago' ? c.valor_centavos : 0);
      const dataPago = c.data_pago_calc || (c.status === 'pago' ? c.pago_em : null);
      const tr = el(`
        <tr>
          <td>${c.aluno_nome}</td>
          <td>${c.descricao || '—'}</td>
          <td>${formatarMoeda(c.valor_centavos)}</td>
          <td>${c.vencimento || '—'}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
          <td>${dataPago ? new Date(dataPago).toLocaleDateString('pt-BR') : '—'}</td>
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
          carregarContas();
      carregarFinanceiroPerfil();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('filtro-conta-aluno').addEventListener('change', carregarContas);
document.getElementById('filtro-conta-status').addEventListener('change', carregarContas);
document.getElementById('mostrar-inativos-contas').addEventListener('change', carregarContas);

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
}

function atualizarBadgeStatusModal(status) {
  const badge = document.getElementById('mconta-status-badge');
  badge.textContent = status;
  badge.className = `badge ${status}`;
  document.getElementById('btn-remover-quitacao').classList.toggle('oculto', status !== 'pago');
}

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
          <td>${new Date(p.data).toLocaleDateString('pt-BR')}</td>
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

document.getElementById('form-modal-conta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = document.getElementById('mconta-id').value;
  const dados = {
    descricao: document.getElementById('mconta-descricao').value.trim(),
    valor_centavos: Math.round(parseFloat(document.getElementById('mconta-valor').value) * 100),
    vencimento: document.getElementById('mconta-vencimento').value || null,
  };
  try {
    await api(`/api/pagamentos/cobrancas/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
    mostrarToast('Conta atualizada.');
    fecharModalConta();
    carregarContas();
      carregarFinanceiroPerfil();
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

function abrirModalPagamento() {
  const saldoCentavos = Math.max(modalContaAtual.valor_centavos - modalContaTotalPagoCentavos, 0);

  document.getElementById('pagamento-data').value = new Date().toISOString().slice(0, 10);
  document.getElementById('pagamento-valor').value = (saldoCentavos / 100).toFixed(2);
  document.getElementById('pagamento-tipo').value = 'dinheiro';
  document.getElementById('pagamento-conta-corrente').value = 'Caixa da empresa';
  document.getElementById('modal-pagamento').classList.remove('oculto');
}

function fecharModalPagamento() {
  document.getElementById('modal-pagamento').classList.add('oculto');
}

document.getElementById('btn-add-pagamento').addEventListener('click', abrirModalPagamento);
document.getElementById('btn-fechar-modal-pagamento').addEventListener('click', fecharModalPagamento);
document.getElementById('btn-cancelar-modal-pagamento').addEventListener('click', fecharModalPagamento);

document.getElementById('form-modal-pagamento').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = {
    data: document.getElementById('pagamento-data').value,
    valor_centavos: Math.round(parseFloat(document.getElementById('pagamento-valor').value) * 100),
    tipo: document.getElementById('pagamento-tipo').value,
    conta_corrente: document.getElementById('pagamento-conta-corrente').value.trim() || null,
  };
  try {
    const resp = await api(`/api/pagamentos/cobrancas/${modalContaAtual.id}/pagamentos`, { method: 'POST', body: JSON.stringify(dados) });
    mostrarToast(resp.cobranca?.status === 'pago' ? 'Pagamento lançado — conta quitada!' : 'Pagamento lançado.');
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

  const hoje = new Date().toISOString().slice(0, 10);
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
    provedor: document.getElementById('cobranca-provedor').value,
  };
  const resultadoEl = document.getElementById('cobranca-resultado');
  try {
    const resp = await api('/api/pagamentos/cobrar', { method: 'POST', body: JSON.stringify(dados) });
    resultadoEl.classList.remove('oculto');
    resultadoEl.innerHTML = resp.link_pagamento
      ? `Cobrança criada via <strong>${resp.provedor}</strong>. Link: <a href="${resp.link_pagamento}" target="_blank" rel="noopener">${resp.link_pagamento}</a>`
      : `Cobrança criada via <strong>${resp.provedor}</strong>, mas o provedor não retornou um link (verifique as credenciais no .env).`;
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
      const tr = el(`
        <tr>
          <td>${new Date(a.criado_em).toLocaleString('pt-BR')}</td>
          <td>${a.aluno_nome || '—'}</td>
          <td title="${a.mensagem || ''}"><span class="badge ${a.resultado === 'liberado' ? 'ativo' : 'inadimplente'}">${a.resultado}</span></td>
        </tr>
      `);
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

// ---------------- RELATÓRIOS ----------------
// Relatórios > Financeiro (Contas a Receber com filtros) e Relatórios > Acessos
// (Acesso Diário / Acesso Pessoal / Último Acesso). Cada um tem seu próprio filtro de
// data/período, conforme pedido.

document.querySelectorAll('.relatorio-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => trocarAbaRelatorio(btn.dataset.relatorio));
});

function trocarAbaRelatorio(nome) {
  document.querySelectorAll('.relatorio-tab-btn').forEach((b) => b.classList.toggle('ativo', b.dataset.relatorio === nome));
  document.querySelectorAll('.relatorio-painel').forEach((p) => p.classList.toggle('oculto', p.dataset.relatorioPainel !== nome));
}

async function carregarSecaoRelatorios() {
  await popularSelectAlunosComTodos(document.getElementById('rel-fin-aluno'));
  await popularSelectAlunos(document.getElementById('rel-pessoal-aluno'), { comPlaceholder: true });
  const hoje = new Date().toISOString().slice(0, 10);
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
      tbody.appendChild(el(`
        <tr>
          <td>${c.aluno_nome}</td>
          <td>${c.descricao || '—'}</td>
          <td>${formatarMoeda(c.valor_centavos)}</td>
          <td>${c.vencimento || '—'}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
          <td>${dataPago ? new Date(dataPago).toLocaleDateString('pt-BR') : '—'}</td>
          <td>${valorPago > 0 ? formatarMoeda(valorPago) : '—'}</td>
        </tr>
      `));
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
    const params = new URLSearchParams();
    if (data) params.set('data', data);
    if (busca) params.set('busca', busca);

    const lista = await api(`/api/terminal/acessos${params.toString() ? '?' + params.toString() : ''}`);
    const tbody = document.getElementById('rel-diario-lista');
    tbody.innerHTML = lista.length ? '' : '<tr><td colspan="5">Nenhum acesso nessa data.</td></tr>';
    lista.forEach((a) => {
      tbody.appendChild(el(`
        <tr>
          <td>${new Date(a.criado_em).toLocaleTimeString('pt-BR')}</td>
          <td>${a.aluno_nome || '—'}</td>
          <td>${a.metodo}</td>
          <td><span class="badge ${a.resultado === 'liberado' ? 'ativo' : 'inadimplente'}">${a.resultado}</span></td>
          <td>${a.mensagem || '—'}</td>
        </tr>
      `));
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
          <td>${new Date(a.criado_em).toLocaleString('pt-BR')}</td>
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
      tbody.appendChild(el(`
        <tr>
          <td>${a.aluno_nome}</td>
          <td>${new Date(a.ultimo_acesso).toLocaleString('pt-BR')}</td>
        </tr>
      `));
    });
  } catch (err) { mostrarToast(err.message, true); }
}
document.getElementById('btn-rel-ultimo-buscar').addEventListener('click', buscarRelatorioUltimoAcesso);
document.getElementById('rel-ultimo-mostrar-inativos').addEventListener('change', buscarRelatorioUltimoAcesso);

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
      const quando = new Date(a.criado_em);
      const tr = el(`
        <tr>
          <td>${quando.toLocaleDateString('pt-BR')}</td>
          <td>${quando.toLocaleTimeString('pt-BR')}</td>
          <td>${a.aluno_nome || '—'}</td>
          <td>${formatarTipoAcesso(a)}</td>
        </tr>
      `);
      tbody.appendChild(tr);
    });
  } catch (err) {
    // Silencioso: esse painel pode ficar aberto em qualquer aba, não queremos
    // toasts repetidos de erro a cada atualização automática.
  }
}

function abrirPainelAcessos() {
  document.getElementById('painel-acessos').classList.add('aberto');
  carregarAcessosRecentes();
  clearInterval(acessosRecentesTimer);
  acessosRecentesTimer = setInterval(carregarAcessosRecentes, 8000);
}

function fecharPainelAcessos() {
  document.getElementById('painel-acessos').classList.remove('aberto');
  clearInterval(acessosRecentesTimer);
  acessosRecentesTimer = null;
}

document.getElementById('btn-acessos-recentes').addEventListener('click', () => {
  const painel = document.getElementById('painel-acessos');
  if (painel.classList.contains('aberto')) fecharPainelAcessos();
  else abrirPainelAcessos();
});
document.getElementById('btn-fechar-acessos').addEventListener('click', fecharPainelAcessos);

// ---------------- Inicialização ----------------

carregarConfigApp();

if (estado.token && estado.usuario) {
  mostrarApp();
} else {
  mostrarLogin();
}
