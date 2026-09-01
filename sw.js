/* breathe — service worker.
   ---------------------------------------------------------------------------
   Two jobs, and only two.

   1. The app works with no network. It is a thing you use lying down with your
      eyes shut; needing a connection to start it is absurd.

   2. A new version is something you are told about and choose, rather than
      something you have to outwit the cache to get. Added to the Home Screen
      the app runs standalone — no address bar, no pull-to-refresh — and iOS
      will serve the copy it has, indefinitely, including in answer to
      location.reload(). Before this, the only reliable fix was deleting the
      icon and adding it again.

   What it never does: talk to anything but this app's own origin. There are no
   third-party requests to intercept because the app makes none — no fonts, no
   analytics, no error reporting — and this file adds none. Recordings live in
   IndexedDB and are not touched here.

   VERSION must match RELEASES[0].v in src/main.js. There is no build step to
   keep them in step, so tools/smoke.mjs asserts it, along with the precache
   list covering everything in src/. */

const VERSION = '0.19.0';
const CACHE = 'breathe-' + VERSION;

/* The whole app, precached as one set. Cache-first inside a version-named
   cache is what stops a half-updated app: a fresh index.html cannot end up
   driving last week's modules, because the two only ever come from the same
   cache and that cache is thrown away whole. */
const SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icon.png',
  './src/main.js',
  './src/util.js',
  './src/i18n.js',
  './src/audio.js',
  './src/breath.js',
  './src/pulse.js',
  './src/hr.js',
  './src/store.js',
  './src/review.js',
];

self.addEventListener('install', event => {
  // No skipWaiting here on purpose. A new worker sits in `waiting` until the
  // page asks for it, so an update never swaps the code out from under a
  // running session.
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      // addAll is all-or-nothing, which is the point: a version that failed to
      // cache one module must not become the version that serves the app.
      cache.addAll(SHELL)
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => n === CACHE ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;   // nothing else is ours to answer

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // A navigation may carry the cache-busting query the old Reload button
    // added, so match on the path alone.
    const hit = await cache.match(req, {ignoreSearch: true});
    if(hit) return hit;

    try{
      const res = await fetch(req);
      // Only this app's own files are worth keeping, and only when they came
      // back whole. An opaque or partial response cached here would be served
      // forever, since nothing revalidates inside a version.
      if(res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }catch(err){
      // Offline and not in the cache. For a navigation, the app shell is a far
      // better answer than a browser error page.
      if(req.mode === 'navigate'){
        const shell = await cache.match('./index.html');
        if(shell) return shell;
      }
      throw err;
    }
  })());
});

self.addEventListener('message', event => {
  const msg = event.data;
  if(msg === 'skip-waiting') self.skipWaiting();
  else if(msg === 'version') event.source && event.source.postMessage({version: VERSION});
});
