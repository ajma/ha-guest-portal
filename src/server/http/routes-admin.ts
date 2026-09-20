import type { Hono } from 'hono'
import type { Env } from '../app.js'
import type { Deps } from './routes-guest.js'
import {
  AdminPortalPutRequest,
  AdminPortalResponse,
  AdminThemePutRequest,
  AllowlistPutRequest,
  AllowlistResponse,
  CatalogResponse,
} from '../../shared/api.js'

export function mountAdminRoutes(app: Hono<Env>, deps: Deps): void {
  const { ha, allowlist, settings } = deps

  // Middleware to require admin role
  app.use('/api/admin/*', async (c, next) => {
    const role = c.var.role

    if (!role) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    if (role !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403)
    }

    await next()
  })

  // GET /api/admin/entities - full catalog from Home Assistant
  app.get('/api/admin/entities', async (c) => {
    const catalog = await ha.getCatalog()
    return c.json(CatalogResponse.parse({ entities: catalog }))
  })

  // GET /api/admin/allowlist - current allowlist + orphaned entities
  app.get('/api/admin/allowlist', async (c) => {
    const devices = allowlist.list()
    const catalog = await ha.getCatalog()

    // Build set of entity IDs in the catalog
    const catalogEntityIds = new Set(catalog.map((entry) => entry.entityId))

    // Find orphaned entities (in allowlist but not in catalog)
    const orphaned = devices
      .filter((device) => !catalogEntityIds.has(device.entityId))
      .map((device) => device.entityId)

    return c.json(AllowlistResponse.parse({ devices, orphaned }))
  })

  // PUT /api/admin/allowlist - validate and replace allowlist
  app.put('/api/admin/allowlist', async (c) => {
    // Parse and validate request body
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = AllowlistPutRequest.safeParse(body)

    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      const errorMessage = firstIssue ? firstIssue.message : 'Invalid request'
      return c.json({ error: errorMessage }, 400)
    }

    // Replace allowlist (will trigger onChange handler)
    allowlist.replace(parseResult.data.devices)

    return c.json({ ok: true })
  })

  // GET /api/admin/portal - toggle state plus the credentials needed to set up
  // the Home Assistant integration by hand (non-add-on deployments).
  app.get('/api/admin/portal', (c) => {
    return c.json(
      AdminPortalResponse.parse({
        enabled: settings.getPortalEnabled(),
        integrationToken: settings.getIntegrationToken(),
        portalId: settings.getPortalId(),
        theme: settings.getTheme(),
      }),
    )
  })

  // PUT /api/admin/portal - enable or disable the guest surface
  app.put('/api/admin/portal', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = AdminPortalPutRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      const errorMessage = firstIssue ? firstIssue.message : 'Invalid request'
      return c.json({ error: errorMessage }, 400)
    }

    settings.setPortalEnabled(parseResult.data.enabled)

    return c.json({ enabled: parseResult.data.enabled })
  })

  // PUT /api/admin/theme - choose the guest-facing theme
  app.put('/api/admin/theme', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = AdminThemePutRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    settings.setTheme(parseResult.data.theme)

    return c.json({ theme: parseResult.data.theme })
  })
}
