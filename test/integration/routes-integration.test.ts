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

describe('Integration routes', () => {
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
      {
        entityId: 'lock.front',
        label: 'Front Door',
        allowedActions: ['unlock'],
        sortOrder: 2,
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
      guestPassword: 'guest-password',
      adminPassword: 'admin-password',
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

  function auth(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` }
  }

  it('returns state to a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth(settings.getIntegrationToken()),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.enabled).toBe(true)
    expect(body.portalId).toBe(settings.getPortalId())
    expect(body.lastInteraction).toBeNull()
    expect(body.version).toBe('1.0.0')
    expect(typeof body.deviceCount).toBe('number')
  })

  it('rejects a missing Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`)
    expect(res.status).toBe(401)
  })

  it('rejects a malformed Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: { Authorization: settings.getIntegrationToken() },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth('b'.repeat(64)),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a session cookie in place of a token', async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie') ?? ''
    expect(cookie).toBeTruthy()
    expect(cookie).toContain('hagp_session=')

    const res = await fetch(`${baseUrl}/api/integration/state`, { headers: { cookie } })

    expect(res.status).toBe(401)
  })

  it('disables the portal', async () => {
    const res = await fetch(`${baseUrl}/api/integration/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(settings.getIntegrationToken()) },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
    expect(settings.getPortalEnabled()).toBe(false)
  })

  it('rejects POST /enabled with no Authorization header', async () => {
    const initialState = settings.getPortalEnabled()

    const res = await fetch(`${baseUrl}/api/integration/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(401)
    expect(settings.getPortalEnabled()).toBe(initialState)
  })

  it('rejects POST /enabled with a wrong token', async () => {
    const initialState = settings.getPortalEnabled()

    const res = await fetch(`${baseUrl}/api/integration/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('c'.repeat(64)) },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(401)
    expect(settings.getPortalEnabled()).toBe(initialState)
  })

  it('remains reachable while the portal is disabled', async () => {
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth(settings.getIntegrationToken()),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(false)
  })

  it('rejects a non-boolean enabled', async () => {
    const res = await fetch(`${baseUrl}/api/integration/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(settings.getIntegrationToken()) },
      body: JSON.stringify({ enabled: 1 }),
    })

    expect(res.status).toBe(400)
  })

  it('reports the latest interaction', async () => {
    interactions.record({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })

    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth(settings.getIntegrationToken()),
    })

    expect((await res.json()).lastInteraction).toEqual({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })
  })

  it('cannot reach the allowlist with an integration token', async () => {
    const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
      headers: auth(settings.getIntegrationToken()),
    })

    expect(res.status).toBe(401)
  })

  it('allows admin session to reach allowlist (positive control)', async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password' }),
    })
    const cookie = login.headers.get('set-cookie') ?? ''

    const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
      headers: { cookie },
    })

    expect(res.status).toBe(200)
  })

  it('rejects guest session + integration token for allowlist', async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'guest-password' }),
    })
    const cookie = login.headers.get('set-cookie') ?? ''

    const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
      headers: { cookie, ...auth(settings.getIntegrationToken()) },
    })

    expect(res.status).toBe(403)
  })
})
