// The portal's offline shell.
//
// Caches same-origin static GETs as they are fetched, so that opening the
// installed app without a connection renders the portal's own "can't reach it"
// screen instead of the browser's error page.
//
// It does NOT cache any API response. A cached /api/devices would show a guest
// a lock reading "Locked" as of an hour ago — a confident, stale claim about a
// lock. Showing nothing is better than showing something false.
//
// The shell is only cached once a load has happened *through* the worker, which
// means the second online visit rather than the first. That is the deliberate
// price of runtime caching over a build-time precache manifest: no generated
// asset list, and a worker short enough to read in one sitting.
//
// Bump CACHE whenever what gets cached changes; `activate` drops every other
// cache, which is how an old shell is evicted.
const CACHE = 'portal-shell-v1'

self.addEventListener('install', (event) => {
  // Take over as soon as possible rather than waiting for every tab to close.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  // Someone else's origin, or a write. Not ours to touch.
  if (url.origin !== self.location.origin) return
  if (request.method !== 'GET') return

  // Never the API. Not cached, not intercepted — it fails as the network fails,
  // which is what the unreachable screen is waiting for.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    // Network-first: a reachable portal always wins, so an add-on update is
    // picked up on the next online load instead of being pinned by the cache.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE).then((cache) => cache.put('/', copy))
          }
          return response
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    )
    return
  }

  // Everything else is a static asset with a content-hashed name, so a cache
  // hit is always correct.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        }),
    ),
  )
})
