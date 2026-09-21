import { readFileSync } from 'node:fs'
import { Hono, type MiddlewareHandler, type Context } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HttpBindings } from '@hono/node-server'
import { DEFAULT_THEME_ID } from '../shared/themes.js'
import { createRoutes, type Deps } from './http/routes-guest.js'
import { mountAdminRoutes } from './http/routes-admin.js'
import { mountPortalRoutes } from './http/routes-portals.js'
import { mountIntegrationRoutes } from './http/routes-integration.js'
import { checkSession, isFromSupervisor } from './runtime.js'
import type { SessionData } from './http/auth.js'

export type Env = {
  Bindings: HttpBindings
  Variables: {
    session: SessionData
  }
}

const DEFAULT_WEB_ROOT = './dist/web'

function webRootFor(deps: Deps): string {
  return deps.cfg.webRoot ?? DEFAULT_WEB_ROOT
}

/**
 * The portal title is owner-supplied text going into two HTML contexts — a
 * double-quoted attribute and element text. Escaping these five characters
 * covers both. `&` must be replaced first, or the escapes introduced by the
 * later replacements would themselves be re-escaped.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * A pre-login request has no portal to theme for — there is no session cookie
 * yet, and Home Assistant's own frontend serving the ingress iframe hits this
 * same route as an admin who has not yet picked a portal from the dropdown.
 * Both get the neutral default theme and no title override; a reload after a
 * successful login re-renders themed, once there is a session to resolve.
 */
function themeAndTitleFor(
  deps: Deps,
  session: SessionData | null,
): { theme: string; title: string | null } {
  if (session === null) return { theme: DEFAULT_THEME_ID, title: null }

  if (session.role === 'guest') {
    const portal = deps.portals.get(session.portalId)
    if (portal === null) return { theme: DEFAULT_THEME_ID, title: null }
    return { theme: portal.theme, title: portal.title }
  }

  const lastSelected = deps.settings.getLastSelectedPortalId()
  const portal = lastSelected === null ? null : deps.portals.get(lastSelected)
  if (portal === null) return { theme: DEFAULT_THEME_ID, title: null }
  return { theme: portal.theme, title: portal.title }
}

/**
 * The theme lands on <html> rather than in a <meta> so the CSS variable block
 * keyed off [data-theme] applies during HTML parse, before React loads. That is
 * what makes the portal render themed on first paint with no API call. The
 * title rides along for the same reason, and because guests need it while
 * having no admin endpoint to read it from.
 *
 * Returns null when index.html is missing (an unbuilt checkout).
 */
function renderIndexHtml(deps: Deps, baseHref: string, session: SessionData | null): string | null {
  let html: string
  try {
    html = readFileSync(`${webRootFor(deps)}/index.html`, 'utf-8')
  } catch {
    return null
  }

  const normalizedBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`
  const escapedBase = escapeHtml(normalizedBase)
  const { theme, title } = themeAndTitleFor(deps, session)

  let html2 = html
    .replace(/(<head[^>]*>)/i, (head) => `${head}\n    <base href="${escapedBase}">`)
    .replace(
      /<html/i,
      () => `<html data-theme="${theme}" data-ingress-base="${escapedBase}"`,
    )

  // The two title-bearing replacements take a *function*, not a string. A
  // string replacement expands `$&`, `` $` `` and `$'`, and escaping does not
  // defuse them — `$&` escapes to `$&amp;`, which still starts `$&` — so a
  // title containing one would splice the matched tag into its own attribute.
  if (title !== null) {
    const escapedTitle = escapeHtml(title)
    html2 = html2
      .replace(/<html([^>]*)>/i, (_full, attrs: string) => `<html${attrs} data-portal-title="${escapedTitle}">`)
      .replace(/<title>[^<]*<\/title>/i, () => `<title>${escapedTitle}</title>`)
  }

  return html2
}

function baseHrefFor(c: Context<Env>, deps: Deps): string {
  const remoteAddress = c.env.incoming.socket.remoteAddress
  const isIngress = deps.cfg.ingressPort && isFromSupervisor(remoteAddress)
  return isIngress ? (c.req.header('x-ingress-path') ?? '/') : '/'
}

function sessionFromRequest(c: Context<Env>, deps: Deps): SessionData | null {
  const remoteAddress = c.env.incoming.socket.remoteAddress
  if (deps.cfg.ingressPort && isFromSupervisor(remoteAddress)) {
    return { role: 'admin', expiresAt: Number.POSITIVE_INFINITY }
  }
  return checkSession(c.req.header('cookie'), deps.sessions)
}

export function createApp(deps: Deps) {
  const app = new Hono<Env>()

  const ingressMiddleware: MiddlewareHandler<Env> = async (c, next) => {
    const remoteAddress = c.env.incoming.socket.remoteAddress

    if (deps.cfg.ingressPort && isFromSupervisor(remoteAddress)) {
      c.set('session', { role: 'admin', expiresAt: Number.POSITIVE_INFINITY })
      await next()
      return
    }

    await next()
  }

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const existing = c.get('session')
    if (existing) {
      await next()
      return
    }

    const session = checkSession(c.req.header('cookie'), deps.sessions)

    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    c.set('session', session)
    await next()
  }

  app.use('*', ingressMiddleware)

  const routes = createRoutes(deps)

  app.post('/api/login', routes.login)
  app.post('/api/logout', routes.logout)
  app.get('/api/health', routes.health)

  mountIntegrationRoutes(app, deps)

  app.get('/api/session', requireSession, routes.session)
  app.get('/api/devices', requireSession, routes.devices)
  app.post('/api/devices/:entityId/:action', requireSession, routes.callAction)
  // /api/stream is handled in runtime.ts before Hono sees it

  app.use('/api/admin/*', requireSession)
  mountAdminRoutes(app, deps)
  mountPortalRoutes(app, deps)

  // serveStatic resolves / to index.html and would answer before the SPA
  // fallback, so the root URL would never be injected. Handle it explicitly.
  app.get('/', (c) => {
    const session = sessionFromRequest(c, deps)
    const html = renderIndexHtml(deps, baseHrefFor(c, deps), session)
    return html === null ? c.notFound() : c.html(html)
  })

  // Similarly, /index.html must be injected. serveStatic would serve it raw.
  app.get('/index.html', (c) => {
    const session = sessionFromRequest(c, deps)
    const html = renderIndexHtml(deps, baseHrefFor(c, deps), session)
    return html === null ? c.notFound() : c.html(html)
  })

  app.use('/*', serveStatic({ root: webRootFor(deps) }))

  app.use('/*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.notFound()
    }

    const session = sessionFromRequest(c, deps)
    const html = renderIndexHtml(deps, baseHrefFor(c, deps), session)
    return html === null ? c.notFound() : c.html(html)
  })

  return app
}
