// This harness builds its own minimal Hono app around mountAdminRoutes
// instead of going through createApp/createRuntime. app.ts/runtime.ts are
// still on the pre-multi-portal API (SettingsStore lost its title/theme/
// portal-enabled methods, Config lost `guestPassword`, login now resolves
// guests through PortalStore) and won't be rewritten until Task 15. Sessions
// are created directly via SessionStore, bypassing the password/portal login
// flow entirely, since this file only needs to exercise the admin-role gate
// and the entity catalog route — neither of which involves login.
// test/integration/routes-portals.test.ts (Task 10) established the bare-Hono
// -app half of this pattern; it still drives real /api/login for its own
// tests since portal creation is what it's actually testing.
import type { Server } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { createServer } from 'node:http'
import { Hono, type MiddlewareHandler } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import type { Env } from '../../src/server/app.ts'
import { mountAdminRoutes } from '../../src/server/http/routes-admin.ts'
import type { Deps } from '../../src/server/http/routes-guest.ts'
import { LoginRateLimiter, SESSION_COOKIE, SessionStore } from '../../src/server/http/auth.ts'
import { SseHub } from '../../src/server/http/sse.ts'
import { AllowlistStore } from '../../src/server/store/allowlist.ts'
import { AuditLog } from '../../src/server/store/auditlog.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'
import { PortalStore } from '../../src/server/store/portals.ts'
import { openDb } from '../../src/server/store/db.ts'
import type { Config } from '../../src/server/config.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

function buildApp(deps: Deps) {
  const app = new Hono<Env>()

  const attachSession: MiddlewareHandler<Env> = async (c, next) => {
    const cookie = c.req.header('cookie')
    const match = cookie ? new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie) : null
    const sessionId = match?.[1]
    const session = sessionId ? deps.sessions.get(sessionId) : undefined
    if (session) {
      c.set('role', session as unknown as Env['Variables']['role'])
    }
    await next()
  }

  app.use('/api/admin/*', attachSession)
  mountAdminRoutes(app, deps)

  return app
}

describe('Admin API routes', () => {
  let fake: FakeHomeAssistant
  let server: Server
  let baseUrl: string
  let db: import('node:sqlite').DatabaseSync
  let haClient: HaClient
  let sessions: SessionStore
  let adminCookie: string
  let guestCookie: string

  beforeEach(async () => {
    fake = await FakeHomeAssistant.start({ token: 'test-ha-token' })
    fake.seed(
      [
        { entityId: 'light.porch', state: 'off', name: 'Porch Light', areaId: 'area1' },
        { entityId: 'light.kitchen', state: 'on', name: 'Kitchen Light', areaId: 'area2' },
        { entityId: 'lock.front', state: 'locked', name: 'Front Lock', areaId: 'area1' },
        { entityId: 'switch.fan', state: 'off', name: 'Ceiling Fan', areaId: null },
        { entityId: 'climate.living', state: 'off', name: 'Living Room AC', areaId: 'area3' },
      ],
      [
        { areaId: 'area1', name: 'Entrance' },
        { areaId: 'area2', name: 'Kitchen' },
        { areaId: 'area3', name: 'Living Room' },
      ],
    )

    db = openDb(':memory:')
    sessions = new SessionStore()

    const cfg: Config = {
      haBaseUrl: fake.baseUrl,
      haWsUrl: undefined,
      haToken: fake.token,
      adminPassword: 'admin-pass-87654321',
      port: 8080,
      ingressPort: undefined,
      dbPath: ':memory:',
      trustProxy: undefined,
    }

    haClient = HaClient.create({ haBaseUrl: fake.baseUrl, haToken: fake.token })
    haClient.start()

    // Wait for HA client to connect
    await new Promise((resolve) => setTimeout(resolve, 100))

    const deps: Deps = {
      cfg,
      ha: haClient,
      allowlist: new AllowlistStore(db),
      audit: new AuditLog(db),
      settings: new SettingsStore(db),
      interactions: new InteractionStore(db),
      portals: new PortalStore(db),
      sessions,
      limiter: new LoginRateLimiter({ perIpMax: 10, windowMs: 60_000 }),
      hub: new SseHub(),
    }

    const app = buildApp(deps)
    server = createServer(getRequestListener(app.fetch))

    // Start listening
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })

    adminCookie = `${SESSION_COOKIE}=${sessions.create({ role: 'admin' })}`
    guestCookie = `${SESSION_COOKIE}=${sessions.create({ role: 'guest', portalId: 'test-portal' })}`
  })

  afterEach(async () => {
    await haClient.stop()

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    await fake.stop()

    db.close()
  })

  describe('GET /api/admin/entities', () => {
    it('returns 401 when no session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`)
      expect(res.status).toBe(401)
    })

    it('returns 403 when guest session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`, {
        headers: { Cookie: guestCookie },
      })
      expect(res.status).toBe(403)
    })

    it('returns 200 with catalog when admin session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveProperty('entities')
      expect(Array.isArray(body.entities)).toBe(true)
      expect(body.entities.length).toBeGreaterThan(0)
    })

    it('catalog includes area and supported flag', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      const porch = body.entities.find((e: { entityId: string }) => e.entityId === 'light.porch')
      expect(porch).toBeDefined()
      expect(porch).toHaveProperty('area')
      expect(porch).toHaveProperty('supported')
    })

    it('catalog includes unsupported entities', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      const climate = body.entities.find(
        (e: { entityId: string }) => e.entityId === 'climate.living',
      )
      expect(climate).toBeDefined()
      expect(climate.supported).toBe(false)
    })
  })
})
