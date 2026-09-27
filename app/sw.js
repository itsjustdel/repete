// Service worker: app shell precache, network-first phrase list, cache-first audio.
// __BUILD_ID__ and __APP_FILES__ are filled in by scripts/build.py.
const BUILD = '__BUILD_ID__';
const APP_FILES = __APP_FILES__;
const SHELL_CACHE = `repete-shell-${BUILD}`;
const DATA_CACHE = 'repete-data';
const AUDIO_CACHE = 'repete-audio'; // shared with js/app.js, which fills it in the background

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(APP_FILES.map(f => new Request(f, { cache: 'reload' }))))
  );
  // First install activates immediately; later updates wait for the page to ask (see app.js).
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('repete-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  const path = url.pathname.slice(scope.pathname.length);

  if (path.startsWith('audio/')) {
    event.respondWith(audioResponse(req));
  } else if (path === 'data/phrases.json') {
    event.respondWith(networkFirst(req, DATA_CACHE, 4000));
  } else if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./', { cacheName: SHELL_CACHE }).then(r => r || fetch(req))
    );
  } else {
    event.respondWith(
      caches.match(req, { cacheName: SHELL_CACHE, ignoreSearch: true }).then(r => r || fetch(req))
    );
  }
});

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  const key = req.url.split('?')[0];
  try {
    const res = await Promise.race([
      fetch(req, { cache: 'no-cache' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw err;
  }
}

// Audio files are content-addressed (the name is a hash), so a cached copy
// never goes stale. Media elements send Range requests; answer them with a
// proper 206 built from the cached file so seeking/looping works offline.
async function audioResponse(req) {
  const cache = await caches.open(AUDIO_CACHE);
  const key = req.url.split('?')[0];
  let res = await cache.match(key);
  if (!res) {
    res = await fetch(key); // full file, no Range, so it can be cached whole
    if (!res.ok) return res;
    await cache.put(key, res.clone());
  }
  const range = req.headers.get('range');
  if (!range) return res;

  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } // suffix range
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
