// בוט השירים – מאפשר התקנה כאפליקציה, התראות, ופתיחה מהירה של האתר
const CACHE = 'music-bot-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'manifest.json', 'icon-192.png', 'icon-512.png'])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// הדף עצמו: קודם מהאינטרנט (תמיד הגרסה החדשה), ואם אין חיבור – מהזיכרון
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && (e.request.mode === 'navigate' || /\.(png|json)$/.test(u.pathname))) {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request.mode === 'navigate' ? './' : e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request.mode === 'navigate' ? './' : e.request)));
});
// לחיצה על התראה פותחת את האתר
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
