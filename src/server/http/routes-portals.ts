import type { Hono } from 'hono'
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
  const { portals, cfg, allowlist, ha, settings } = deps

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
      return c.json(PortalDetailResponse.parse(updated))
    } catch (error) {
      if (error instanceof DuplicatePasswordError) {
        return c.json({ error: error.message }, 409)
      }
      throw error
    }
  })

  app.delete('/api/admin/portals/:portalId', (c) => {
    portals.delete(c.req.param('portalId'))
    return c.json({ ok: true })
  })

  // GET/PUT allowlist for one portal — same payload shape as the old global
  // /api/admin/allowlist, now scoped by path param.
  app.get('/api/admin/portals/:portalId/allowlist', async (c) => {
    const portalId = c.req.param('portalId')
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

    settings.setLastSelectedPortalId(parseResult.data.portalId)
    return c.json({ ok: true })
  })
}
