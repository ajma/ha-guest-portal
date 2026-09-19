import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import { type LoginRateLimiter, SESSION_COOKIE, SessionStore } from '../../src/server/http/auth.ts'
import { SseHub } from '../../src/server/http/sse.ts'
import { AllowlistStore } from '../../src/server/store/allowlist.ts'
import { AuditLog } from '../../src/server/store/auditlog.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'
import { openDb } from '../../src/server/store/db.ts'
import type { Config } from '../../src/server/config.ts'
import type { SseFrame } from '../../src/shared/api.ts'
import { createRuntime, type Runtime } from '../../src/server/runtime.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

// SSE stream helper
async function openStream(baseUrl: string, cookie: string) {
  const ctrl = new AbortController()
  const res = await fetch(`${baseUrl}/api/stream`, {
    headers: { Cookie: cookie },
    signal: ctrl.signal,
  })
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no body')
  const dec = new TextDecoder()
  const frames: SseFrame[] = []
  const pump = (async () => {
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        for (;;) {
          const i = buf.indexOf('\n\n')
          if (i === -1) break
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = chunk.split('\n').find((l) => l.startsWith('data: '))
          if (line) frames.push(JSON.parse(line.slice(6)))
        }
      }
    } catch {
      // aborted
    }
  })()
  return { res, frames, abort: () => ctrl.abort(), pump }
}

async function waitForFrame(frames: SseFrame[], type: string, ms = 5000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (frames.some((f) => f.type === type)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

describe('Guest API routes', () => {
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
  let sessions: SessionStore
  let limiter: LoginRateLimiter
  let hub: SseHub
  let cfg: Config

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

    // Seed allowlist
    allowlist = new AllowlistStore(db)
    allowlist.replace([
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

    audit = new AuditLog(db)
    settings = new SettingsStore(db)
    interactions = new InteractionStore(db)
    sessions = new SessionStore()

    // Create rate limiter with test-friendly params
    const RateLimiterClass = (await import('../../src/server/http/auth.ts')).LoginRateLimiter
    limiter = new RateLimiterClass({ perIpMax: 10, windowMs: 60_000 })

    hub = new SseHub()

    cfg = {
      haBaseUrl: fake.baseUrl,
      haWsUrl: undefined,
      haToken: fake.token,
      guestPassword: 'guest-pass-12345678',
      adminPassword: 'admin-pass-87654321',
      port: 8080,
      ingressPort: undefined,
      dbPath: ':memory:',
      trustProxy: undefined,
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
    await haClient.setWatchedEntities(allowlist.entityIds())

    // Create runtime - this wires all the event handlers
    runtime = createRuntime({
      cfg,
      ha: haClient,
      allowlist,
      audit,
      settings,
      interactions,
      sessions,
      limiter,
      hub,
    })

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

    it('login with guest password sets httpOnly SameSite=Lax cookie and returns role', async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'guest-pass-12345678' }),
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toEqual({ role: 'guest' })

      const setCookie = res.headers.get('set-cookie')
      expect(setCookie).toBeTruthy()
      expect(setCookie).toContain(SESSION_COOKIE)
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      expect(setCookie).toContain('Path=/')
      // MUST NOT contain Secure (plain HTTP on LAN)
      expect(setCookie).not.toContain('Secure')
    })

    it('login with admin password returns role=admin', async () => {
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

    it('GET /api/session with valid cookie returns role', async () => {
      // Login first
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'guest-pass-12345678' }),
      })

      const cookie = loginRes.headers.get('set-cookie')
      expect(cookie).toBeTruthy()

      // Now check session
      const sessionRes = await fetch(`${baseUrl}/api/session`, {
        headers: { Cookie: cookie ?? '' },
      })

      expect(sessionRes.status).toBe(200)
      const body = await sessionRes.json()
      expect(body).toEqual({ role: 'guest' })
    })

    it('POST /api/logout destroys session', async () => {
      // Login first
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'guest-pass-12345678' }),
      })

      const cookie = loginRes.headers.get('set-cookie')
      expect(cookie).toBeTruthy()

      // Logout
      const logoutRes = await fetch(`${baseUrl}/api/logout`, {
        method: 'POST',
        headers: { Cookie: cookie ?? '' },
      })

      expect(logoutRes.status).toBe(200)

      // Verify session is destroyed
      const sessionRes = await fetch(`${baseUrl}/api/session`, {
        headers: { Cookie: cookie ?? '' },
      })

      expect(sessionRes.status).toBe(401)
    })
  })

  describe('Devices API', () => {
    let cookie: string

    beforeEach(async () => {
      // Login as guest
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'guest-pass-12345678' }),
      })
      cookie = res.headers.get('set-cookie') ?? ''
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
  })

  describe('Action API', () => {
    let cookie: string

    beforeEach(async () => {
      // Login as guest
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'guest-pass-12345678' }),
      })
      cookie = res.headers.get('set-cookie') ?? ''
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
      const logs = audit.recent(10)
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
      const logs = audit.recent(10)
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
      const logs = audit.recent(10)
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
      const logs = audit.recent(10)
      expect(logs).toHaveLength(1)
      expect(logs[0]?.entityId).toBe('lock.front')
      expect(logs[0]?.action).toBe('lock')
      expect(logs[0]?.ok).toBe(false)
    })
  })

  describe('SSE streaming', () => {
    let cookie: string

    beforeEach(async () => {
      // Login as guest
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'guest-pass-12345678' }),
      })
      cookie = res.headers.get('set-cookie') ?? ''
    })

    it('GET /api/stream emits snapshot immediately on connect', async () => {
      const stream = await openStream(baseUrl, cookie)

      expect(stream.res.status).toBe(200)
      expect(stream.res.headers.get('content-type')).toBe('text/event-stream')

      // Wait for snapshot
      const found = await waitForFrame(stream.frames, 'snapshot', 2000)
      expect(found).toBe(true)

      const snapshot = stream.frames.find((f) => f.type === 'snapshot')
      expect(snapshot).toBeDefined()

      // Type guard narrows to snapshot frame
      if (snapshot?.type !== 'snapshot') {
        throw new Error('Expected snapshot frame')
      }

      expect(snapshot).toHaveProperty('devices')
      expect(snapshot).toHaveProperty('stale', false)

      // Verify it contains the allowlisted entities
      expect(snapshot.devices).toHaveLength(3)
      expect(snapshot.devices.map((d) => d.entityId)).toContain('light.porch')
      expect(snapshot.devices.map((d) => d.entityId)).toContain('lock.front')
      expect(snapshot.devices.map((d) => d.entityId)).toContain('switch.fan')

      stream.abort()
      await stream.pump
    })

    it('GET /api/stream emits snapshot, then patch after state change, then degraded', async () => {
      const stream = await openStream(baseUrl, cookie)

      expect(stream.res.status).toBe(200)

      // Wait for snapshot
      await waitForFrame(stream.frames, 'snapshot', 2000)
      expect(stream.frames.some((f) => f.type === 'snapshot')).toBe(true)

      // Trigger state change
      fake.setState('light.porch', 'on')

      // Wait for patch
      const foundPatch = await waitForFrame(stream.frames, 'patch', 2000)
      expect(foundPatch).toBe(true)

      // Trigger degraded by dropping connection
      fake.drop()

      // Wait for degraded
      const foundDegraded = await waitForFrame(stream.frames, 'degraded', 2000)
      expect(foundDegraded).toBe(true)

      const degraded = stream.frames.find((f) => f.type === 'degraded')
      expect(degraded).toHaveProperty('stale', true)

      stream.abort()
      await stream.pump
    })

    it('changing allowlist causes stream to emit fresh snapshot', async () => {
      const stream = await openStream(baseUrl, cookie)

      expect(stream.res.status).toBe(200)

      // Wait for initial snapshot
      await waitForFrame(stream.frames, 'snapshot', 2000)
      const snapshotCountBefore = stream.frames.filter((f) => f.type === 'snapshot').length

      // Change allowlist (reduce to just one device)
      allowlist.replace([
        {
          entityId: 'light.porch',
          label: 'Porch Updated',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 1,
        },
      ])

      // Poll until snapshot count increases
      const t0 = Date.now()
      let newSnapshot = false
      while (Date.now() - t0 < 5000) {
        const snapshotCount = stream.frames.filter((f) => f.type === 'snapshot').length
        if (snapshotCount > snapshotCountBefore) {
          newSnapshot = true
          break
        }
        await new Promise((r) => setTimeout(r, 50))
      }

      expect(newSnapshot).toBe(true)

      // Verify the newest snapshot has 1 device (the updated allowlist)
      const snapshots = stream.frames.filter((f) => f.type === 'snapshot')
      const latest = snapshots[snapshots.length - 1]
      expect(latest).toBeDefined()

      // Type guard narrows to snapshot frame
      if (latest?.type !== 'snapshot') {
        throw new Error('Expected snapshot frame')
      }

      expect(latest.devices).toHaveLength(1)
      expect(latest.devices[0]?.entityId).toBe('light.porch')

      stream.abort()
      await stream.pump
    })
  })

  describe('Static file serving', () => {
    it('serves SPA index.html for non-API paths', async () => {
      // Write a test index.html to dist/web
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync('/home/andm/workspace/ha-guest-portal/dist/web', { recursive: true })
      writeFileSync(
        '/home/andm/workspace/ha-guest-portal/dist/web/index.html',
        '<html><body>SPA</body></html>',
      )

      const res = await fetch(`${baseUrl}/admin`)
      expect(res.status).toBe(200)

      const text = await res.text()
      expect(text).toContain('SPA')
    })

    it('does not serve index.html for /api paths that 404', async () => {
      const res = await fetch(`${baseUrl}/api/nonexistent`)
      expect(res.status).toBe(404)

      const text = await res.text()
      expect(text).not.toContain('SPA')
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
})
