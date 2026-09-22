// This file builds its own minimal harness — mounting mountPortalRoutes
// directly onto a bare Hono app with its own session/admin-role middleware —
// rather than going through createApp/createRuntime, since it only needs to
// exercise the portal management routes themselves.
import type { Server } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { createServer } from 'node:http'
import { Hono, type MiddlewareHandler } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import type { Env } from '../../src/server/app.ts'
import { createRoutes, type Deps } from '../../src/server/http/routes-guest.ts'
import { mountPortalRoutes } from '../../src/server/http/routes-portals.ts'
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
  const routes = createRoutes(deps)
  app.post('/api/login', routes.login)

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const cookie = c.req.header('cookie')
    const match = cookie ? new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie) : null
    const sessionId = match?.[1]
    const session = sessionId ? deps.sessions.get(sessionId) : undefined
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    c.set('session', session)
    await next()
  }

  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
    const session = c.var.session
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
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

  describe('request validation', () => {
    async function post(body: unknown, cookie: string) {
      const res = await fetch(`${baseUrl}/api/admin/portals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }

    async function put(portalId: string, body: unknown, cookie: string) {
      const res = await fetch(`${baseUrl}/api/admin/portals/${portalId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }

    it.each([
      ['a missing password', { title: 'Timothy' }, /Invalid input/],
      ['a short password', { title: 'Timothy', password: 'short12' }, /at least 8 characters/],
      [
        'a blank-space password',
        { title: 'Timothy', password: '        ' },
        /not counting leading or trailing spaces/,
      ],
      ['a missing title', { password: 'a-secret-1' }, /Invalid input/],
      [
        'an over-long title',
        { title: 'x'.repeat(61), password: 'a-secret-1' },
        /Title must be 60 characters or fewer/,
      ],
    ])('rejects a create with %s', async (_name, body, message) => {
      const adminCookie = await loginAsAdmin()

      const res = await post(body, adminCookie)

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(message)
      expect(portals.list()).toHaveLength(0)
    })

    it.each([
      ['a short password', { password: 'short12' }, /at least 8 characters/],
      [
        'a blank-space password',
        { password: '        ' },
        /not counting leading or trailing spaces/,
      ],
      ['an unknown theme', { theme: 'neon' }, /Invalid option/],
      ['a non-boolean enabled', { enabled: 'yes' }, /Invalid input/],
      [
        'an over-long title',
        { title: 'x'.repeat(61) },
        /Title must be 60 characters or fewer/,
      ],
    ])('rejects an update with %s', async (_name, body, message) => {
      const adminCookie = await loginAsAdmin()
      const portal = portals.create({ title: 'Timothy', password: 'original-pass' })

      const res = await put(portal.id, body, adminCookie)

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(message)
      expect(portals.get(portal.id)).toEqual(portal)
    })

    it('rejects a create with a non-JSON body', async () => {
      const adminCookie = await loginAsAdmin()

      const res = await fetch(`${baseUrl}/api/admin/portals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: 'not json',
      })

      expect(res.status).toBe(400)
      expect(portals.list()).toHaveLength(0)
    })

    it('keeps an accepted password exactly as sent, padding included', async () => {
      const adminCookie = await loginAsAdmin()

      const res = await post({ title: 'Timothy', password: '  a-secret-1  ' }, adminCookie)

      expect(res.status).toBe(200)
      expect(portals.get(res.body.id)?.password).toBe('  a-secret-1  ')
    })
  })

  describe('GET allowlist', () => {
    it("returns a portal's devices and flags the ones HA no longer knows", async () => {
      const adminCookie = await loginAsAdmin()
      const portal = portals.create({ title: 'Timothy', password: 'allowlist-get-pass' })
      allowlist.replace(portal.id, [
        { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
        { entityId: 'light.removed', label: 'Gone', allowedActions: ['turn_on'], sortOrder: 1 },
      ])

      const res = await fetch(`${baseUrl}/api/admin/portals/${portal.id}/allowlist`, {
        headers: { cookie: adminCookie },
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.devices.map((d: { entityId: string }) => d.entityId)).toEqual([
        'light.porch',
        'light.removed',
      ])
      expect(body.orphaned).toEqual(['light.removed'])
    })

    it("does not leak another portal's devices", async () => {
      const adminCookie = await loginAsAdmin()
      const timothy = portals.create({ title: 'Timothy', password: 'allowlist-get-tim' })
      const mary = portals.create({ title: 'Mary', password: 'allowlist-get-mary' })
      allowlist.replace(timothy.id, [
        { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
      ])
      allowlist.replace(mary.id, [])

      const body = await fetch(`${baseUrl}/api/admin/portals/${mary.id}/allowlist`, {
        headers: { cookie: adminCookie },
      }).then((r) => r.json())

      expect(body.devices).toEqual([])
      expect(body.orphaned).toEqual([])
    })
  })

  describe('PUT allowlist', () => {
    it("replaces only the named portal's devices, and leaves every other portal's alone", async () => {
      // Every save is a whole-list replace, so a write whose scope widens past
      // the path param does not merge — it overwrites. The owner saves
      // Timothy's two devices and Mary's three become those same two.
      const adminCookie = await loginAsAdmin()
      const timothy = portals.create({ title: 'Timothy', password: 'allowlist-put-tim' })
      const mary = portals.create({ title: 'Mary', password: 'allowlist-put-mary' })

      // Disjoint device sets, so adopting the other portal's list is visible in
      // the entity ids themselves rather than only in a label or an ordering.
      const maryDevices = [
        { entityId: 'lock.front', label: 'Front', allowedActions: ['unlock'], sortOrder: 0 },
        { entityId: 'switch.fan', label: 'Fan', allowedActions: ['toggle'], sortOrder: 1 },
        { entityId: 'light.hall', label: 'Hall', allowedActions: ['turn_on'], sortOrder: 2 },
      ]
      allowlist.replace(timothy.id, [
        { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
      ])
      allowlist.replace(mary.id, maryDevices)

      const res = await fetch(`${baseUrl}/api/admin/portals/${timothy.id}/allowlist`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          devices: [
            { entityId: 'light.porch', label: 'Porch Light', allowedActions: [], sortOrder: 0 },
          ],
        }),
      })
      expect(res.status).toBe(200)

      // Control: the named portal really was written, so the assertion below
      // pins the scope of the write rather than a route that writes nothing.
      expect(allowlist.list(timothy.id)).toEqual([
        { entityId: 'light.porch', label: 'Porch Light', allowedActions: [], sortOrder: 0 },
      ])
      // And Mary is untouched down to the labels, actions and ordering — not
      // merely non-empty, which a widened write that happened to append would
      // still satisfy.
      expect(allowlist.list(mary.id)).toEqual(maryDevices)
    })
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

  describe('password rotation', () => {
    async function loginAsGuest(password: string): Promise<{ cookie: string; sessionId: string }> {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const cookie = res.headers.get('set-cookie')
      if (!cookie) throw new Error('guest login did not set a cookie')
      const sessionId = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)?.[1]
      if (!sessionId) throw new Error('no session id in cookie')
      return { cookie, sessionId }
    }

    // The stream half of this invariant is proven over a real SSE round-trip
    // in test/integration/portal-toggle.test.ts, which runs the full runtime;
    // this harness mounts the routes without the /api/stream intercept.
    it("evicts that portal's guest sessions", async () => {
      const adminCookie = await loginAsAdmin()
      const portal = portals.create({ title: 'Timothy', password: 'rotate-me-pass' })
      const guest = await loginAsGuest('rotate-me-pass')
      expect(sessions.get(guest.sessionId)).toBeDefined()

      const res = await fetch(`${baseUrl}/api/admin/portals/${portal.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ password: 'rotated-new-pass' }),
      })

      expect(res.status).toBe(200)
      expect(sessions.get(guest.sessionId)).toBeUndefined()
    })

    it('leaves other portals’ guest sessions alone', async () => {
      const adminCookie = await loginAsAdmin()
      const timothy = portals.create({ title: 'Timothy', password: 'timothy-rotate-pass' })
      portals.create({ title: 'Mary', password: 'mary-keeps-pass' })
      const mary = await loginAsGuest('mary-keeps-pass')

      await fetch(`${baseUrl}/api/admin/portals/${timothy.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ password: 'timothy-rotated-pass' }),
      })

      expect(sessions.get(mary.sessionId)).toBeDefined()
    })

    it('leaves guest sessions alone for an update that does not touch the password', async () => {
      const adminCookie = await loginAsAdmin()
      const portal = portals.create({ title: 'Timothy', password: 'keep-this-pass' })
      const guest = await loginAsGuest('keep-this-pass')

      await fetch(`${baseUrl}/api/admin/portals/${portal.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ title: 'Tim' }),
      })

      expect(sessions.get(guest.sessionId)).toBeDefined()
    })
  })

  // Every admin route that names a portal in its path or body answers the same
  // way when that portal does not exist. Before this, one 500'd, one silently
  // succeeded, one returned an empty list as if the portal were real, and one
  // stored the bogus id — four different stories about the same mistake.
  describe('an admin naming a portal that does not exist', () => {
    const MISSING = 'no-such-portal-id'

    it('gets 404 from DELETE', async () => {
      const adminCookie = await loginAsAdmin()
      const res = await fetch(`${baseUrl}/api/admin/portals/${MISSING}`, {
        method: 'DELETE',
        headers: { cookie: adminCookie },
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found' })
    })

    it('gets 404 from the allowlist GET', async () => {
      const adminCookie = await loginAsAdmin()
      const res = await fetch(`${baseUrl}/api/admin/portals/${MISSING}/allowlist`, {
        headers: { cookie: adminCookie },
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found' })
    })

    it('gets 404 from the allowlist PUT, and writes nothing', async () => {
      const adminCookie = await loginAsAdmin()
      const res = await fetch(`${baseUrl}/api/admin/portals/${MISSING}/allowlist`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          devices: [
            { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
          ],
        }),
      })
      expect(res.status).toBe(404)
      expect(allowlist.list(MISSING)).toEqual([])
    })

    it('gets 404 from the last-selected PUT, leaving the pointer alone', async () => {
      const adminCookie = await loginAsAdmin()
      const portal = portals.create({ title: 'Real', password: 'real-pass-12345678' })
      settings.setLastSelectedPortalId(portal.id)

      const res = await fetch(`${baseUrl}/api/admin/last-selected-portal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ portalId: MISSING }),
      })
      expect(res.status).toBe(404)
      expect(settings.getLastSelectedPortalId()).toBe(portal.id)
    })
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
