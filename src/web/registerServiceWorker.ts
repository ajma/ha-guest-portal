/**
 * Registering is a progressive enhancement and must never block boot: no
 * support, an insecure context, or a rejected registration all leave the app
 * working exactly as it does without a worker.
 *
 * `/sw.js` is absolute on purpose. The scope of a worker is the directory it is
 * served from, so a worker registered from a subpath would not control the
 * root, and the built assets use a relative base for ingress.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  try {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Deliberately silent. There is nothing a guest can do about it, and the
      // portal works without it.
    })
  } catch {
    // Some browsers throw out of `register` rather than rejecting — a disabled
    // worker registry, or an origin the browser refuses outright. Same
    // treatment: the portal works without it.
  }
}
