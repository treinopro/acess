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
// v13/v14 (2026-08-29): tentativa de travar o zoom (maximum-scale/
// minimum-scale=1.0 + user-scalable=no) pra acabar de vez com o "sambando
// pros lados". Causou um bug PIOR e diferente — margem enorme em volta do
// conteúdo, reproduzido em modo standalone tanto no Safari quanto no Chrome
// (mesmo motor WebKit no iOS) — bate com bug conhecido do WebKit ao travar
// zoom via viewport especificamente em PWA instalado.
// v15 (2026-08-30): REVERTE a trava de zoom — volta pro viewport simples
// (initial-scale=1.0 + viewport-fit=cover, sem user-scalable/min/max-scale).
// A defesa de verdade contra o "sambar" continua sendo o body em
// position:fixed (v11), que não depende de travar zoom nenhum. Ver
// comentário grande em portal.html.
// v16 (2026-08-30): viewport-fit=cover faz o FUNDO ocupar até embaixo do
// notch/barra de gestos do iPhone — mas sem compensar isso no conteúdo, o
// topo/rodapé de cada tela (título, botão "Concluir treino" etc.) também
// ficava embaixo dessas áreas, cortado/inalcançável mesmo rolando até o
// fim. Soma env(safe-area-inset-*) ao padding de cada tela (.pagina, ver
// portal.html) — vale 0 em aparelho sem notch/Android/desktop, só entra em
// ação no iPhone com notch/Dynamic Island.
// v17 (2026-08-31): v16 (env(safe-area-inset-bottom) + 60px) não foi
// suficiente na prática — ainda cortava no rodapé em teste real. Aumenta a
// folga fixa embaixo pra 140px (bem mais generoso), em vez de tentar
// acertar o valor exato do aparelho.
// v18 (2026-08-31): causa raiz de verdade do "corte no rodapé" finalmente
// identificada — os campos de peso/repetições do treino (portal.js) não
// tinham font-size definido, herdando o padrão do navegador (menor que
// 16px). iOS dá ZOOM AUTOMÁTICO ao focar qualquer campo com fonte menor
// que 16px, e esse zoom fica "grudado" ao navegar pras telas seguintes —
// exatamente o comportamento relatado (zoom ao tocar um campo, corte nas
// telas depois, só resolvia pinçando manualmente pra fora). Adiciona
// font-size:16px nos dois campos. As tentativas anteriores (position:fixed,
// travar/destravar zoom, aumentar padding) continuam válidas como reforço,
// mas não atacavam a causa raiz.
// v19 (2026-08-31): relato real após v18 — funciona certo na aba normal do
// Safari, mas o zoom automático ainda fica "grudado" especificamente no PWA
// instalado (modo standalone), mesmo com os campos já em 16px+. Duas
// camadas a mais: -webkit-text-size-adjust:100% (o zoom automático olha o
// tamanho RENDERIZADO final, não só o font-size declarado — isso evita o
// iOS reajustar sozinho) + reset forçado do <meta viewport> toda vez que
// um campo perde o foco (bug documentado: o zoom disparado ao focar não
// desfaz sozinho ao desfocar, em PWA standalone). Ver portal.html/portal.js.
// v20 (2026-08-31): relato real — v19 "soltou" o zoom grudado, mas deixou
// tudo com aparência zoomada pra fora (elementos pequenos, muita margem).
// Causa raiz de verdade dos dois bugs (o "sambar" antigo do v13/v14 E este)
// era a mesma: campo com font-size < 16px brigando com o zoom já travado
// no viewport. Corrigido o font-size (v18) — agora trava o zoom de novo
// (maximum-scale/minimum-scale=1.0 + user-scalable=no, ver portal.html) e
// remove o truque de reset no focusout (não precisa mais, causava a
// aparência zoomada). Também não recarrega mais os banners já fechados
// pelo aluno a cada reinstalação do PWA — isso é limite do próprio iOS
// (apagar o app apaga o localStorage), não bug do código.
const CACHE_NAME = 'academia-shell-v20';

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
