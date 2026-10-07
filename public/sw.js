'use strict';
// Service worker simples: abre o app mesmo sem internet (mostra o último estado salvo no aparelho).
const VERSAO = 'gastos-v1';
const FONTES = 'gastos-fontes-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(['/icons/icon-192.png', '/icons/apple-touch-icon.png'])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO && n !== FONTES).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fontes do Google: guarda para funcionar offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONTES).then((cache) =>
        cache.match(req).then((hit) => {
          const rede = fetch(req).then((r) => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => hit);
          return hit || rede;
        })
      )
    );
    return;
  }

  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/sair') return;

  // Tela principal: rede primeiro, cópia guardada se estiver offline.
  if (req.mode === 'navigate' && url.pathname === '/') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok && !r.redirected) {
            const copia = r.clone();
            caches.open(VERSAO).then((c) => c.put('/', copia));
          }
          return r;
        })
        .catch(() => caches.open(VERSAO).then((c) => c.match('/')).then((hit) => hit || Response.error()))
    );
  }
});
