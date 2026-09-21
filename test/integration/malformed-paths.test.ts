import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import { type LoginRateLimiter, SessionStore } from '../../src/server/http/auth.ts'
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

// The SPA-fallback tests below expect a real index.html to serve. Relying on
// dist/web/index.html from a prior `pnpm build` made this suite's outcome
// depend on execution order/history rather than its own setup — CI runs unit
// tests before build, so a truly fresh checkout has no dist/ yet. An isolated
// scratch root, written fresh in beforeEach, matches the convention already
// used by base-href.test.ts and routes-guest.test.ts.
const WEB_ROOT = mkdtempSync(join(tmpdir(), 'portal-malformed-paths-'))

describe('Malformed path handling', () => {
  afterAll(() => {
    rmSync(WEB_ROOT, { recursive: true, force: true })
  })

  let fake: FakeHomeAssistant
  let runtime: Runtime
  let directServer: Server
  let ingressServer: Server | undefined
  let directUrl: string
  let ingressUrl: string | undefined
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

  beforeEach(async () => {
    writeFileSync(
      join(WEB_ROOT, 'index.html'),
      '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <title>t</title>\n  </head>\n  <body></body>\n</html>',
    )

    // Start fake HA
    fake = await FakeHomeAssistant.start({ token: 'test-ha-token' })
    fake.seed([{ entityId: 'light.test', state: 'off', name: 'Test' }], [])

    // Open in-memory DB
    db = openDb(':memory:')

    allowlist = new AllowlistStore(db)
    portals = new PortalStore(db)
    const defaultPortal = portals.create({ title: 'Default Portal', password: 'guest-pass' })
    allowlist.replace(defaultPortal.id, [
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
      adminPassword: 'admin-pass',
      port: 8080,
      ingressPort: 8099, // Enable ingress to test both handlers
      dbPath: ':memory:',
      trustProxy: undefined,
      webRoot: WEB_ROOT,
    }

    haClient = HaClient.create({
      haBaseUrl: fake.baseUrl,
      haToken: fake.token,
    })
    haClient.start()

    await new Promise((resolve) => setTimeout(resolve, 100))
    await haClient.setWatchedEntities(allowlist.entityIds(defaultPortal.id))

    runtime = createRuntime({
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
    })

    const direct = runtime.servers[0]
    const ingress = runtime.servers[1]
    if (!direct) throw new Error('No direct server created')
    directServer = direct
    ingressServer = ingress

    // Start direct server
    await new Promise<void>((resolve) => {
      directServer.listen(0, '127.0.0.1', () => {
        const addr = directServer.address()
        if (addr && typeof addr === 'object') {
          directUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })

    // Start ingress server
    if (ingressServer) {
      const server = ingressServer
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            ingressUrl = `http://127.0.0.1:${addr.port}`
          }
          resolve()
        })
      })
    }
  })

  afterEach(async () => {
    await runtime.close()
    await fake.stop()
    db.close()
  })

  describe('Direct port: Protocol-relative URLs do not crash the server', () => {
    it('GET // returns 200 (SPA fallback) and server stays alive', async () => {
      const res = await fetch(`${directUrl}//`)
      // Pre-fix: ERR_INVALID_URL, process crash
      // Post-fix: Falls through to SPA fallback, serves index.html
      expect(res.status).toBe(200)

      // Verify server survived by making a normal request
      const healthRes = await fetch(`${directUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })

    it('GET /// returns 200 (SPA fallback) and server stays alive', async () => {
      const res = await fetch(`${directUrl}///`)
      // Pre-fix: ERR_INVALID_URL, process crash
      // Post-fix: SPA fallback serves index.html
      expect(res.status).toBe(200)

      const healthRes = await fetch(`${directUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })

    it('GET //api/stream does not reach SSE handler, server stays alive', async () => {
      const res = await fetch(`${directUrl}//api/stream`)
      // Pre-fix: ERR_INVALID_URL, process crash
      // Post-fix: pathname is "//api/stream", does not match "/api/stream"
      // So it goes to Hono, falls to SPA fallback, serves index.html
      // The critical check: NOT a streaming response
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).not.toBe('text/event-stream')

      const healthRes = await fetch(`${directUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })
  })

  describe('Direct port: Query strings and other edge cases', () => {
    it('GET /foo?a=1 returns 200 (SPA fallback)', async () => {
      const res = await fetch(`${directUrl}/foo?a=1`)
      // Never crashed, regression guard for query parsing
      expect(res.status).toBe(200)

      const healthRes = await fetch(`${directUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })

    it('GET with percent-malformed path returns 200 (SPA fallback)', async () => {
      const res = await fetch(`${directUrl}/%`)
      // Never crashed (URL constructor tolerates bare %), regression guard
      expect(res.status).toBe(200)

      const healthRes = await fetch(`${directUrl}/api/health`)
      expect(healthRes.status).toBe(200)
    })
  })

  describe('Ingress port: Protocol-relative URLs do not crash the server', () => {
    it('GET // returns 403 and server stays alive', async () => {
      if (!ingressUrl) throw new Error('No ingress server')
      const res = await fetch(`${ingressUrl}//`)
      // Pre-fix: ERR_INVALID_URL, process crash (before Supervisor check!)
      // Post-fix: 403 (Supervisor check rejects)
      expect(res.status).toBe(403)

      const healthRes = await fetch(`${ingressUrl}/api/health`)
      expect(healthRes.status).toBe(403)
    })

    it('GET /// returns 403 and server stays alive', async () => {
      if (!ingressUrl) throw new Error('No ingress server')
      const res = await fetch(`${ingressUrl}///`)
      // Pre-fix: ERR_INVALID_URL, process crash
      // Post-fix: 403
      expect(res.status).toBe(403)

      const healthRes = await fetch(`${ingressUrl}/api/health`)
      expect(healthRes.status).toBe(403)
    })

    it('GET //api/stream returns 403 (not SSE), server stays alive', async () => {
      if (!ingressUrl) throw new Error('No ingress server')
      const res = await fetch(`${ingressUrl}//api/stream`)
      // Pre-fix: ERR_INVALID_URL, process crash (bypassed Supervisor check!)
      // Post-fix: 403 from Supervisor check
      expect(res.status).toBe(403)
      expect(res.headers.get('content-type')).not.toBe('text/event-stream')

      const healthRes = await fetch(`${ingressUrl}/api/health`)
      expect(healthRes.status).toBe(403)
    })
  })
})
