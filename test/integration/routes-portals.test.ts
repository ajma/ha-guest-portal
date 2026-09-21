// Task 15 wires mountPortalRoutes into app.ts alongside mountAdminRoutes.
// Until then, app.ts/runtime.ts remain on the pre-multi-portal API (and
// routes-admin.ts's admin-role gate still compares the session's `role`
// context value to the string 'admin', which broke when routes-guest.ts
// started storing the full SessionData object there in Task 9). This file
// builds its own minimal harness — mounting mountPortalRoutes directly onto
// a bare Hono app with its own session/admin-role middleware — rather than
// going through createApp/createRuntime, so it isn't coupled to that
// still-pending rewrite.
import type { Server } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { createServer } from 'node:http'
import { Hono, type MiddlewareHandler } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import type { Env } from '../../src/server/app.ts'
import { createRoutes, type Deps } from '../../src/server/http/routes-guest.ts'
import { mountPortalRoutes } from '../../src/server/http/routes-portals.ts'
import {
  LoginRateLimiter,
  SESSION_COOKIE,
  SessionStore,
  type SessionData,
} from '../../src/server/http/auth.ts'
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
  const routes = createRoutes(deps)
  app.post('/api/login', routes.login)

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const cookie = c.req.header('cookie')
    const match = cookie ? new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie) : null
    const sessionId = match?.[1]
    const session = sessionId ? deps.sessions.get(sessionId) : undefined
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    c.set('role', session as unknown as Env['Variables']['role'])
    await next()
  }

  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
    const session = c.get('role') as unknown as SessionData
    if (session.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    await next()
  }

  app.use('/api/admin/*', requireSession, requireAdmin)
  mountPortalRoutes(app, deps)

  return app
}

describe('portal management routes', () => {
  let fake: FakeHomeAssistant
  let server: Server
  let baseUrl: string
  let db: import('node:sqlite').DatabaseSync
  let haClient: HaClient
  let allowlist: AllowlistStore
  let audit: AuditLog
  let settings: SettingsStore
  let interactions: InteractionStore
  let portals: PortalStore
  let sessions: SessionStore
  let limiter: LoginRateLimiter
  let hub: SseHub
  let cfg: Config

  async function loginAsAdmin(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: cfg.adminPassword }),
    })
    const cookie = res.headers.get('set-cookie')
    if (!cookie) throw new Error('admin login did not set a cookie')
    return cookie
  }

  beforeEach(async () => {
    fake = await FakeHomeAssistant.start({ token: 'test-ha-token' })
    fake.seed([{ entityId: 'light.porch', state: 'off', name: 'Porch Light' }], [])

    db = openDb(':memory:')

    portals = new PortalStore(db)
    allowlist = new AllowlistStore(db)
    audit = new AuditLog(db)
    settings = new SettingsStore(db)
    interactions = new InteractionStore(db)
    sessions = new SessionStore()
    limiter = new LoginRateLimiter({ perIpMax: 10, windowMs: 60_000 })
    hub = new SseHub()

    cfg = {
      haBaseUrl: fake.baseUrl,
      haWsUrl: undefined,
      haToken: fake.token,
      adminPassword: 'admin-secret',
      port: 8080,
      ingressPort: undefined,
      dbPath: ':memory:',
      trustProxy: undefined,
    }

    haClient = HaClient.create({ haBaseUrl: fake.baseUrl, haToken: fake.token })
    haClient.start()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const deps: Deps = {
      cfg,
      ha: haClient,
      allowlist,
      audit,
      settings,
      interactions,
      portals,
      sessions,
      limiter,
      hub,
    }

    const app = buildApp(deps)
    server = createServer(getRequestListener(app.fetch))

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })
  })

  afterEach(async () => {
    await haClient.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fake.stop()
    db.close()
  })

  it('creates, lists, updates, and deletes a portal', async () => {
    const adminCookie = await loginAsAdmin()

    const created = await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Timothy', password: 'a-secret-1' }),
    }).then((r) => r.json())
    expect(created.title).toBe('Timothy')

    const list = await fetch(`${baseUrl}/api/admin/portals`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())
    expect(list.portals).toHaveLength(1)

    const updated = await fetch(`${baseUrl}/api/admin/portals/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Tim' }),
    }).then((r) => r.json())
    expect(updated.title).toBe('Tim')

    const del = await fetch(`${baseUrl}/api/admin/portals/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    })
    expect(del.status).toBe(200)

    const listAfter = await fetch(`${baseUrl}/api/admin/portals`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())
    expect(listAfter.portals).toHaveLength(0)
  })

  it('rejects creating a portal whose password matches an existing one', async () => {
    const adminCookie = await loginAsAdmin()

    await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Timothy', password: 'shared-pass' }),
    })

    const res = await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Mary', password: 'shared-pass' }),
    })

    expect(res.status).toBe(409)
  })

  it('rejects a portal password matching ADMIN_PASSWORD', async () => {
    const adminCookie = await loginAsAdmin()

    const res = await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Timothy', password: 'admin-secret' }),
    })

    expect(res.status).toBe(409)
  })

  it('returns deployment settings', async () => {
    const adminCookie = await loginAsAdmin()

    const res = await fetch(`${baseUrl}/api/admin/settings`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())

    expect(typeof res.integrationToken).toBe('string')
    expect(typeof res.deploymentId).toBe('string')
  })

  it('persists the last-selected portal', async () => {
    const adminCookie = await loginAsAdmin()
    const created = await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Timothy', password: 'a-secret-2' }),
    }).then((r) => r.json())

    const res = await fetch(`${baseUrl}/api/admin/last-selected-portal`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ portalId: created.id }),
    })
    expect(res.status).toBe(200)
    expect(settings.getLastSelectedPortalId()).toBe(created.id)
  })

  it('returns 401 for an unauthenticated request', async () => {
    const res = await fetch(`${baseUrl}/api/admin/portals`)
    expect(res.status).toBe(401)
  })

  it('returns 403 for a guest session', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'guest-pass-12345678' }),
    })
    const guestCookie = loginRes.headers.get('set-cookie') ?? ''
    expect(portal.enabled).toBe(true)

    const res = await fetch(`${baseUrl}/api/admin/portals`, {
      headers: { cookie: guestCookie },
    })
    expect(res.status).toBe(403)
  })
})
