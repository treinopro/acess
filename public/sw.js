// Service worker mínimo, só pra satisfazer o requisito de instalabilidade
// PWA (Chrome/Samsung Internet no Android exigem um SW registrado, além do
// manifest com ícones, pra oferecer "Instalar app"/"Adicionar à tela
// inicial" como app de verdade, não um atalho comum). Cobre o app shell
// estático (html/js/css/ícones) do totem, painel e portal.
//
// NUNCA intercepta /api/ — a resiliência offline de dados (fila de acesso,
// fallback pro banco local etc.) já existe em nível de aplicação, ver
// dbResiliente.service.js/filaAcessosOffline.service.js, e cachear
// respostas de API aqui só criaria uma segunda fonte de verdade divergente.
// v7 (2026-08-14): adiciona feed de banners/avisos do admin no dashboard do
// portal (ver Recuperação de Clientes > Banners). Toda vez que
// portal.js/portal.html mudam de um jeito que precisa chegar rápido em quem
// já visitou antes, sobe a versão aqui — é o que faz o navegador perceber
// que o service worker mudou, buscar de novo, e descartar o cache antigo do
// shell (a troca é automática: install->skipWaiting, activate apaga
// qualquer CACHE_NAME diferente deste e chama clients.claim()). Sem bumpar
// a versão, o stale-while-revalidate abaixo continua servindo o HTML/JS
// antigos do cache indefinidamente, mesmo com os arquivos já atualizados no
// servidor.
// v8 (2026-08-16): bloqueio da aba de treino por mensalidade/cadastro
// inativo (portal.js) + correção do PWA "sambando" pros lados no iOS
// (overflow-x/overscroll-behavior-x em portal.html).
// v9 (2026-08-27): login persistente (localStorage) + botão "Sair" +
// campos de peso/repetições no treino (portal.html/portal.js). Relato de
// "app continua sambando pros lados" no PWA já instalado é quase certamente
// esse mesmo cache antigo nunca tendo sido invalidado (a correção do v8 só
// chega em quem instalou/atualizou DEPOIS daquele bump) — bumpar de novo
// aqui força o service worker a descartar o cache velho e buscar tudo de
// novo na próxima abertura do app.
// v10 (2026-08-27): o "sambando pros lados" voltou a acontecer DE VERDADE
// (não só cache velho) — reproduzido de forma consistente, sempre logo após
// o login automático novo do v9. Adicionado touch-action:pan-y (trava o
// gesto de pan horizontal do Safari em modo standalone, camada diferente do
// overflow-x já existente) + reforço do reset de scroll em dois momentos
// (portal.js, irParaTopo/tentarAutoLoginHub). Ver comentários grandes em
// portal.html e portal.js.
// v11 (2026-08-27): v10 não resolveu — piorou (usuário ficou travado sem
// conseguir arrastar de volta, porque touch-action:pan-y bloqueia o gesto
// de correção também). Solução estrutural: body virou position:fixed
// (não pode sofrer rubber-band, é física do WebKit) e todo o scroll de
// verdade passou pra um wrapper interno novo (#scroll-raiz). Ver comentário
// grande em portal.html.
// v12 (2026-08-29): "notificações ativadas" mas nunca chegava no celular —
// notificar_vencimento é preferência do CADASTRO (um valor só, qualquer
// aparelho), não prova que ESTE aparelho tem PushSubscription própria.
// Card de notificações agora confere com o service worker e mostra um
// botão "Ativar neste aparelho" quando faltar (portal.html/portal.js).
const CACHE_NAME = 'academia-shell-v12';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((c) => c !== CACHE_NAME).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // stale-while-revalidate: responde do cache na hora (funciona sem rede /
  // com rede ruim, importante pro totem físico) e atualiza em segundo plano.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cacheado = await cache.match(request);
      const buscaRede = fetch(request)
        .then((resposta) => {
          if (resposta && resposta.ok) cache.put(request, resposta.clone());
          return resposta;
        })
        .catch(() => cacheado);
      return cacheado || buscaRede;
    })
  );
});

// ---------------------------------------------------------------------------
// Web Push (2026-08-13) — só o portal do aluno assina (ver portal.js), mas
// o service worker é compartilhado com totem/painel, então o handler fica
// aqui junto com o resto. Payload sempre é JSON: { title, body, url, tag }
// (ver webPush.service.js, enviarParaAluno). `tag` (opcional) faz o
// navegador substituir uma notificação anterior com a mesma tag em vez de
// empilhar (ex.: várias notificações de "vencimento" não precisam de uma
// pra cada tentativa).
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Academia Superação', {
      body: payload.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: payload.tag || undefined,
      data: { url: payload.url || '/portal.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/portal.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const cliente of lista) {
        if ('focus' in cliente) { cliente.focus(); return undefined; }
      }
      return self.clients.openWindow(url);
    })
  );
});
