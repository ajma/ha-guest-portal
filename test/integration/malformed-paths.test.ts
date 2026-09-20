import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import { type LoginRateLimiter, SessionStore } from '../../src/server/http/auth.ts'
import { SseHub } from '../../src/server/http/sse.ts'
import { AllowlistStore } from '../../src/server/store/allowlist.ts'
import { AuditLog } from '../../src/server/store/auditlog.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'
import { openDb } from '../../src/server/store/db.ts'
import type { Config } from '../../src/server/config.ts'
import { createRuntime, type Runtime } from '../../src/server/runtime.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

describe('Malformed path handling', () => {
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
    fake.seed([{ entityId: 'light.test', state: 'off', name: 'Test' }], [])

    // Open in-memory DB
    db = openDb(':memory:')

    allowlist = new AllowlistStore(db)
    allowlist.replace([
      {
        entityId: 'light.test',
        label: 'Test',
        allowedActions: ['turn_on'],
        sortOrder: 1,
      },
    ])

    audit = new AuditLog(db)
    settings = new SettingsStore(db)
    interactions = new InteractionStore(db)
    sessions = new SessionStore()

    const RateLimiterClass = (await import('../../src/server/http/auth.ts')).LoginRateLimiter
    limiter = new RateLimiterClass({ perIpMax: 10, windowMs: 60_000 })

    hub = new SseHub()

    cfg = {
      haBaseUrl: fake.baseUrl,
      haWsUrl: undefined,
      haToken: fake.token,
      guestPassword: 'guest-pass',
      adminPassword: 'admin-pass',
      port: 8080,
      ingressPort: undefined,
      dbPath: ':memory:',
      trustProxy: undefined,
    }

    haClient = HaClient.create({
      haBaseUrl: fake.baseUrl,
      haToken: fake.token,
    })
    haClient.start()

    await new Promise((resolve) => setTimeout(resolve, 100))
    await haClient.setWatchedEntities(allowlist.entityIds())

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
    await runtime.close()
    await fake.stop()
    db.close()
  })

  describe('Protocol-relative URLs do not crash the server', () => {
    it('GET // returns a response and server stays alive', async () => {
      const res = await fetch(`${baseUrl}//`)
      // Server should respond with SOME status, not crash
      expect(res.status).toBeGreaterThanOrEqual(200)

      // Verify server survived by making a normal request
      const healthRes = await fetch(`${baseUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })

    it('GET /// returns a response and server stays alive', async () => {
      const res = await fetch(`${baseUrl}///`)
      expect(res.status).toBeGreaterThanOrEqual(200)

      const healthRes = await fetch(`${baseUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })

    it('GET //api/stream returns a response and server stays alive', async () => {
      const res = await fetch(`${baseUrl}//api/stream`)
      expect(res.status).toBeGreaterThanOrEqual(200)

      const healthRes = await fetch(`${baseUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })
  })

  describe('Query strings and fragments are handled correctly', () => {
    it('GET /foo?a=1 returns a response', async () => {
      const res = await fetch(`${baseUrl}/foo?a=1`)
      expect(res.status).toBeGreaterThanOrEqual(200)

      const healthRes = await fetch(`${baseUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })

    it('GET /foo#frag returns a response', async () => {
      const res = await fetch(`${baseUrl}/foo#frag`)
      expect(res.status).toBeGreaterThanOrEqual(200)

      const healthRes = await fetch(`${baseUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })

    it('GET with percent-malformed path returns a response', async () => {
      const res = await fetch(`${baseUrl}/%`)
      expect(res.status).toBeGreaterThanOrEqual(200)

      const healthRes = await fetch(`${baseUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })
  })
})
