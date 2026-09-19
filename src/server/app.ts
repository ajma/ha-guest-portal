import { readFileSync } from 'node:fs'
import { Hono, type MiddlewareHandler } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HttpBindings } from '@hono/node-server'
import type { Role } from '../shared/api.js'
import { createRoutes, type Deps } from './http/routes-guest.js'
import { mountAdminRoutes } from './http/routes-admin.js'
import { checkSession, isFromSupervisor } from './runtime.js'

export type Env = {
  Bindings: HttpBindings
  Variables: {
    role: Role
  }
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

  // Session-protected routes
  app.get('/api/session', requireSession, routes.session)
  app.get('/api/devices', requireSession, routes.devices)
  app.post('/api/devices/:entityId/:action', requireSession, routes.callAction)
  // /api/stream is handled in runtime.ts before Hono sees it

  // Admin routes (require session, then role check inside)
  app.use('/api/admin/*', requireSession)
  mountAdminRoutes(app, deps)

  // Static file serving with SPA fallback
  // Serve built SPA from dist/web
  app.use('/*', serveStatic({ root: './dist/web' }))

  // SPA fallback - serve index.html for non-API 404s
  app.use('/*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      // Let API routes 404 naturally
      return c.notFound()
    }

    // Serve index.html for SPA routing
    try {
      let html = readFileSync('./dist/web/index.html', 'utf-8')

      // Inject <base href> based on whether this is an ingress request
      const remoteAddress = c.env.incoming.socket.remoteAddress
      const isIngress = deps.cfg.ingressPort && isFromSupervisor(remoteAddress)
      const baseHref = isIngress ? c.req.header('x-ingress-path') ?? '/' : '/'

      // Ensure base href ends with /
      const normalizedBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`

      // Inject <base href> after <head> (handle whitespace-formatted HTML)
      html = html.replace(/(<head[^>]*>)/i, `$1\n    <base href="${normalizedBase}">`)

      return c.html(html)
    } catch {
      // index.html doesn't exist
      return c.notFound()
    }
  })

  return app
}
