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
import {
  entityIdsSeen,
  framesOfType,
  openSseConnection,
  openStream,
  waitFor,
  waitForFrame,
} from './sse-client.ts'

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

    const guestStream = await openSseConnection(baseUrl, guest.cookie)
    const adminStream = await openSseConnection(baseUrl, admin.cookie, `?portalId=${portal.id}`)
    expect(guestStream.res.status).toBe(200)
    expect(adminStream.res.status).toBe(200)

    portals.update(portal.id, { enabled: false })

    // The guest stream must receive the portal frame, then close.
    expect(await waitForFrame(guestStream.frames, 'portal')).toBe(true)
    await expect(guestStream.closed()).resolves.toBe(true)

    // The admin stream must still be open. Asked of the connection itself, not
    // of a single read(): the buffered initial snapshot satisfies one read()
    // even on a stream the server has already closed.
    expect(adminStream.isClosed()).toBe(false)

    adminStream.abort()
    await adminStream.pump
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
    // Disjoint allowlists. A shared entity would reach both guests
    // legitimately, so the test could not fail however the patch was routed.
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
    const mary = portals.create({ title: 'Mary', password: 'mary-pass' })
    allowlist.replace(timothy.id, [
      { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    allowlist.replace(mary.id, [
      { entityId: 'lock.front', label: 'Front', allowedActions: ['lock'], sortOrder: 0 },
    ])

    const { cookie: timothyCookie } = await loginAs('timothy-pass')
    const { cookie: maryCookie } = await loginAs('mary-pass')

    const timothyStream = await openStream(baseUrl, timothyCookie)
    const maryStream = await openStream(baseUrl, maryCookie)
    expect(await waitForFrame(timothyStream.frames, 'snapshot')).toBe(true)
    expect(await waitForFrame(maryStream.frames, 'snapshot')).toBe(true)

    fake.setState('lock.front', 'unlocked')

    expect(await waitForFrame(maryStream.frames, 'patch')).toBe(true)
    const maryPatch = maryStream.frames.find((f) => f.type === 'patch')
    if (maryPatch?.type !== 'patch') throw new Error('Expected a patch frame for Mary')
    expect(maryPatch.devices.map((d) => d.entityId)).toEqual(['lock.front'])

    // Mary's patch has landed, so an unrouted broadcast would already have
    // landed on Timothy too.
    expect(framesOfType(timothyStream.frames, 'patch')).toEqual([])
    expect(entityIdsSeen(timothyStream.frames)).not.toContain('lock.front')

    // ...and the same in the other direction.
    fake.setState('light.porch', 'on')
    expect(await waitForFrame(timothyStream.frames, 'patch')).toBe(true)
    expect(framesOfType(maryStream.frames, 'patch')).toHaveLength(1)
    expect(entityIdsSeen(maryStream.frames)).not.toContain('light.porch')

    timothyStream.abort()
    maryStream.abort()
    await timothyStream.pump
    await maryStream.pump
  })

  it("ignores a guest-supplied ?portalId= on the stream and serves only the session's portal", async () => {
    // /api/stream is intercepted before Hono, so it does not share the
    // resolvePortalId() that protects /api/devices — the rule is reimplemented
    // there and needs its own guard.
    const timothy = portals.create({ title: 'Timothy', password: 'stream-scope-timothy' })
    const mary = portals.create({ title: 'Mary', password: 'stream-scope-mary' })
    allowlist.replace(timothy.id, [
      { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    allowlist.replace(mary.id, [
      { entityId: 'lock.front', label: 'Front', allowedActions: ['lock'], sortOrder: 0 },
    ])

    const { cookie: timothyCookie } = await loginAs('stream-scope-timothy')
    const { cookie: maryCookie } = await loginAs('stream-scope-mary')

    const attacker = await openStream(baseUrl, timothyCookie, `?portalId=${mary.id}`)
    const maryStream = await openStream(baseUrl, maryCookie)
    expect(await waitForFrame(attacker.frames, 'snapshot')).toBe(true)
    expect(await waitForFrame(maryStream.frames, 'snapshot')).toBe(true)

    const snapshot = attacker.frames.find((f) => f.type === 'snapshot')
    if (snapshot?.type !== 'snapshot') throw new Error('Expected a snapshot frame')
    expect(snapshot.devices.map((d) => d.entityId)).toEqual(['light.porch'])

    fake.setState('lock.front', 'unlocked')
    expect(await waitForFrame(maryStream.frames, 'patch')).toBe(true)

    expect(framesOfType(attacker.frames, 'patch')).toEqual([])
    expect(entityIdsSeen(attacker.frames)).not.toContain('lock.front')

    attacker.abort()
    maryStream.abort()
    await attacker.pump
    await maryStream.pump
  })

  it("only streams a fresh snapshot to the portal whose allowlist changed", async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'snapshot-scope-timothy' })
    const mary = portals.create({ title: 'Mary', password: 'snapshot-scope-mary' })
    allowlist.replace(timothy.id, [
      { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    allowlist.replace(mary.id, [
      { entityId: 'lock.front', label: 'Front', allowedActions: ['lock'], sortOrder: 0 },
    ])

    const { cookie: timothyCookie } = await loginAs('snapshot-scope-timothy')
    const { cookie: maryCookie } = await loginAs('snapshot-scope-mary')

    const timothyStream = await openStream(baseUrl, timothyCookie)
    const maryStream = await openStream(baseUrl, maryCookie)
    expect(await waitForFrame(timothyStream.frames, 'snapshot')).toBe(true)
    expect(await waitForFrame(maryStream.frames, 'snapshot')).toBe(true)
    const timothySnapshotsBefore = framesOfType(timothyStream.frames, 'snapshot').length

    allowlist.replace(mary.id, [
      { entityId: 'lock.front', label: 'Front', allowedActions: ['lock'], sortOrder: 0 },
      { entityId: 'switch.fan', label: 'Fan', allowedActions: ['turn_on'], sortOrder: 1 },
    ])

    expect(
      await waitFor(() => framesOfType(maryStream.frames, 'snapshot').length > 1),
    ).toBe(true)

    // Widening the union does legitimately resubscribe HA, which re-announces
    // Timothy's own entities as a patch. What must not reach him is another
    // *snapshot* — or any sight of Mary's entities.
    expect(framesOfType(timothyStream.frames, 'snapshot')).toHaveLength(timothySnapshotsBefore)
    expect(entityIdsSeen(timothyStream.frames)).not.toContain('switch.fan')
    expect(entityIdsSeen(timothyStream.frames)).not.toContain('lock.front')

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

  it("deleting one portal drops only that portal's guest stream and session", async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-3' })
    portals.create({ title: 'Mary', password: 'mary-pass-3' })

    const { cookie: timothyCookie } = await loginAs('timothy-pass-3')
    const { cookie: maryCookie } = await loginAs('mary-pass-3')

    const timothyStream = await openSseConnection(baseUrl, timothyCookie)
    const maryStream = await openSseConnection(baseUrl, maryCookie)

    portals.delete(timothy.id)

    // The portal frame must go out before the stream closes, same as the
    // disable path: a client still listening learns why before the drop.
    expect(await waitForFrame(timothyStream.frames, 'portal')).toBe(true)
    await expect(timothyStream.closed()).resolves.toBe(true)
    expect(maryStream.isClosed()).toBe(false)

    // The session is gone too, so the client's stream-drop recheck lands on
    // the login screen rather than reconnecting to a portal that no longer exists.
    const recheck = await fetch(`${baseUrl}/api/session`, { headers: { cookie: timothyCookie } })
    expect(recheck.status).toBe(401)
    const maryRecheck = await fetch(`${baseUrl}/api/session`, { headers: { cookie: maryCookie } })
    expect(maryRecheck.status).toBe(200)

    maryStream.abort()
    await maryStream.pump
  })

  // Disabling a portal deliberately spares its admins — they still need the
  // stream to turn it back on. Deleting it does not: there is no portal left
  // to watch, so a surviving admin stream is an open connection that can never
  // carry another frame.
  it("deleting one portal drops its admin stream too, and no other portal's", async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'admin-del-timothy' })
    const mary = portals.create({ title: 'Mary', password: 'admin-del-mary' })
    const { cookie: adminCookie } = await loginAs('admin-pass-87654321')

    const timothyStream = await openSseConnection(baseUrl, adminCookie, `?portalId=${timothy.id}`)
    const maryStream = await openSseConnection(baseUrl, adminCookie, `?portalId=${mary.id}`)
    expect(timothyStream.res.status).toBe(200)
    expect(maryStream.res.status).toBe(200)

    portals.delete(timothy.id)

    await expect(timothyStream.closed()).resolves.toBe(true)

    // Both streams belong to the same admin session, so closing by session
    // would take Mary's as well.
    expect(maryStream.isClosed()).toBe(false)

    maryStream.abort()
    await maryStream.pump
  })

  it('resubscribes HA to the union across every portal after an allowlist PUT', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'union-timothy-pass' })
    const mary = portals.create({ title: 'Mary', password: 'union-mary-pass' })
    allowlist.replace(mary.id, [
      { entityId: 'lock.front', label: 'Front', allowedActions: ['lock'], sortOrder: 0 },
    ])
    const { cookie: adminCookie } = await loginAs('admin-pass-87654321')

    const res = await fetch(`${baseUrl}/api/admin/portals/${timothy.id}/allowlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        devices: [
          { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
        ],
      }),
    })
    expect(res.status).toBe(200)

    // The union, not just the portal that changed: dropping the other portals
    // would silently stop their live updates.
    expect(
      await waitFor(() => {
        const ids = fake.subscribedEntityIds()
        return ids !== null && ids.length === 2
      }),
    ).toBe(true)
    expect([...(fake.subscribedEntityIds() ?? [])].sort()).toEqual(['light.porch', 'lock.front'])

    // ...and emptying one portal's list narrows the union back rather than
    // leaving a stale subscription behind.
    const cleared = await fetch(`${baseUrl}/api/admin/portals/${mary.id}/allowlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ devices: [] }),
    })
    expect(cleared.status).toBe(200)

    expect(
      await waitFor(() => {
        const ids = fake.subscribedEntityIds()
        return ids !== null && ids.length === 1
      }),
    ).toBe(true)
    expect(fake.subscribedEntityIds()).toEqual(['light.porch'])
  })

  it('narrows the HA subscription when a portal is deleted', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'del-timothy-pass' })
    const mary = portals.create({ title: 'Mary', password: 'del-mary-pass' })
    allowlist.replace(timothy.id, [
      { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    allowlist.replace(mary.id, [
      { entityId: 'lock.front', label: 'Front', allowedActions: ['lock'], sortOrder: 0 },
    ])
    const { cookie: adminCookie } = await loginAs('admin-pass-87654321')

    expect(
      await waitFor(() => {
        const ids = fake.subscribedEntityIds()
        return ids !== null && ids.length === 2
      }),
    ).toBe(true)

    const res = await fetch(`${baseUrl}/api/admin/portals/${mary.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)

    // Mary's allowlist rows go with her portal by FK cascade, which fires no
    // store listener — so nothing recomputes the union unless the delete path
    // does it, and HA keeps streaming an entity no portal can show.
    expect(
      await waitFor(() => {
        const ids = fake.subscribedEntityIds()
        return ids !== null && ids.length === 1
      }, 2000),
    ).toBe(true)
    expect(fake.subscribedEntityIds()).toEqual(['light.porch'])
  })

  it('closes the logging-out session’s stream and nobody else’s', async () => {
    portals.create({ title: 'Timothy', password: 'logout-timothy-pass' })

    // Two sessions on the SAME portal: closing by portal would take both, and
    // the point is that logout is scoped to the one session that ended.
    const { cookie: leaving } = await loginAs('logout-timothy-pass')
    const { cookie: staying } = await loginAs('logout-timothy-pass')

    const leavingStream = await openSseConnection(baseUrl, leaving)
    const stayingStream = await openSseConnection(baseUrl, staying)

    const res = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { cookie: leaving },
    })
    expect(res.status).toBe(200)

    await expect(leavingStream.closed()).resolves.toBe(true)
    expect(stayingStream.isClosed()).toBe(false)

    stayingStream.abort()
    await stayingStream.pump
  })

  it('refuses an admin stream for a portal that does not exist', async () => {
    const { cookie: adminCookie } = await loginAs('admin-pass-87654321')

    // The stream used to open regardless, hold the connection, and emit an
    // empty snapshot — indistinguishable from a real portal with no devices.
    const res = await fetch(`${baseUrl}/api/stream?portalId=no-such-portal`, {
      headers: { cookie: adminCookie, accept: 'text/event-stream' },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('clears the last-selected pointer when that portal is deleted', async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'sel-timothy-pass' })
    const mary = portals.create({ title: 'Mary', password: 'sel-mary-pass' })
    const { cookie: adminCookie } = await loginAs('admin-pass-87654321')

    const select = await fetch(`${baseUrl}/api/admin/last-selected-portal`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ portalId: mary.id }),
    })
    expect(select.status).toBe(200)

    const deleteOther = await fetch(`${baseUrl}/api/admin/portals/${timothy.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    })
    expect(deleteOther.status).toBe(200)

    // Deleting some other portal must leave the pointer alone.
    const stillMary = await fetch(`${baseUrl}/api/admin/portals`, {
      headers: { cookie: adminCookie },
    })
    expect(await stillMary.json()).toMatchObject({ lastSelectedPortalId: mary.id })

    const deleteSelected = await fetch(`${baseUrl}/api/admin/portals/${mary.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    })
    expect(deleteSelected.status).toBe(200)

    const after = await fetch(`${baseUrl}/api/admin/portals`, { headers: { cookie: adminCookie } })
    expect(await after.json()).toMatchObject({ lastSelectedPortalId: null })
  })

  it("rotating one portal's password drops only that portal's guest stream and session", async () => {
    const timothy = portals.create({ title: 'Timothy', password: 'timothy-rotate-1' })
    portals.create({ title: 'Mary', password: 'mary-rotate-1' })

    const { cookie: timothyCookie } = await loginAs('timothy-rotate-1')
    const { cookie: maryCookie } = await loginAs('mary-rotate-1')
    const { cookie: adminCookie } = await loginAs('admin-pass-87654321')

    const timothyStream = await openSseConnection(baseUrl, timothyCookie)
    const maryStream = await openSseConnection(baseUrl, maryCookie)

    const res = await fetch(`${baseUrl}/api/admin/portals/${timothy.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ password: 'timothy-rotate-2' }),
    })
    expect(res.status).toBe(200)

    await expect(timothyStream.closed()).resolves.toBe(true)
    expect(maryStream.isClosed()).toBe(false)

    const recheck = await fetch(`${baseUrl}/api/session`, { headers: { cookie: timothyCookie } })
    expect(recheck.status).toBe(401)
    const maryRecheck = await fetch(`${baseUrl}/api/session`, { headers: { cookie: maryCookie } })
    expect(maryRecheck.status).toBe(200)

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
