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

// ---------------- Login / Logout ----------------

function confirmar(mensagem) {
  return window.confirm(mensagem);
}

function mostrarApp() {
  document.getElementById('tela-login').classList.add('oculto');
  document.getElementById('tela-app').classList.remove('oculto');
  document.getElementById('usuario-nome').textContent = estado.usuario?.nome || '';
  document.getElementById('nav-usuarios').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  document.getElementById('nav-catraca').classList.toggle('oculto', estado.usuario?.papel !== 'admin');
  carregarSecao('alunos');
}

function mostrarLogin() {
  document.getElementById('tela-app').classList.add('oculto');
  document.getElementById('tela-login').classList.remove('oculto');
}

function fazerLogout() {
  estado.token = null;
  estado.usuario = null;
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  mostrarLogin();
}

document.getElementById('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-senha').value;
  const erroEl = document.getElementById('login-erro');
  erroEl.textContent = '';

  try {
    const resp = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, senha }) });
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
  if (nome === 'catraca') carregarAcessosCatraca();
}

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
    const alunos = await api(`/api/alunos${busca ? `?busca=${encodeURIComponent(busca)}` : ''}`);
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
  await carregarPerfilAluno();
}

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

    document.getElementById('perfil-lista-cobrancas').innerHTML = cobrancas.length
      ? cobrancas.map((c) => `
        <tr>
          <td>${c.descricao || '—'}</td>
          <td>${formatarMoeda(c.valor_centavos)}</td>
          <td>${c.vencimento || '—'}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
        </tr>`).join('')
      : '<tr><td colspan="4">Nenhuma cobrança.</td></tr>';
  } catch (err) {
    mostrarToast(err.message, true);
  }
}

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

async function popularSelectAlunos(select) {
  try {
    const alunos = await api('/api/alunos?status=ativo');
    select.innerHTML = alunos.map((a) => `<option value="${a.id}">${a.nome}</option>`).join('');
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
    const params = new URLSearchParams();
    if (alunoId) params.set('aluno_id', alunoId);
    if (status) params.set('status', status);

    const contas = await api(`/api/pagamentos/cobrancas${params.toString() ? '?' + params.toString() : ''}`);
    const tbody = document.getElementById('lista-contas');
    tbody.innerHTML = '';

    if (!contas.length) {
      tbody.innerHTML = '<tr><td colspan="6">Nenhuma conta encontrada.</td></tr>';
      return;
    }

    contas.forEach((c) => {
      const tr = el(`
        <tr>
          <td>${c.aluno_nome}</td>
          <td>${c.descricao || '—'}</td>
          <td>${formatarMoeda(c.valor_centavos)}</td>
          <td>${c.vencimento || '—'}</td>
          <td><span class="badge ${c.status}">${c.status}</span></td>
          <td>
            <button class="btn-linha" data-acao="editar">Editar</button>
            <button class="btn-linha perigo" data-acao="excluir">Excluir</button>
          </td>
        </tr>
      `);
      tr.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirEditarConta(c));
      tr.querySelector('[data-acao="excluir"]').addEventListener('click', async () => {
        if (!confirmar('Excluir esta conta a receber?')) return;
        try {
          await api(`/api/pagamentos/cobrancas/${c.id}`, { method: 'DELETE' });
          mostrarToast('Conta excluída.');
          carregarContas();
        } catch (err) { mostrarToast(err.message, true); }
      });
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

document.getElementById('filtro-conta-aluno').addEventListener('change', carregarContas);
document.getElementById('filtro-conta-status').addEventListener('change', carregarContas);

function abrirEditarConta(conta) {
  document.getElementById('form-editar-conta').classList.remove('oculto');
  document.getElementById('editar-conta-id').value = conta.id;
  document.getElementById('editar-conta-descricao').value = conta.descricao || '';
  document.getElementById('editar-conta-valor').value = (conta.valor_centavos / 100).toFixed(2);
  document.getElementById('editar-conta-vencimento').value = conta.vencimento || '';
  document.getElementById('editar-conta-status').value = conta.status;
  document.getElementById('form-editar-conta').scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('btn-cancelar-editar-conta').addEventListener('click', () => {
  document.getElementById('form-editar-conta').classList.add('oculto');
});

document.getElementById('form-editar-conta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = document.getElementById('editar-conta-id').value;
  const dados = {
    descricao: document.getElementById('editar-conta-descricao').value.trim(),
    valor_centavos: Math.round(parseFloat(document.getElementById('editar-conta-valor').value) * 100),
    vencimento: document.getElementById('editar-conta-vencimento').value || null,
    status: document.getElementById('editar-conta-status').value,
  };
  try {
    await api(`/api/pagamentos/cobrancas/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
    mostrarToast('Conta atualizada.');
    document.getElementById('form-editar-conta').classList.add('oculto');
    carregarContas();
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
    carregarContas();
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

document.getElementById('btn-testar-catraca').addEventListener('click', async () => {
  const resultadoEl = document.getElementById('catraca-resultado');
  const { query } = paramsCatraca();
  resultadoEl.textContent = 'Testando...';
  try {
    const resp = await api(`/api/terminal/catraca/testar${query ? '?' + query : ''}`);
    resultadoEl.textContent = resp.ok
      ? `✅ Conectou em ${resp.ip}:${resp.port}.`
      : `⛔ Não conectou em ${resp.ip}:${resp.port} — ${resp.erro}`;
  } catch (err) {
    resultadoEl.textContent = `⚠️ ${err.message}`;
  }
});

document.getElementById('btn-abrir-catraca').addEventListener('click', async () => {
  const resultadoEl = document.getElementById('catraca-resultado');
  const { ip, porta } = paramsCatraca();
  if (!confirmar('Isso vai abrir a catraca fisicamente agora, como teste. Continuar?')) return;
  resultadoEl.textContent = 'Enviando comando de abertura...';
  try {
    await api('/api/terminal/catraca/liberar', {
      method: 'POST',
      body: JSON.stringify({ ip: ip || undefined, port: porta ? Number(porta) : undefined, mensagem: 'TESTE DO PAINEL' }),
    });
    resultadoEl.textContent = '✅ Comando de abertura enviado. Confira se a catraca abriu fisicamente.';
  } catch (err) {
    resultadoEl.textContent = `⚠️ ${err.message}`;
  }
});

async function carregarAcessosCatraca() {
  try {
    const lista = await api('/api/terminal/acessos');
    const tbody = document.getElementById('lista-acessos-catraca');
    tbody.innerHTML = lista.length ? '' : '<tr><td colspan="5">Nenhuma tentativa registrada ainda.</td></tr>';
    lista.forEach((a) => {
      const tr = el(`
        <tr>
          <td>${new Date(a.criado_em).toLocaleString('pt-BR')}</td>
          <td>${a.aluno_nome || '—'}</td>
          <td>${a.metodo}</td>
          <td><span class="badge ${a.resultado === 'liberado' ? 'ativo' : 'inadimplente'}">${a.resultado}</span></td>
          <td>${a.mensagem || '—'}</td>
        </tr>
      `);
      tbody.appendChild(tr);
    });
  } catch (err) { mostrarToast(err.message, true); }
}

// ---------------- Inicialização ----------------

if (estado.token && estado.usuario) {
  mostrarApp();
} else {
  mostrarLogin();
}
