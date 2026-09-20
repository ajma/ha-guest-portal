import { readFileSync } from 'node:fs'
import { Hono, type MiddlewareHandler, type Context } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HttpBindings } from '@hono/node-server'
import type { Role } from '../shared/api.js'
import { createRoutes, type Deps } from './http/routes-guest.js'
import { mountAdminRoutes } from './http/routes-admin.js'
import { mountIntegrationRoutes } from './http/routes-integration.js'
import { checkSession, isFromSupervisor } from './runtime.js'

export type Env = {
  Bindings: HttpBindings
  Variables: {
    role: Role
  }
}

/**
 * Read index.html and inject the two things the client cannot know for itself:
 * the ingress base path, and the active theme.
 *
 * The theme lands on <html> rather than in a <meta> so the CSS variable block
 * keyed off [data-theme] applies during HTML parse, before React loads. That is
 * what makes the portal render themed on first paint with no API call.
 *
 * Returns null when index.html is missing (an unbuilt checkout).
 */
const DEFAULT_WEB_ROOT = './dist/web'

function webRootFor(deps: Deps): string {
  return deps.cfg.webRoot ?? DEFAULT_WEB_ROOT
}

function renderIndexHtml(deps: Deps, baseHref: string): string | null {
  let html: string
  try {
    html = readFileSync(`${webRootFor(deps)}/index.html`, 'utf-8')
  } catch {
    return null
  }

  const normalizedBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`

  return html
    .replace(/(<head[^>]*>)/i, `$1\n    <base href="${normalizedBase}">`)
    .replace(/<html/i, `<html data-theme="${deps.settings.getTheme()}"`)
}

function baseHrefFor(c: Context<Env>, deps: Deps): string {
  const remoteAddress = c.env.incoming.socket.remoteAddress
  const isIngress = deps.cfg.ingressPort && isFromSupervisor(remoteAddress)
  return isIngress ? (c.req.header('x-ingress-path') ?? '/') : '/'
}

export function createApp(deps: Deps) {
  const app = new Hono<Env>()

  // Ingress middleware - check if request is from Supervisor
  // If so, grant admin role (ingress handler already enforced source check)
  const ingressMiddleware: MiddlewareHandler<Env> = async (c, next) => {
    const remoteAddress = c.env.incoming.socket.remoteAddress

    // If ingress is enabled and request is from Supervisor, grant admin
    if (deps.cfg.ingressPort && isFromSupervisor(remoteAddress)) {
      c.set('role', 'admin')
      await next()
      return
    }

    // Not from Supervisor - continue to session middleware
    await next()
  }

  // Session middleware for protected routes (direct port only)
  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    // If role is already set by ingress middleware, skip session check
    const existingRole = c.get('role')
    if (existingRole) {
      await next()
      return
    }

    const cookie = c.req.header('cookie')
    const role = checkSession(cookie, deps.sessions)

    if (!role) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    c.set('role', role)
    await next()
  }

  // Apply ingress middleware to all routes
  app.use('*', ingressMiddleware)

  const routes = createRoutes(deps)

  // Auth routes (no session required)
  app.post('/api/login', routes.login)
  app.post('/api/logout', routes.logout)
  app.get('/api/health', routes.health)

  // Integration routes (bearer token, no session)
  mountIntegrationRoutes(app, deps)

  // Session-protected routes
  app.get('/api/session', requireSession, routes.session)
  app.get('/api/devices', requireSession, routes.devices)
  app.post('/api/devices/:entityId/:action', requireSession, routes.callAction)
  // /api/stream is handled in runtime.ts before Hono sees it

  // Admin routes (require session, then role check inside)
  app.use('/api/admin/*', requireSession)
  mountAdminRoutes(app, deps)

  // serveStatic resolves / to index.html and would answer before the SPA
  // fallback, so the root URL would never be injected. Handle it explicitly.
  app.get('/', (c) => {
    const html = renderIndexHtml(deps, baseHrefFor(c, deps))
    return html === null ? c.notFound() : c.html(html)
  })

  // Similarly, /index.html must be injected. serveStatic would serve it raw.
  app.get('/index.html', (c) => {
    const html = renderIndexHtml(deps, baseHrefFor(c, deps))
    return html === null ? c.notFound() : c.html(html)
  })

  // Static file serving with SPA fallback
  // Serve built SPA from the configured web root (the build output by default)
  app.use('/*', serveStatic({ root: webRootFor(deps) }))

  // SPA fallback - serve index.html for non-API 404s
  app.use('/*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.notFound()
    }

    const html = renderIndexHtml(deps, baseHrefFor(c, deps))
    return html === null ? c.notFound() : c.html(html)
  })

  return app
}
