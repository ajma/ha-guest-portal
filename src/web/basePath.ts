/**
 * The server writes the ingress base path onto <html> in the same pass as the
 * theme and title (see `renderIndexHtml` in server/app.ts), because under
 * Supervisor ingress the page is served from a per-session prefix
 * (`/api/hassio_ingress/<token>/`) that only `<base href>` knows about.
 *
 * `<base href>` resolves *relative* URLs for free, but every client-side
 * network call in this app is a root-absolute path (`/api/session`,
 * `/api/stream`, `/sw.js`) so the browser resolves it against its own origin
 * root — Home Assistant's frontend, not this add-on — and never reaches the
 * container. `apiUrl` is how those call sites opt back in to the prefix.
 */
export function readBasePath(): string {
  return document.documentElement.dataset.ingressBase ?? '/'
}

/**
 * Join the ingress base path onto a root-absolute path without producing a
 * double slash.
 *
 * `path` always starts with `/`, and the base (when set) always ends with
 * `/` — the server normalises it that way before writing the attribute — so
 * dropping the base's trailing slash before concatenating is enough to avoid
 * the double slash in the ingress case, and reduces to the path unchanged
 * when the base is the root `/`.
 */
export function apiUrl(path: string): string {
  const base = readBasePath()
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmedBase}${path}`
}
