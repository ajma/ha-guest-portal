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
import {
  entityIdsSeen,
  framesOfType,
  openSseConnection,
  openStream,
  waitFor,
  waitForFrame,
} from './sse-client.ts'

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
  let portals: PortalStore
  let defaultPortalId: string
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

    // Seed allowlist against a default portal
    allowlist = new AllowlistStore(db)
    portals = new PortalStore(db)
    const defaultPortal = portals.create({ title: 'Default Portal', password: 'guest-pass-12345678' })
    defaultPortalId = defaultPortal.id
    allowlist.replace(defaultPortal.id, [
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
    await haClient.setWatchedEntities(allowlist.entityIds(defaultPortal.id))

    // Create runtime - this wires all the event handlers and creates TWO servers
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

    // An arbitrary non-root, non-asset path — not a page. The gate must reject
    // before the SPA fallback gets a chance to answer.
    it('rejects an arbitrary non-API path with 403', async () => {
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

    it('rejects GET /api/admin/portals/:portalId/allowlist with 403', async () => {
      const res = await fetch(`${ingressUrl}/api/admin/portals/${defaultPortalId}/allowlist`)
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

    it('requires session for /api/admin/portals/:portalId/allowlist', async () => {
      const res = await fetch(`${directUrl}/api/admin/portals/${defaultPortalId}/allowlist`)
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
      const res = await fetch(`${directUrl}/api/admin/portals/${defaultPortalId}/allowlist`, {
        headers: {
          'X-Forwarded-For': '172.30.32.2',
        },
      })
      expect(res.status).toBe(401) // Still requires session
    })

    it('does not grant admin from spoofed X-Real-IP header', async () => {
      const res = await fetch(`${directUrl}/api/admin/portals/${defaultPortalId}/allowlist`, {
        headers: {
          'X-Real-IP': '172.30.32.2',
        },
      })
      expect(res.status).toBe(401) // Still requires session
    })
  })

  // Everything behind the source gate — the whole Supervisor-authenticated
  // admin path, including an /api/stream intercept that runs before Hono and
  // therefore inherits none of Hono's route-level portal isolation — used to
  // be untested on the grounds that a loopback test could never pass the gate.
  // It can: the gate reads `socket.remoteAddress`, and a `connection` listener
  // can redefine that on the accepted socket before the request handler runs.
  describe('Ingress admin stream, authenticated by source alone', () => {
    beforeEach(() => {
      ingressServer.on('connection', (socket) => {
        Object.defineProperty(socket, 'remoteAddress', {
          value: '172.30.32.2',
          configurable: true,
        })
      })
    })

    // Sanity check on the technique itself: if this 200s, the spoofed socket
    // really is getting past the gate, so a 403 in any test below would mean a
    // genuine rejection rather than a harness that never arrived.
    it('passes the source gate', async () => {
      const res = await fetch(`${ingressUrl}/api/session`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ role: 'admin' })
    })

    it('refuses a stream with no portalId', async () => {
      const res = await fetch(`${ingressUrl}/api/stream`)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Missing portalId' })
    })

    // The stream used to open regardless, hold the connection, and emit an
    // empty snapshot — indistinguishable from a real portal with no devices.
    it('refuses a stream for a portal that does not exist', async () => {
      const res = await fetch(`${ingressUrl}/api/stream?portalId=no-such-portal`, {
        headers: { accept: 'text/event-stream' },
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found' })
    })

    it('serves only the requested portal, and never another portal’s frames', async () => {
      const timothy = portals.create({ title: 'Timothy', password: 'ingress-timothy-pass' })
      const mary = portals.create({ title: 'Mary', password: 'ingress-mary-pass' })
      allowlist.replace(timothy.id, [
        { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
      ])
      allowlist.replace(mary.id, [
        { entityId: 'lock.front', label: 'Front', allowedActions: ['lock'], sortOrder: 0 },
      ])
      expect(
        await waitFor(() => (fake.subscribedEntityIds() ?? []).includes('lock.front')),
      ).toBe(true)

      const timothyStream = await openStream(ingressUrl, null, `?portalId=${timothy.id}`)
      const maryStream = await openStream(ingressUrl, null, `?portalId=${mary.id}`)
      expect(timothyStream.res.status).toBe(200)
      expect(maryStream.res.status).toBe(200)

      expect(await waitForFrame(timothyStream.frames, 'snapshot')).toBe(true)
      expect(await waitForFrame(maryStream.frames, 'snapshot')).toBe(true)

      const snapshot = timothyStream.frames.find((f) => f.type === 'snapshot')
      if (snapshot?.type !== 'snapshot') throw new Error('Expected a snapshot frame')
      expect(snapshot.devices.map((d) => d.entityId)).toEqual(['light.porch'])

      // Mary's entity changes: only Mary's stream may hear about it.
      fake.setState('lock.front', 'unlocked')
      expect(await waitForFrame(maryStream.frames, 'patch')).toBe(true)
      expect(framesOfType(timothyStream.frames, 'patch')).toEqual([])
      expect(entityIdsSeen(timothyStream.frames)).not.toContain('lock.front')

      // ...and the same in the other direction, which also proves the streams
      // are scoped rather than simply mute.
      fake.setState('light.porch', 'on')
      expect(await waitForFrame(timothyStream.frames, 'patch')).toBe(true)
      expect(framesOfType(maryStream.frames, 'patch')).toHaveLength(1)
      expect(entityIdsSeen(maryStream.frames)).not.toContain('light.porch')

      timothyStream.abort()
      maryStream.abort()
      await timothyStream.pump
      await maryStream.pump
      // Room for two five-second frame waits, so a stream that never receives
      // its patch fails on the assertion rather than on the test timeout.
    }, 15_000)

    // These streams hold no session, so session eviction cannot reach them:
    // without a portal-scoped close they would sit open and silent forever,
    // watching a portal that no longer exists.
    it('closes when the portal it watches is deleted, and nobody else’s', async () => {
      const timothy = portals.create({ title: 'Timothy', password: 'ingress-del-timothy' })
      const mary = portals.create({ title: 'Mary', password: 'ingress-del-mary' })

      const timothyStream = await openSseConnection(ingressUrl, null, `?portalId=${timothy.id}`)
      const maryStream = await openSseConnection(ingressUrl, null, `?portalId=${mary.id}`)
      expect(timothyStream.res.status).toBe(200)
      expect(maryStream.res.status).toBe(200)

      portals.delete(timothy.id)

      await expect(timothyStream.closed()).resolves.toBe(true)
      expect(maryStream.isClosed()).toBe(false)

      maryStream.abort()
      await maryStream.pump
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
        portals,
        sessions,
        limiter,
        hub,
      })

      expect(runtimeNoIngress.servers).toHaveLength(1)

      await runtimeNoIngress.close()
    })
  })
})
