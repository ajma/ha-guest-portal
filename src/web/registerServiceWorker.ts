import { apiUrl, readBasePath } from './basePath.js'

/**
 * Registering is a progressive enhancement and must never block boot: no
 * support, an insecure context, or a rejected registration all leave the app
 * working exactly as it does without a worker.
 *
 * `/sw.js` is root-absolute, but under ingress the page itself lives under a
 * per-session prefix (`/api/hassio_ingress/<token>/`), so both the script URL
 * and the registration scope need `apiUrl`/`readBasePath` — otherwise the
 * browser would look for the worker at the real origin root, where this
 * add-on never answers, and even a successful registration from the wrong
 * scope would not control the page that requested it.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  try {
    navigator.serviceWorker.register(apiUrl('/sw.js'), { scope: readBasePath() }).catch(() => {
      // Deliberately silent. There is nothing a guest can do about it, and the
      // portal works without it.
    })
  } catch {
    // Some browsers throw out of `register` rather than rejecting — a disabled
    // worker registry, or an origin the browser refuses outright. Same
    // treatment: the portal works without it.
  }
}
