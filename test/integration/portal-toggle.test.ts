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

describe('Portal toggle', () => {
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

  async function loginAs(password: string): Promise<{ status: number; cookie: string }> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    return { status: res.status, cookie: res.headers.get('set-cookie') ?? '' }
  }

  it('refuses guest login while disabled', async () => {
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'guest-pass-12345678' }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'portal_disabled' })
  })

  it('does not count a blocked guest login against the rate limiter', async () => {
    settings.setPortalEnabled(false)

    // Attempt 15 logins - exceeds perIpMax: 10, would trigger rate limiting
    // if these were counted as failures
    for (let i = 0; i < 15; i++) {
      await loginAs('guest-pass-12345678')
    }

    settings.setPortalEnabled(true)
    const { status } = await loginAs('guest-pass-12345678')

    expect(status).toBe(200)
  })

  it('still allows admin login while disabled', async () => {
    settings.setPortalEnabled(false)
    const { status } = await loginAs('admin-pass-87654321')
    expect(status).toBe(200)
  })

  it('reports portalEnabled on the session route', async () => {
    const { cookie } = await loginAs('guest-pass-12345678')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/session`, { headers: { cookie } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: 'guest', portalEnabled: false })
  })

  it('refuses an existing guest session on /api/devices while disabled', async () => {
    const { cookie } = await loginAs('guest-pass-12345678')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'portal_disabled' })
  })

  it('refuses a guest action while disabled', async () => {
    const { cookie } = await loginAs('guest-pass-12345678')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
      method: 'POST',
      headers: { cookie },
    })

    expect(res.status).toBe(403)
  })

  it('refuses a guest stream while disabled', async () => {
    const { cookie } = await loginAs('guest-pass-12345678')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/stream`, { headers: { cookie } })

    expect(res.status).toBe(403)
    await res.body?.cancel()
  })

  it('leaves admin device access working while disabled', async () => {
    const { cookie } = await loginAs('admin-pass-87654321')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })

    expect(res.status).toBe(200)
  })

  it('restores guest access when re-enabled, without a new login', async () => {
    const { cookie } = await loginAs('guest-pass-12345678')
    settings.setPortalEnabled(false)
    settings.setPortalEnabled(true)

    const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })

    expect(res.status).toBe(200)
  })

  it('closes guest streams but not admin streams when disabled', async () => {
    const guest = await loginAs('guest-pass-12345678')
    const admin = await loginAs('admin-pass-87654321')

    const guestStream = await fetch(`${baseUrl}/api/stream`, { headers: { cookie: guest.cookie } })
    const adminStream = await fetch(`${baseUrl}/api/stream`, { headers: { cookie: admin.cookie } })
    expect(guestStream.status).toBe(200)
    expect(adminStream.status).toBe(200)

    settings.setPortalEnabled(false)

    // The guest stream must receive the portal frame, then close.
    const guestReader = guestStream.body?.getReader()
    if (!guestReader) throw new Error('no guest body')
    const dec = new TextDecoder()
    let guestBuf = ''
    let guestClosed = false
    let sawPortalFrame = false
    for (let i = 0; i < 20; i++) {
      const { done, value } = await guestReader.read()
      if (done) {
        guestClosed = true
        break
      }
      if (value) {
        guestBuf += dec.decode(value, { stream: true })
        if (guestBuf.includes('"type":"portal"')) {
          sawPortalFrame = true
        }
      }
    }
    expect(sawPortalFrame).toBe(true)
    expect(guestClosed).toBe(true)

    // The admin stream must remain open: reading one chunk must NOT return done.
    const adminReader = adminStream.body?.getReader()
    if (!adminReader) throw new Error('no admin body')
    const { done: adminDone } = await adminReader.read()
    expect(adminDone).toBe(false)

    await adminReader.cancel()
  })

  describe('interaction recording', () => {
    it('records a guest login', async () => {
      await loginAs('guest-pass-12345678')

      const latest = interactions.latest()
      expect(latest?.kind).toBe('login')
      expect(latest?.ok).toBe(true)
      expect(latest?.entityId).toBeNull()
    })

    it('does not record an admin login', async () => {
      await loginAs('admin-pass-87654321')
      expect(interactions.latest()).toBeNull()
    })

    it('records a successful guest action with its label', async () => {
      const { cookie } = await loginAs('guest-pass-12345678')

      await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest()).toMatchObject({
        kind: 'action',
        entityId: 'light.porch',
        label: 'Porch',
        action: 'turn_on',
        ok: true,
      })
    })

    it('records a rejected guest action', async () => {
      const { cookie } = await loginAs('guest-pass-12345678')

      await fetch(`${baseUrl}/api/devices/light.not_allowlisted/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest()).toMatchObject({
        kind: 'action',
        entityId: 'light.not_allowlisted',
        action: 'turn_on',
        ok: false,
      })
    })

    it('leaves label null for an action on an unknown entity', async () => {
      const { cookie } = await loginAs('guest-pass-12345678')

      await fetch(`${baseUrl}/api/devices/light.not_allowlisted/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest()?.label).toBeNull()
    })

    it('does not record an admin action', async () => {
      const { cookie } = await loginAs('admin-pass-87654321')

      await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest()).toBeNull()
    })
  })
})
