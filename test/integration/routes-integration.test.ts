import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import { LoginRateLimiter, SessionStore } from '../../src/server/http/auth.ts'
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
  let portals: PortalStore
  let sessions: SessionStore
  let limiter: LoginRateLimiter
  let hub: SseHub
  let cfg: Config
  let token: string

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

    token = settings.getIntegrationToken()

    // Create runtime - this wires all the event handlers
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

  function auth(t: string): Record<string, string> {
    return { Authorization: `Bearer ${t}` }
  }

  it('reports every portal in the deployment', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
    allowlist.replace(timothy.id, [
      { entityId: 'light.a', label: 'A', allowedActions: ['turn_on'], sortOrder: 0 },
    ])

    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = await res.json()

    expect(body.portals).toHaveLength(1)
    expect(body.portals[0]).toMatchObject({
      portalId: timothy.id,
      title: 'Timothy',
      enabled: true,
      deviceCount: 1,
    })
    expect(typeof body.deploymentId).toBe('string')
    expect(body.version).toBe('2.0.0')
  })

  it('enables and disables a specific portal by id', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-2' })

    const res = await fetch(`${baseUrl}/api/integration/portals/${timothy.id}/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(200)
    expect(portals.get(timothy.id)?.enabled).toBe(false)
  })

  it('rejects a missing Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`)
    expect(res.status).toBe(401)
  })

  it('rejects a malformed Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: { Authorization: token },
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

  it('rejects POST .../enabled with no Authorization header', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-3' })

    const res = await fetch(`${baseUrl}/api/integration/portals/${timothy.id}/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(401)
    expect(portals.get(timothy.id)?.enabled).toBe(true)
  })

  it('rejects POST .../enabled with a wrong token', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-4' })

    const res = await fetch(`${baseUrl}/api/integration/portals/${timothy.id}/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('c'.repeat(64)) },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(401)
    expect(portals.get(timothy.id)?.enabled).toBe(true)
  })

  it('404s enabling a portal that does not exist', async () => {
    const res = await fetch(`${baseUrl}/api/integration/portals/does-not-exist/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(token) },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(404)
  })

  it('rejects a non-boolean enabled', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-5' })

    const res = await fetch(`${baseUrl}/api/integration/portals/${timothy.id}/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(token) },
      body: JSON.stringify({ enabled: 1 }),
    })

    expect(res.status).toBe(400)
  })

  it('reports the latest interaction for the right portal', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-6' })
    interactions.record({
      portalId: timothy.id,
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })

    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth(token),
    })
    const body = await res.json()
    const reported = body.portals.find((p: { portalId: string }) => p.portalId === timothy.id)

    expect(reported.lastInteraction).toEqual({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })
  })

  it('reports a disabled portal as disabled rather than omitting it', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-7' })
    portals.update(timothy.id, { enabled: false })

    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth(token),
    })
    const body = await res.json()
    const reported = body.portals.find((p: { portalId: string }) => p.portalId === timothy.id)

    expect(reported.enabled).toBe(false)
  })

  it('cannot reach the allowlist with an integration token', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-8' })

    const res = await fetch(`${baseUrl}/api/admin/portals/${timothy.id}/allowlist`, {
      headers: auth(token),
    })

    expect(res.status).toBe(401)
  })

  it('allows admin session to reach allowlist (positive control)', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-9' })

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password' }),
    })
    const cookie = login.headers.get('set-cookie') ?? ''

    const res = await fetch(`${baseUrl}/api/admin/portals/${timothy.id}/allowlist`, {
      headers: { cookie },
    })

    expect(res.status).toBe(200)
  })

  it('rejects guest session + integration token for allowlist', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-10' })

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'timothy-pass-10' }),
    })
    const cookie = login.headers.get('set-cookie') ?? ''

    const res = await fetch(`${baseUrl}/api/admin/portals/${timothy.id}/allowlist`, {
      headers: { cookie, ...auth(token) },
    })

    expect(res.status).toBe(403)
  })
})
