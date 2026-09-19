import { Hono, type MiddlewareHandler } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Role } from '../shared/api.js'
import { createRoutes, type Deps } from './http/routes-guest.js'
import { mountAdminRoutes } from './http/routes-admin.js'
import { checkSession } from './runtime.js'

export type Env = {
  Variables: {
    role: Role
  }
}

export function createApp(deps: Deps) {
  const app = new Hono<Env>()

  // Session middleware for protected routes
  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const cookie = c.req.header('cookie')
    const role = checkSession(cookie, deps.sessions)

    if (!role) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    c.set('role', role)
    await next()
  }

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
      const { readFileSync } = await import('node:fs')
      const html = readFileSync('./dist/web/index.html', 'utf-8')
      return c.html(html)
    } catch {
      // index.html doesn't exist
      return c.notFound()
    }
  })

  return app
}
