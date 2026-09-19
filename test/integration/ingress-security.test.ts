import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import { LoginRateLimiter, SessionStore } from '../../src/server/http/auth.ts'
import { SseHub } from '../../src/server/http/sse.ts'
import { AllowlistStore } from '../../src/server/store/allowlist.ts'
import { AuditLog } from '../../src/server/store/auditlog.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'
import { openDb } from '../../src/server/store/db.ts'
import type { Config } from '../../src/server/config.ts'
import { createRuntime, type Runtime } from '../../src/server/runtime.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

describe('Ingress security - source address enforcement', () => {
  let fake: FakeHomeAssistant
  let runtime: Runtime
  let directServer: Server
  let ingressServer: Server
  let directUrl: string
  let ingressUrl: string
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
        { entityId: 'lock.front', state: 'locked', name: 'Front Lock' },
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
    ])

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
      guestPassword: 'guest-pass-12345678',
      adminPassword: 'admin-pass-87654321',
      port: 8080,
      ingressPort: 8099, // Enable ingress
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

    // Create runtime - this wires all the event handlers and creates TWO servers
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

    const direct = runtime.servers[0]
    const ingress = runtime.servers[1]
    if (!direct || !ingress) throw new Error('Expected two servers')
    directServer = direct
    ingressServer = ingress

    // Start listening on direct port
    await new Promise<void>((resolve) => {
      directServer.listen(0, '127.0.0.1', () => {
        const addr = directServer.address()
        if (addr && typeof addr === 'object') {
          directUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })

    // Start listening on ingress port (bind to localhost for testing)
    // In production, this would bind to all interfaces and filter by source IP
    await new Promise<void>((resolve) => {
      ingressServer.listen(0, '127.0.0.1', () => {
        const addr = ingressServer.address()
        if (addr && typeof addr === 'object') {
          ingressUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })
  })

  afterEach(async () => {
    await runtime.close()
    await fake.stop()
    db.close()
  })

  describe('Ingress port rejects non-Supervisor sources', () => {
    it('rejects GET / with 403', async () => {
      const res = await fetch(ingressUrl)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data).toEqual({ error: 'Forbidden' })
    })

    it('rejects GET /admin with 403', async () => {
      const res = await fetch(`${ingressUrl}/admin`)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data).toEqual({ error: 'Forbidden' })
    })

    it('rejects GET /assets/nonexistent.js with 403', async () => {
      const res = await fetch(`${ingressUrl}/assets/nonexistent.js`)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data).toEqual({ error: 'Forbidden' })
    })

    it('rejects GET /api/admin/allowlist with 403', async () => {
      const res = await fetch(`${ingressUrl}/api/admin/allowlist`)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data).toEqual({ error: 'Forbidden' })
    })

    it('rejects GET /api/devices with 403', async () => {
      const res = await fetch(`${ingressUrl}/api/devices`)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data).toEqual({ error: 'Forbidden' })
    })

    it('rejects GET /api/stream with 403', async () => {
      const res = await fetch(`${ingressUrl}/api/stream`)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data).toEqual({ error: 'Forbidden' })
    })

    it('rejects POST /api/login with 403', async () => {
      const res = await fetch(`${ingressUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'admin-pass-87654321' }),
      })
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data).toEqual({ error: 'Forbidden' })
    })
  })

  describe('Direct port unchanged - requires password', () => {
    it('requires session for /api/devices', async () => {
      const res = await fetch(`${directUrl}/api/devices`)
      expect(res.status).toBe(401)
    })

    it('requires session for /api/admin/allowlist', async () => {
      const res = await fetch(`${directUrl}/api/admin/allowlist`)
      expect(res.status).toBe(401)
    })

    it('requires session for /api/stream', async () => {
      const res = await fetch(`${directUrl}/api/stream`)
      expect(res.status).toBe(401)
    })

    it('allows guest login', async () => {
      const res = await fetch(`${directUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'guest-pass-12345678' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.role).toBe('guest')
    })

    it('allows admin login', async () => {
      const res = await fetch(`${directUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'admin-pass-87654321' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.role).toBe('admin')
    })

    it('does not grant admin from spoofed X-Forwarded-For header', async () => {
      const res = await fetch(`${directUrl}/api/admin/allowlist`, {
        headers: {
          'X-Forwarded-For': '172.30.32.2',
        },
      })
      expect(res.status).toBe(401) // Still requires session
    })

    it('does not grant admin from spoofed X-Real-IP header', async () => {
      const res = await fetch(`${directUrl}/api/admin/allowlist`, {
        headers: {
          'X-Real-IP': '172.30.32.2',
        },
      })
      expect(res.status).toBe(401) // Still requires session
    })
  })

  describe('Runtime with ingress disabled', () => {
    it('creates only one server when ingressPort is undefined', async () => {
      const cfgNoIngress: Config = {
        ...cfg,
        ingressPort: undefined,
      }

      const runtimeNoIngress = createRuntime({
        cfg: cfgNoIngress,
        ha: haClient,
        allowlist,
        audit,
        settings,
        interactions,
        sessions,
        limiter,
        hub,
      })

      expect(runtimeNoIngress.servers).toHaveLength(1)

      await runtimeNoIngress.close()
    })
  })
})
