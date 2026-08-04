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
const CACHE_NAME = 'academia-shell-v1';

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
