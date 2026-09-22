import type { Context, Hono } from 'hono'
import type { Env } from '../app.js'
import type { Deps } from './routes-guest.js'
import { verifyPassword } from './auth.js'
import { DuplicatePasswordError } from '../store/portals.js'
import {
  DeploymentSettingsResponse,
  LastSelectedPortalPutRequest,
  PortalCreateRequest,
  PortalDetailResponse,
  PortalPutRequest,
  PortalsListResponse,
  AllowlistPutRequest,
  AllowlistResponse,
} from '../../shared/api.js'

export function mountPortalRoutes(app: Hono<Env>, deps: Deps): void {
  const { portals, cfg, allowlist, ha, settings, sessions, hub } = deps

  // Every admin route below names a portal in its path or its body. They all
  // answer the same way when it does not exist, so that a typo reads as a typo
  // rather than as a broken server or a portal with nothing in it.
  function notFound(c: Context<Env>) {
    return c.json({ error: 'Not found' }, 404)
  }

  function collidesWithAdminPassword(password: string): boolean {
    return cfg.adminPassword !== undefined && verifyPassword(password, cfg.adminPassword)
  }

  app.get('/api/admin/portals', (c) => {
    return c.json(
      PortalsListResponse.parse({
        portals: portals.list(),
        lastSelectedPortalId: settings.getLastSelectedPortalId(),
      }),
    )
  })

  app.post('/api/admin/portals', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = PortalCreateRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    if (collidesWithAdminPassword(parseResult.data.password)) {
      return c.json({ error: 'That password is already in use' }, 409)
    }

    try {
      const created = portals.create(parseResult.data)
      return c.json(PortalDetailResponse.parse(created))
    } catch (error) {
      if (error instanceof DuplicatePasswordError) {
        return c.json({ error: error.message }, 409)
      }
      throw error
    }
  })

  app.get('/api/admin/portals/:portalId', (c) => {
    const portal = portals.get(c.req.param('portalId'))
    if (portal === null) return c.json({ error: 'Not found' }, 404)
    return c.json(PortalDetailResponse.parse(portal))
  })

  app.put('/api/admin/portals/:portalId', async (c) => {
    const portalId = c.req.param('portalId')
    if (portals.get(portalId) === null) return c.json({ error: 'Not found' }, 404)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = PortalPutRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    if (
      parseResult.data.password !== undefined &&
      collidesWithAdminPassword(parseResult.data.password)
    ) {
      return c.json({ error: 'That password is already in use' }, 409)
    }

    // Spread conditionally rather than pass parseResult.data straight through:
    // under exactOptionalPropertyTypes, PortalStore.update's patch type wants
    // an optional key to be present-or-absent, not present-and-undefined.
    const { title, theme, enabled, password } = parseResult.data
    try {
      const updated = portals.update(portalId, {
        ...(title !== undefined && { title }),
        ...(theme !== undefined && { theme }),
        ...(enabled !== undefined && { enabled }),
        ...(password !== undefined && { password }),
      })

      // A rotated password revokes the credential those guest sessions were
      // issued against, so they must not survive it. Their streams are dropped
      // too, or they would keep receiving updates until their next poll.
      if (password !== undefined) {
        sessions.destroyPortalSessions(portalId)
        hub.closePortalGuests(portalId)
      }

      return c.json(PortalDetailResponse.parse(updated))
    } catch (error) {
      if (error instanceof DuplicatePasswordError) {
        return c.json({ error: error.message }, 409)
      }
      throw error
    }
  })

  app.delete('/api/admin/portals/:portalId', (c) => {
    const deleted = portals.delete(c.req.param('portalId'))
    if (!deleted) return notFound(c)
    return c.json({ ok: true })
  })

  // GET/PUT allowlist for one portal — same payload shape as the old global
  // /api/admin/allowlist, now scoped by path param.
  app.get('/api/admin/portals/:portalId/allowlist', async (c) => {
    const portalId = c.req.param('portalId')
    if (portals.get(portalId) === null) return notFound(c)

    const devices = allowlist.list(portalId)
    const catalog = await ha.getCatalog()

    const catalogEntityIds = new Set(catalog.map((entry) => entry.entityId))
    const orphaned = devices
      .filter((device) => !catalogEntityIds.has(device.entityId))
      .map((device) => device.entityId)

    return c.json(AllowlistResponse.parse({ devices, orphaned }))
  })

  app.put('/api/admin/portals/:portalId/allowlist', async (c) => {
    const portalId = c.req.param('portalId')
    if (portals.get(portalId) === null) return notFound(c)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = AllowlistPutRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    allowlist.replace(portalId, parseResult.data.devices)
    return c.json({ ok: true })
  })

  app.get('/api/admin/settings', (c) => {
    return c.json(
      DeploymentSettingsResponse.parse({
        integrationToken: settings.getIntegrationToken(),
        deploymentId: settings.getDeploymentId(),
      }),
    )
  })

  app.put('/api/admin/last-selected-portal', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = LastSelectedPortalPutRequest.safeParse(body)
    if (!parseResult.success) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    if (portals.get(parseResult.data.portalId) === null) return notFound(c)

    settings.setLastSelectedPortalId(parseResult.data.portalId)
    return c.json({ ok: true })
  })
}
