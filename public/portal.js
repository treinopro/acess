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
}

function formatarMoeda(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarData(iso) {
  if (!iso) return '';
  return iso.split('-').reverse().join('/');
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

async function iniciarCamera(videoEl) {
  pararCamera();
  streamAtual = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  videoEl.srcObject = streamAtual;
  await videoEl.play();
}

function pararCamera() {
  if (streamAtual) {
    streamAtual.getTracks().forEach((t) => t.stop());
    streamAtual = null;
  }
}

let modelosFaciaisCarregados = false;
let modelosFaciaisCarregando = null;
async function carregarModelosFaciais() {
  if (modelosFaciaisCarregados) return;
  if (modelosFaciaisCarregando) return modelosFaciaisCarregando;
  modelosFaciaisCarregando = (async () => {
    await faceapi.nets.tinyFaceDetector.loadFromUri('vendor/face-api/weights');
    await faceapi.nets.faceLandmark68Net.loadFromUri('vendor/face-api/weights');
    await faceapi.nets.faceRecognitionNet.loadFromUri('vendor/face-api/weights');
    modelosFaciaisCarregados = true;
  })();
  return modelosFaciaisCarregando;
}

async function detectarRosto(video) {
  return faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
}

// Cadastro facial genérico (usado tanto no hub quanto no fim do cadastro novo).
async function iniciarCadastroFacial({ video, statusEl, cpf, senha, aoConcluir }) {
  try {
    statusEl.textContent = 'Carregando...';
    await carregarModelosFaciais();
    await iniciarCamera(video);
    statusEl.textContent = 'Posicione seu rosto no centro da câmera...';
  } catch (err) {
    statusEl.textContent = `Erro: ${err.message}`;
    return;
  }

  const tick = async () => {
    if (!streamAtual) return; // câmera foi parada (usuário navegou embora)
    const deteccao = await detectarRosto(video);
    if (deteccao) {
      pararCamera();
      try {
        await api('/api/portal/vincular/facial', {
          method: 'POST',
          body: JSON.stringify({ cpf, senha, descriptor: Array.from(deteccao.descriptor) }),
        });
        statusEl.textContent = 'Rosto cadastrado com sucesso!';
        setTimeout(() => { if (aoConcluir) aoConcluir(); }, 2500);
      } catch (err2) {
        statusEl.textContent = `Erro ao cadastrar: ${err2.message}`;
      }
      return;
    }
    setTimeout(tick, 400);
  };
  tick();
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
let alunoHubTreinoModo = 'nativo';
let contasSelecionadasHub = {};
let pixHubPollTimer = null;
let infoHubPendentePrimeiroAcesso = null; // guarda os dados do dashboard enquanto a tela de "guarde sua senha" está aberta

function resetHub() {
  pararPollPixHub();
  pararCamera();
  cpfHubAtual = null;
  senhaHubAtual = null;
  infoHubPendentePrimeiroAcesso = null;
  contasSelecionadasHub = {};
  document.getElementById('input-cpf-hub').value = '';
  document.getElementById('input-senha-hub').value = '';
  document.getElementById('input-senha-hub').classList.add('oculto');
  document.getElementById('hub-cpf-erro').textContent = '';
  document.getElementById('painel-hub-cpf').classList.remove('oculto');
  ['painel-hub-primeiro-acesso', 'painel-hub-dashboard', 'painel-hub-contas', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-comprovante', 'painel-hub-facial']
    .forEach((id) => document.getElementById(id).classList.add('oculto'));
}

// 2026-07: antes esse botão sempre resetava tudo e voltava pro início (digitar
// CPF de novo), mesmo estando só um nível dentro (ex: na tela de Contas ou
// Treino, depois de já ter aberto o menu). Agora ele volta um nível de cada
// vez: se tiver algum painel de submenu aberto (contas/treino/plano/pix/
// facial), fecha esse painel e volta pro menu principal (painel-hub-
// dashboard); só faz o reset completo pro início quando já está no menu
// principal (ou na tela de CPF).
document.getElementById('btn-voltar-hub').addEventListener('click', () => {
  const SUBPAINEIS_HUB = ['painel-hub-contas', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-facial'];
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

  document.getElementById('hub-saudacao').textContent = `Olá, ${info.aluno_nome}!`;
  document.getElementById('painel-hub-cpf').classList.add('oculto');
  document.getElementById('painel-hub-primeiro-acesso').classList.add('oculto');
  document.getElementById('painel-hub-dashboard').classList.remove('oculto');

  document.getElementById('card-plano-resumo').textContent = info.plano_atual
    ? `${info.plano_atual.plano_nome} — ${formatarMoeda(info.plano_atual.valor_centavos)}/ciclo`
    : 'Nenhum plano ativo no momento.';

  document.getElementById('card-treino-resumo').textContent = alunoHubTreinoModo === 'app_externo'
    ? 'Seu treino é acompanhado em outro aplicativo.'
    : 'Toque para ver seus treinos cadastrados.';

  const cardFacial = document.getElementById('card-facial');
  if (info.tem_rosto_cadastrado) cardFacial.classList.add('oculto');
  else cardFacial.classList.remove('oculto');

  const cardAvaliacao = document.getElementById('card-avaliacao');
  if (configApp.whatsapp_contato) {
    cardAvaliacao.classList.remove('oculto');
    const texto = encodeURIComponent(`Olá! Sou aluno(a) ${info.aluno_nome} e gostaria de agendar/renovar minha avaliação física.`);
    document.getElementById('link-agendar-avaliacao').href = `https://wa.me/${configApp.whatsapp_contato}?text=${texto}`;
  } else {
    cardAvaliacao.classList.add('oculto');
  }

  carregarResumoContasHub();
}

document.getElementById('btn-buscar-hub').addEventListener('click', async () => {
  const cpf = document.getElementById('input-cpf-hub').value.trim();
  const senhaDigitada = document.getElementById('input-senha-hub').value.trim();
  const erroEl = document.getElementById('hub-cpf-erro');
  erroEl.textContent = '';
  if (!cpf) return;

  try {
    const qs = new URLSearchParams({ cpf });
    if (senhaDigitada) qs.set('senha', senhaDigitada);
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
    preencherDashboardHub(info);
  } catch (err) {
    if (err.dados && err.dados.precisa_senha) {
      document.getElementById('input-senha-hub').classList.remove('oculto');
      erroEl.textContent = 'Informe também sua senha de acesso.';
    } else {
      erroEl.textContent = err.message;
    }
  }
});

document.getElementById('btn-primeiro-acesso-continuar').addEventListener('click', () => {
  if (!infoHubPendentePrimeiroAcesso) return;
  const info = infoHubPendentePrimeiroAcesso;
  infoHubPendentePrimeiroAcesso = null;
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
  } catch (err) {
    document.getElementById('card-contas-resumo').textContent = `Erro ao consultar: ${err.message}`;
  }
}

function ocultarPaineisHub() {
  ['painel-hub-dashboard', 'painel-hub-contas', 'painel-hub-treino', 'painel-hub-upgrade', 'painel-hub-pix', 'painel-hub-comprovante', 'painel-hub-facial']
    .forEach((id) => document.getElementById(id).classList.add('oculto'));
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

document.getElementById('btn-abrir-treino').addEventListener('click', async () => {
  if (alunoHubTreinoModo === 'app_externo') {
    if (configApp.treino_app_url) window.open(configApp.treino_app_url, '_blank', 'noopener');
    else alert('O link do app de treino ainda não foi configurado pela academia.');
    return;
  }
  try {
    const treinos = await api(`/api/portal/treino?cpf=${encodeURIComponent(cpfHubAtual)}&senha=${encodeURIComponent(senhaHubAtual)}`);
    ocultarPaineisHub();
    document.getElementById('painel-hub-treino').classList.remove('oculto');
    const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const alvo = document.getElementById('conteudo-treino-hub');
    if (!treinos.length) {
      alvo.innerHTML = '<p>Nenhum treino cadastrado ainda. Fale com seu instrutor.</p>';
      return;
    }
    alvo.innerHTML = treinos.map((t) => `
      <div class="treino-card">
        <h4>${t.nome}</h4>
        <div class="dias">${(t.dias_semana || []).map((d) => DIAS[d]).join(', ') || 'Sem dias definidos'}</div>
        ${t.exercicios.map((ex) => `
          <div class="exercicio-linha">
            <div class="nome">${ex.exercicio}</div>
            <div class="detalhe">${[ex.series && `${ex.series} séries`, ex.carga && `carga ${ex.carga}`, ex.intervalo && `intervalo ${ex.intervalo}`].filter(Boolean).join(' · ')}</div>
            ${ex.observacao ? `<div class="detalhe">${ex.observacao}</div>` : ''}
          </div>
        `).join('') || '<p style="color:#94a3b8;font-size:13px">Nenhum exercício adicionado ainda.</p>'}
      </div>
    `).join('');
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

// ---- Cadastro facial pelo hub (aluno já existente) ----

document.getElementById('btn-abrir-facial-hub').addEventListener('click', async () => {
  ocultarPaineisHub();
  document.getElementById('painel-hub-facial').classList.remove('oculto');
  await iniciarCadastroFacial({
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
    const planos = await api('/api/portal/planos');
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
  const planoId = document.getElementById('portal-cadastro-plano').value;
  const erroEl = document.getElementById('portal-cadastro-erro');
  erroEl.textContent = '';

  if (!nome || !cpf || !planoId) {
    erroEl.textContent = 'Preencha nome, CPF e escolha um plano.';
    return;
  }

  try {
    const resp = await api('/api/portal/cadastro', {
      method: 'POST',
      body: JSON.stringify({ nome, cpf, telefone: telefone || null, email: email || null, plano_id: planoId }),
    });
    cadastroPortalCpfAtual = cpf;
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

document.getElementById('btn-portal-cadastro-concluir').addEventListener('click', () => {
  resetCadastroPortal();
  mostrarPagina('pagina-inicio');
});

// ---------------- Inicialização ----------------

carregarConfigPublica();
