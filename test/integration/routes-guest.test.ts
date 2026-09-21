import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import { type LoginRateLimiter, SESSION_COOKIE, SessionStore } from '../../src/server/http/auth.ts'
import { SseHub } from '../../src/server/http/sse.ts'
import { AllowlistStore } from '../../src/server/store/allowlist.ts'
import { AuditLog } from '../../src/server/store/auditlog.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'
import { PortalStore } from '../../src/server/store/portals.ts'
import { openDb } from '../../src/server/store/db.ts'
import type { Config } from '../../src/server/config.ts'
import { createRuntime, type Runtime } from '../../src/server/runtime.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

// Several tests below need an isolated static root so cfg.webRoot never
// points at the real build output. Nothing in this file writes into it
// anymore (the app.ts-level HTML injection/SPA-fallback behavior is covered
// once app.ts itself is rewritten), but createApp still needs *some* root to
// hand to serveStatic, and pointing it at dist/web would risk clobbering the
// real build for other consumers.
const WEB_ROOT = mkdtempSync(join(tmpdir(), 'portal-web-'))

describe('Guest API routes', () => {
  afterAll(() => {
    rmSync(WEB_ROOT, { recursive: true, force: true })
  })

  let fake: FakeHomeAssistant
  let runtime: Runtime
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
  let defaultPortal: ReturnType<PortalStore['create']>

  // Logs a guest in against the default portal's password and returns the
  // Set-Cookie header value, matching this file's existing convention of
  // passing `cookie` straight into `fetch`'s headers.
  async function loginAs(password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const cookie = res.headers.get('set-cookie')
    if (!cookie) throw new Error(`login with password ${password} did not set a cookie`)
    return cookie
  }

  async function loginAsAdmin(): Promise<string> {
    return loginAs(cfg.adminPassword ?? '')
  }

  beforeEach(async () => {
    // Start fake HA
    fake = await FakeHomeAssistant.start({ token: 'test-ha-token' })
    fake.seed(
      [
        { entityId: 'light.porch', state: 'off', name: 'Porch Light' },
        { entityId: 'light.notexposed', state: 'on', name: 'Internal Light' },
        { entityId: 'lock.front', state: 'locked', name: 'Front Lock' },
        { entityId: 'switch.fan', state: 'off', name: 'Ceiling Fan' },
      ],
      [],
    )

    // Open in-memory DB
    db = openDb(':memory:')

    portals = new PortalStore(db)
    allowlist = new AllowlistStore(db)
    audit = new AuditLog(db)
    settings = new SettingsStore(db)
    interactions = new InteractionStore(db)
    sessions = new SessionStore()

    // Default portal used by tests that don't care about multi-portal
    // scoping specifically (Devices API, Action API, plain login/session).
    defaultPortal = portals.create({ title: 'Default Portal', password: 'guest-pass-12345678' })
    allowlist.replace(defaultPortal.id, [
      {
        entityId: 'light.porch',
        label: 'Porch',
        allowedActions: ['turn_on', 'turn_off', 'toggle'],
        sortOrder: 1,
      },
      {
        entityId: 'lock.front',
        label: 'Front Door',
        allowedActions: ['unlock'], // Only unlock, not lock
        sortOrder: 2,
      },
      {
        entityId: 'switch.fan',
        label: 'Fan',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 3,
      },
    ])

    // Create rate limiter with test-friendly params
    const RateLimiterClass = (await import('../../src/server/http/auth.ts')).LoginRateLimiter
    limiter = new RateLimiterClass({ perIpMax: 10, windowMs: 60_000 })

    hub = new SseHub()

    cfg = {
      haBaseUrl: fake.baseUrl,
      haWsUrl: undefined,
      haToken: fake.token,
      adminPassword: 'admin-pass-87654321',
      port: 8080,
      ingressPort: undefined,
      dbPath: ':memory:',
      trustProxy: undefined,
      webRoot: WEB_ROOT,
    }

    // Create HA client
    haClient = HaClient.create({
      haBaseUrl: fake.baseUrl,
      haToken: fake.token,
    })
    haClient.start()

    // Wait for HA client to connect
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Set watched entities
    await haClient.setWatchedEntities(allowlist.entityIds(defaultPortal.id))

    // Create runtime - this wires all the event handlers.
    // `portals` isn't yet part of runtime.ts's own (separately-declared) Deps
    // type - that lands with Task 14's rewrite - but it flows through to
    // createApp/createRoutes at runtime regardless, since JS object literals
    // don't drop extra fields the way a TS type declaration would imply.
    //
    // runtime.ts also still calls the now-removed
    // `settings.onPortalEnabledChange()` unconditionally at wire-up time -
    // its replacement, `portals.onEnabledChange()`, arrives with that same
    // later rewrite. This shim keeps that unconditional call from throwing
    // during setup without touching runtime.ts itself; no test here exercises
    // portal-enable broadcasting (that's this file's SSE describe block,
    // itself removed pending runtime.ts's own rewrite).
    const settingsForRuntime = Object.assign(Object.create(settings), {
      onPortalEnabledChange: () => () => {},
    }) as SettingsStore
    // Likewise, runtime.ts's allowlist.onChange handler still calls
    // allowlist.list() with no portalId (a pre-portal-scoping leftover, also
    // due for runtime.ts's rewrite) - harmless to the routes under test here,
    // but it fires on every allowlist.replace() a test makes and logs a
    // caught SQLite bind error each time. Registering that handler against a
    // stand-in instead of the real store keeps the tests' own output clean;
    // routes-guest.ts never calls allowlist.onChange itself, so this doesn't
    // affect anything actually under test.
    const allowlistForRuntime = Object.assign(Object.create(allowlist), {
      onChange: () => () => {},
    }) as AllowlistStore
    runtime = createRuntime({
      cfg,
      ha: haClient,
      allowlist: allowlistForRuntime,
      audit,
      settings: settingsForRuntime,
      interactions,
      portals,
      sessions,
      limiter,
      hub,
    } as Parameters<typeof createRuntime>[0])

    const directServer = runtime.servers[0]
    if (!directServer) throw new Error('No server created')
    server = directServer

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
  })

  afterEach(async () => {
    // Use runtime.close() which handles everything
    await runtime.close()

    // Stop fake
    await fake.stop()

    // Close DB
    db.close()
  })

  describe('Authentication', () => {
    it('unauthenticated /api/devices returns 401', async () => {
      const res = await fetch(`${baseUrl}/api/devices`)
      expect(res.status).toBe(401)
    })

    it('unauthenticated /api/stream returns 401', async () => {
      const res = await fetch(`${baseUrl}/api/stream`)
      expect(res.status).toBe(401)
    })

    it('unauthenticated action route returns 401', async () => {
      const res = await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
        method: 'POST',
      })
      expect(res.status).toBe(401)
    })

    it('logs a guest in and scopes their session to the matching portal', async () => {
      const portal = portals.create({ title: 'Timothy', password: 'timothy-pass' })

      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'timothy-pass' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        role: 'guest',
        portalId: portal.id,
        portalTitle: 'Timothy',
        portalTheme: 'classic',
        portalEnabled: true,
      })

      const setCookie = res.headers.get('set-cookie')
      expect(setCookie).toBeTruthy()
      expect(setCookie).toContain(SESSION_COOKIE)
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      expect(setCookie).toContain('Path=/')
      // MUST NOT contain Secure (plain HTTP on LAN)
      expect(setCookie).not.toContain('Secure')
    })

    it('login with admin password returns role=admin with no portal fields', async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'admin-pass-87654321' }),
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toEqual({ role: 'admin' })
    })

    it('login with wrong password returns 401 and records rate-limiter failure', async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      })

      expect(res.status).toBe(401)

      // Verify rate limiter recorded the failure
      expect(limiter.size).toBeGreaterThan(0)
    })

    it('login for a disabled portal returns 403 and does NOT count as a rate-limit failure', async () => {
      const disabled = portals.create({ title: 'Disabled', password: 'disabled-pass' })
      portals.update(disabled.id, { enabled: false })

      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'disabled-pass' }),
      })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body).toEqual({ error: 'portal_disabled' })

      // The password was correct, so this must not be counted as a failed
      // attempt - counting it would let a disabled portal lock a guest out
      // once it's re-enabled.
      expect(limiter.size).toBe(0)
    })

    it('11 failed logins from one IP return 429 with Retry-After', async () => {
      // Perform 11 failed login attempts
      for (let i = 0; i < 11; i++) {
        await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'wrong-password' }),
        })
      }

      // 12th attempt should be rate-limited
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      })

      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBeTruthy()
    })

    it('GET /api/session with valid cookie returns the portal-scoped session', async () => {
      const cookie = await loginAs(defaultPortal.password)

      const sessionRes = await fetch(`${baseUrl}/api/session`, {
        headers: { Cookie: cookie },
      })

      expect(sessionRes.status).toBe(200)
      const body = await sessionRes.json()
      expect(body).toEqual({
        role: 'guest',
        portalId: defaultPortal.id,
        portalTitle: defaultPortal.title,
        portalTheme: 'classic',
        portalEnabled: true,
      })
    })

    it('POST /api/logout destroys session', async () => {
      const cookie = await loginAs(defaultPortal.password)

      const logoutRes = await fetch(`${baseUrl}/api/logout`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })

      expect(logoutRes.status).toBe(200)

      // Verify session is destroyed
      const sessionRes = await fetch(`${baseUrl}/api/session`, {
        headers: { Cookie: cookie },
      })

      expect(sessionRes.status).toBe(401)
    })
  })

  describe('Devices API', () => {
    let cookie: string

    beforeEach(async () => {
      cookie = await loginAs(defaultPortal.password)
    })

    it('GET /api/devices returns only allowlisted entities with live state', async () => {
      const res = await fetch(`${baseUrl}/api/devices`, {
        headers: { Cookie: cookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveProperty('devices')
      expect(body).toHaveProperty('stale')
      expect(body.stale).toBe(false)

      expect(body.devices).toHaveLength(3)

      const porch = body.devices.find((d: { entityId: string }) => d.entityId === 'light.porch')
      expect(porch).toBeDefined()
      expect(porch.label).toBe('Porch')
      expect(porch.domain).toBe('light')
      expect(porch.allowedActions).toEqual(['turn_on', 'turn_off', 'toggle'])
      expect(porch.state.state).toBe('off')

      // light.notexposed should NOT be in the list
      const notExposed = body.devices.find(
        (d: { entityId: string }) => d.entityId === 'light.notexposed',
      )
      expect(notExposed).toBeUndefined()
    })

    it("only returns devices belonging to the guest's own portal", async () => {
      const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
      const mary = portals.create({ title: 'Mary', password: 'mary-pass' })
      allowlist.replace(timothy.id, [
        { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
      ])
      allowlist.replace(mary.id, [
        { entityId: 'light.mary_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
      ])

      const timothyCookie = await loginAs('timothy-pass')

      const res = await fetch(`${baseUrl}/api/devices`, { headers: { Cookie: timothyCookie } })
      const body = await res.json()
      expect(body.devices).toHaveLength(1)
      expect(body.devices[0].entityId).toBe('light.timothy_room')
    })

    it("ignores a guest-supplied ?portalId= — a guest's portal always comes from their session", async () => {
      const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
      const mary = portals.create({ title: 'Mary', password: 'mary-pass' })
      allowlist.replace(timothy.id, [
        { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
      ])
      allowlist.replace(mary.id, [
        { entityId: 'light.mary_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
      ])

      const timothyCookie = await loginAs('timothy-pass')

      // Timothy tries to read Mary's devices by tacking her portalId onto the
      // query string. A guest's session, not the query string, must decide
      // whose devices they see.
      const res = await fetch(`${baseUrl}/api/devices?portalId=${mary.id}`, {
        headers: { Cookie: timothyCookie },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.devices).toHaveLength(1)
      expect(body.devices[0].entityId).toBe('light.timothy_room')
    })

    it('lets an admin fetch devices for any portal via ?portalId=', async () => {
      const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
      allowlist.replace(timothy.id, [
        { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
      ])

      const adminCookie = await loginAsAdmin()

      const res = await fetch(`${baseUrl}/api/devices?portalId=${timothy.id}`, {
        headers: { Cookie: adminCookie },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.devices).toHaveLength(1)
      expect(body.devices[0].entityId).toBe('light.timothy_room')
    })

    it('an admin with no ?portalId= gets 400 Missing portalId', async () => {
      const adminCookie = await loginAsAdmin()

      const res = await fetch(`${baseUrl}/api/devices`, { headers: { Cookie: adminCookie } })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body).toEqual({ error: 'Missing portalId' })
    })

    it('blocks a guest of a disabled portal from viewing devices', async () => {
      const cookieForDisabled = await loginAs(defaultPortal.password)
      portals.update(defaultPortal.id, { enabled: false })

      const res = await fetch(`${baseUrl}/api/devices`, { headers: { Cookie: cookieForDisabled } })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body).toEqual({ error: 'portal_disabled' })
    })

    it('does not affect a guest of a different, still-enabled portal when one portal is disabled', async () => {
      const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
      allowlist.replace(timothy.id, [
        { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
      ])
      const timothyCookie = await loginAs('timothy-pass')

      // Disable the unrelated default portal
      portals.update(defaultPortal.id, { enabled: false })

      const res = await fetch(`${baseUrl}/api/devices`, { headers: { Cookie: timothyCookie } })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.devices).toHaveLength(1)
    })

    it('lets an admin view devices for a disabled portal (admin bypasses the enabled gate)', async () => {
      const adminCookie = await loginAsAdmin()
      portals.update(defaultPortal.id, { enabled: false })

      const res = await fetch(`${baseUrl}/api/devices?portalId=${defaultPortal.id}`, {
        headers: { Cookie: adminCookie },
      })
      expect(res.status).toBe(200)
    })
  })

  describe('Action API', () => {
    let cookie: string

    beforeEach(async () => {
      cookie = await loginAs(defaultPortal.password)
    })

    it('POST /api/devices/:entityId/:action reaches HA and logs success', async () => {
      const res = await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })

      expect(res.status).toBe(200)

      // Verify service call reached fake HA
      expect(fake.serviceCalls).toHaveLength(1)
      expect(fake.serviceCalls[0]?.domain).toBe('light')
      expect(fake.serviceCalls[0]?.service).toBe('turn_on')

      // Verify audit log
      const logs = audit.recent(defaultPortal.id, 10)
      expect(logs).toHaveLength(1)
      expect(logs[0]?.entityId).toBe('light.porch')
      expect(logs[0]?.action).toBe('turn_on')
      expect(logs[0]?.role).toBe('guest')
      expect(logs[0]?.ok).toBe(true)
    })

    it('POST /api/devices/:entityId/:action for non-allowlisted entity returns 404 and logs failure', async () => {
      const res = await fetch(`${baseUrl}/api/devices/light.notexposed/turn_on`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })

      // Must return 404 to avoid confirming entity existence
      expect(res.status).toBe(404)

      // Verify NO service call reached HA
      expect(fake.serviceCalls).toHaveLength(0)

      // Verify audit log still recorded the attempt
      const logs = audit.recent(defaultPortal.id, 10)
      expect(logs).toHaveLength(1)
      expect(logs[0]?.entityId).toBe('light.notexposed')
      expect(logs[0]?.action).toBe('turn_on')
      expect(logs[0]?.role).toBe('guest')
      expect(logs[0]?.ok).toBe(false)
    })

    it('POST /api/devices/:entityId/:action for invalid action returns 403 and makes no service call', async () => {
      const res = await fetch(`${baseUrl}/api/devices/light.porch/unlock`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })

      expect(res.status).toBe(403)

      // Verify NO service call
      expect(fake.serviceCalls).toHaveLength(0)

      // Verify audit log
      const logs = audit.recent(defaultPortal.id, 10)
      expect(logs).toHaveLength(1)
      expect(logs[0]?.entityId).toBe('light.porch')
      expect(logs[0]?.action).toBe('unlock')
      expect(logs[0]?.ok).toBe(false)
    })

    it('POST /api/devices/:entityId/:action for action not in allowedActions returns 403', async () => {
      // lock.front permits only 'unlock', not 'lock'
      const res = await fetch(`${baseUrl}/api/devices/lock.front/lock`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })

      expect(res.status).toBe(403)

      // Verify NO service call
      expect(fake.serviceCalls).toHaveLength(0)

      // Verify audit log
      const logs = audit.recent(defaultPortal.id, 10)
      expect(logs).toHaveLength(1)
      expect(logs[0]?.entityId).toBe('lock.front')
      expect(logs[0]?.action).toBe('lock')
      expect(logs[0]?.ok).toBe(false)
    })

    it("cannot act on a different portal's device even when allowlisted there", async () => {
      const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
      allowlist.replace(timothy.id, [
        { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
      ])

      // Logged in as the default portal's guest, but targeting Timothy's device
      const res = await fetch(`${baseUrl}/api/devices/light.timothy_room/turn_on`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })

      expect(res.status).toBe(404)
      expect(fake.serviceCalls).toHaveLength(0)
    })

    it("ignores a guest-supplied ?portalId= on callAction too — cannot act on another portal's allowlisted device by naming it in the query string", async () => {
      const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
      allowlist.replace(timothy.id, [
        { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
      ])

      const res = await fetch(
        `${baseUrl}/api/devices/light.timothy_room/turn_on?portalId=${timothy.id}`,
        { method: 'POST', headers: { Cookie: cookie } },
      )

      expect(res.status).toBe(404)
      expect(fake.serviceCalls).toHaveLength(0)
    })

    it('blocks a guest of a disabled portal from calling actions', async () => {
      portals.update(defaultPortal.id, { enabled: false })

      const res = await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body).toEqual({ error: 'portal_disabled' })
      expect(fake.serviceCalls).toHaveLength(0)
    })

    it('lets an admin call actions on any portal via ?portalId=', async () => {
      const adminCookie = await loginAsAdmin()

      const res = await fetch(
        `${baseUrl}/api/devices/light.porch/turn_on?portalId=${defaultPortal.id}`,
        { method: 'POST', headers: { Cookie: adminCookie } },
      )

      expect(res.status).toBe(200)
      expect(fake.serviceCalls).toHaveLength(1)

      const logs = audit.recent(defaultPortal.id, 10)
      expect(logs).toHaveLength(1)
      expect(logs[0]?.role).toBe('admin')
    })
  })

  describe('Health endpoint', () => {
    it('GET /api/health returns 200 without session and reports haStale', async () => {
      const res = await fetch(`${baseUrl}/api/health`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveProperty('ok', true)
      expect(body).toHaveProperty('haStale')
      expect(typeof body.haStale).toBe('boolean')
    })

    it('GET /api/health reports haStale=true when HA connection is dropped', async () => {
      // Drop the fake HA connection
      fake.drop()

      // Wait for staleness to propagate
      await new Promise((resolve) => setTimeout(resolve, 100))

      const res = await fetch(`${baseUrl}/api/health`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.haStale).toBe(true)
    })
  })

  describe('Static file serving', () => {
    // `/api` 404s must not fall through to the SPA fallback - this route
    // never touches app.ts's HTML-injection path, so it's unaffected by
    // that path currently being mid-migration (Task 15).
    it('does not serve index.html for /api paths that 404', async () => {
      const res = await fetch(`${baseUrl}/api/nonexistent`)
      expect(res.status).toBe(404)

      const text = await res.text()
      expect(text).not.toContain('SPA')
    })
  })
})
