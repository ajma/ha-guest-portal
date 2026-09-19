import { createHash, timingSafeEqual } from 'node:crypto'
import type { Hono, MiddlewareHandler } from 'hono'
import type { Env } from '../app.js'
import type { Deps } from './routes-guest.js'
import { IntegrationEnabledRequest, IntegrationStateResponse } from '../../shared/api.js'

/**
 * Reported to the Home Assistant integration so it can raise a repair issue
 * against an add-on too old to speak its protocol, rather than failing on a
 * missing field. Bump when the shape of /api/integration/state changes.
 */
export const INTEGRATION_API_VERSION = '1.0.0'

function tokenMatches(supplied: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual always sees equal-length buffers.
  const suppliedHash = createHash('sha256').update(supplied, 'utf8').digest()
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest()

  try {
    return timingSafeEqual(suppliedHash, expectedHash)
  } catch {
    return false
  }
}

/**
 * Bearer-token routes for the Home Assistant integration.
 *
 * Deliberately no cookie or session path: this is a machine client. The token
 * opens exactly these two routes — it cannot read or write the allowlist, read
 * the audit log, or log in. It is served on the LAN-facing port because the
 * plain Docker deployment has no Supervisor network available.
 */
export function mountIntegrationRoutes(app: Hono<Env>, deps: Deps): void {
  const { allowlist, ha, settings, interactions } = deps

  const requireToken: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header('authorization')

    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const supplied = header.slice('Bearer '.length).trim()

    if (!tokenMatches(supplied, settings.getIntegrationToken())) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  }

  app.use('/api/integration/*', requireToken)

  app.get('/api/integration/state', (c) => {
    return c.json(
      IntegrationStateResponse.parse({
        portalId: settings.getPortalId(),
        enabled: settings.getPortalEnabled(),
        haStale: ha.stale,
        deviceCount: allowlist.list().length,
        version: INTEGRATION_API_VERSION,
        lastInteraction: interactions.latest(),
      }),
    )
  })

  app.post('/api/integration/enabled', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = IntegrationEnabledRequest.safeParse(body)
    if (!parseResult.success) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    settings.setPortalEnabled(parseResult.data.enabled)

    return c.json({ enabled: parseResult.data.enabled })
  })
}
