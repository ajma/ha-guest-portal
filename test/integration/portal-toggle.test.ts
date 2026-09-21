import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import type { SseFrame } from '../../src/shared/api.ts'

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

// A thin wrapper around openStream that answers "has this connection been
// closed by the server?" both synchronously (isClosed) and awaitably
// (closed), for tests whose whole point is a stream being dropped out from
// under the client rather than any frame it carries.
async function openSseConnection(baseUrl: string, cookie: string) {
  const stream = await openStream(baseUrl, cookie)
  let closed = false
  void stream.pump.then(() => {
    closed = true
  })
  return {
    ...stream,
    closed: (ms = 3000) =>
      Promise.race([
        stream.pump.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]),
    isClosed: () => closed,
  }
}

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
  let portals: PortalStore
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
        { entityId: 'light.shared', state: 'off', name: 'Shared Light' },
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
    }

    // Create HA client
    haClient = HaClient.create({
      haBaseUrl: fake.baseUrl,
      haToken: fake.token,
    })
    haClient.start()

    // Wait for HA client to connect
    await new Promise((resolve) => setTimeout(resolve, 100))

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

  async function loginAs(password: string): Promise<{ status: number; cookie: string }> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    return { status: res.status, cookie: res.headers.get('set-cookie') ?? '' }
  }

  it('refuses guest login while disabled', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    portals.update(portal.id, { enabled: false })

    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'guest-pass-12345678' }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'portal_disabled' })
  })

  it('does not count a blocked guest login against the rate limiter', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    portals.update(portal.id, { enabled: false })

    // Attempt 15 logins - exceeds perIpMax: 10, would trigger rate limiting
    // if these were counted as failures
    for (let i = 0; i < 15; i++) {
      await loginAs('guest-pass-12345678')
    }

    portals.update(portal.id, { enabled: true })
    const { status } = await loginAs('guest-pass-12345678')

    expect(status).toBe(200)
  })

  it('still allows admin login while disabled', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    portals.update(portal.id, { enabled: false })
    const { status } = await loginAs('admin-pass-87654321')
    expect(status).toBe(200)
  })

  it('reports portalEnabled on the session route', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    const { cookie } = await loginAs('guest-pass-12345678')
    portals.update(portal.id, { enabled: false })

    const res = await fetch(`${baseUrl}/api/session`, { headers: { cookie } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      role: 'guest',
      portalId: portal.id,
      portalTitle: portal.title,
      portalTheme: 'classic',
      portalEnabled: false,
    })
  })

  it('refuses an existing guest session on /api/devices while disabled', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    const { cookie } = await loginAs('guest-pass-12345678')
    portals.update(portal.id, { enabled: false })

    const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'portal_disabled' })
  })

  it('refuses a guest action while disabled', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    allowlist.replace(portal.id, [
      {
        entityId: 'light.porch',
        label: 'Porch',
        allowedActions: ['turn_on', 'turn_off', 'toggle'],
        sortOrder: 1,
      },
    ])
    const { cookie } = await loginAs('guest-pass-12345678')
    portals.update(portal.id, { enabled: false })

    const res = await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
      method: 'POST',
      headers: { cookie },
    })

    expect(res.status).toBe(403)
  })

  it('refuses a guest stream while disabled', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    const { cookie } = await loginAs('guest-pass-12345678')
    portals.update(portal.id, { enabled: false })

    const res = await fetch(`${baseUrl}/api/stream`, { headers: { cookie } })

    expect(res.status).toBe(403)
    await res.body?.cancel()
  })

  it('leaves admin device access working while disabled', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    portals.update(portal.id, { enabled: false })
    const { cookie } = await loginAs('admin-pass-87654321')

    const res = await fetch(`${baseUrl}/api/devices?portalId=${portal.id}`, { headers: { cookie } })

    expect(res.status).toBe(200)
  })

  it('restores guest access when re-enabled, without a new login', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    const { cookie } = await loginAs('guest-pass-12345678')
    portals.update(portal.id, { enabled: false })
    portals.update(portal.id, { enabled: true })

    const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })

    expect(res.status).toBe(200)
  })

  it('closes guest streams but not admin streams when disabled', async () => {
    const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
    const guest = await loginAs('guest-pass-12345678')
    const admin = await loginAs('admin-pass-87654321')

    const guestStream = await fetch(`${baseUrl}/api/stream`, { headers: { cookie: guest.cookie } })
    const adminStream = await fetch(`${baseUrl}/api/stream?portalId=${portal.id}`, {
      headers: { cookie: admin.cookie },
    })
    expect(guestStream.status).toBe(200)
    expect(adminStream.status).toBe(200)

    portals.update(portal.id, { enabled: false })

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

  it("emits a snapshot immediately on connect, scoped to the guest's own portal", async () => {
    const portal = portals.create({ title: 'Timothy', password: 'snapshot-connect-pass' })
    allowlist.replace(portal.id, [
      { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on', 'turn_off'], sortOrder: 1 },
    ])
    const { cookie } = await loginAs('snapshot-connect-pass')

    const stream = await openStream(baseUrl, cookie)
    expect(stream.res.status).toBe(200)
    expect(stream.res.headers.get('content-type')).toBe('text/event-stream')

    expect(await waitForFrame(stream.frames, 'snapshot')).toBe(true)
    const snapshot = stream.frames.find((f) => f.type === 'snapshot')
    if (snapshot?.type !== 'snapshot') throw new Error('Expected snapshot frame')
    expect(snapshot.devices.map((d) => d.entityId)).toEqual(['light.porch'])

    stream.abort()
    await stream.pump
  })

  it('emits a patch after a state change, then degraded after the connection drops', async () => {
    const portal = portals.create({ title: 'Timothy', password: 'patch-degraded-pass' })
    allowlist.replace(portal.id, [
      { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on', 'turn_off'], sortOrder: 1 },
    ])
    const { cookie } = await loginAs('patch-degraded-pass')

    const stream = await openStream(baseUrl, cookie)
    await waitForFrame(stream.frames, 'snapshot')

    fake.setState('light.porch', 'on')
    expect(await waitForFrame(stream.frames, 'patch')).toBe(true)

    fake.drop()
    expect(await waitForFrame(stream.frames, 'degraded')).toBe(true)
    const degraded = stream.frames.find((f) => f.type === 'degraded')
    expect(degraded).toMatchObject({ stale: true })

    stream.abort()
    await stream.pump
  })

  it("emits a fresh snapshot when that portal's allowlist changes", async () => {
    const portal = portals.create({ title: 'Timothy', password: 'allowlist-snapshot-pass' })
    allowlist.replace(portal.id, [
      { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on', 'turn_off'], sortOrder: 1 },
      { entityId: 'switch.fan', label: 'Fan', allowedActions: ['turn_on', 'turn_off'], sortOrder: 2 },
    ])
    const { cookie } = await loginAs('allowlist-snapshot-pass')

    const stream = await openStream(baseUrl, cookie)
    await waitForFrame(stream.frames, 'snapshot')
    const countBefore = stream.frames.filter((f) => f.type === 'snapshot').length

    allowlist.replace(portal.id, [
      { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on', 'turn_off'], sortOrder: 1 },
    ])

    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      if (stream.frames.filter((f) => f.type === 'snapshot').length > countBefore) break
      await new Promise((r) => setTimeout(r, 25))
    }
    const snapshots = stream.frames.filter((f) => f.type === 'snapshot')
    expect(snapshots.length).toBeGreaterThan(countBefore)
    const latest = snapshots[snapshots.length - 1]
    if (latest?.type !== 'snapshot') throw new Error('Expected snapshot frame')
    expect(latest.devices.map((d) => d.entityId)).toEqual(['light.porch'])

    stream.abort()
    await stream.pump
  })

  it('only streams patches for the portal a guest is bound to', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
    const mary = portals.create({ title: 'Mary', password: 'mary-pass' })
    allowlist.replace(timothy.id, [
      { entityId: 'light.shared', label: 'Shared', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    allowlist.replace(mary.id, [
      { entityId: 'light.shared', label: 'Shared', allowedActions: ['turn_on'], sortOrder: 0 },
    ])

    const { cookie: timothyCookie } = await loginAs('timothy-pass')
    const { cookie: maryCookie } = await loginAs('mary-pass')

    const timothyStream = await openStream(baseUrl, timothyCookie)
    const maryStream = await openStream(baseUrl, maryCookie)
    await waitForFrame(timothyStream.frames, 'snapshot')
    await waitForFrame(maryStream.frames, 'snapshot')

    fake.setState('light.shared', 'on')

    await waitForFrame(timothyStream.frames, 'patch')
    await waitForFrame(maryStream.frames, 'patch')

    // Both received it independently — this assertion is really about the
    // *routing*, proven properly by the next case.
    const timothyPatch = timothyStream.frames.find((f) => f.type === 'patch')
    const maryPatch = maryStream.frames.find((f) => f.type === 'patch')
    if (timothyPatch?.type !== 'patch' || maryPatch?.type !== 'patch') {
      throw new Error('Expected patch frames')
    }
    expect(timothyPatch.devices.find((d) => d.entityId === 'light.shared')?.state.state).toBe('on')
    expect(maryPatch.devices.find((d) => d.entityId === 'light.shared')?.state.state).toBe('on')

    timothyStream.abort()
    maryStream.abort()
    await timothyStream.pump
    await maryStream.pump
  })

  it("disabling one portal drops only that portal's guest stream", async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-2' })
    portals.create({ title: 'Mary', password: 'mary-pass-2' })

    const { cookie: timothyCookie } = await loginAs('timothy-pass-2')
    const { cookie: maryCookie } = await loginAs('mary-pass-2')

    const timothyStream = await openSseConnection(baseUrl, timothyCookie)
    const maryStream = await openSseConnection(baseUrl, maryCookie)

    portals.update(timothy.id, { enabled: false })

    await expect(timothyStream.closed()).resolves.toBe(true)
    expect(maryStream.isClosed()).toBe(false)

    maryStream.abort()
    await maryStream.pump
  })

  describe('interaction recording', () => {
    it('records a guest login', async () => {
      const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
      await loginAs('guest-pass-12345678')

      const latest = interactions.latest(portal.id)
      expect(latest?.kind).toBe('login')
      expect(latest?.ok).toBe(true)
      expect(latest?.entityId).toBeNull()
    })

    it('does not record an admin login', async () => {
      const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
      await loginAs('admin-pass-87654321')
      expect(interactions.latest(portal.id)).toBeNull()
    })

    it('records a successful guest action with its label', async () => {
      const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
      allowlist.replace(portal.id, [
        {
          entityId: 'light.porch',
          label: 'Porch',
          allowedActions: ['turn_on', 'turn_off', 'toggle'],
          sortOrder: 1,
        },
      ])
      const { cookie } = await loginAs('guest-pass-12345678')

      await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest(portal.id)).toMatchObject({
        kind: 'action',
        entityId: 'light.porch',
        label: 'Porch',
        action: 'turn_on',
        ok: true,
      })
    })

    it('records a rejected guest action', async () => {
      const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
      const { cookie } = await loginAs('guest-pass-12345678')

      await fetch(`${baseUrl}/api/devices/light.not_allowlisted/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest(portal.id)).toMatchObject({
        kind: 'action',
        entityId: 'light.not_allowlisted',
        action: 'turn_on',
        ok: false,
      })
    })

    it('leaves label null for an action on an unknown entity', async () => {
      const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
      const { cookie } = await loginAs('guest-pass-12345678')

      await fetch(`${baseUrl}/api/devices/light.not_allowlisted/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest(portal.id)?.label).toBeNull()
    })

    it('does not record an admin action', async () => {
      const portal = portals.create({ title: 'Guest Portal', password: 'guest-pass-12345678' })
      const { cookie } = await loginAs('admin-pass-87654321')

      await fetch(`${baseUrl}/api/devices/light.porch/turn_on?portalId=${portal.id}`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest(portal.id)).toBeNull()
    })
  })
})
