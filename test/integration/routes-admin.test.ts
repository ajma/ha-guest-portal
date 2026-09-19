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

describe('Admin API routes', () => {
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
  let guestCookie: string
  let adminCookie: string

  beforeEach(async () => {
    // Start fake HA
    fake = await FakeHomeAssistant.start({ token: 'test-ha-token' })
    fake.seed(
      [
        { entityId: 'light.porch', state: 'off', name: 'Porch Light', areaId: 'area1' },
        { entityId: 'light.kitchen', state: 'on', name: 'Kitchen Light', areaId: 'area2' },
        { entityId: 'lock.front', state: 'locked', name: 'Front Lock', areaId: 'area1' },
        { entityId: 'switch.fan', state: 'off', name: 'Ceiling Fan', areaId: null },
        { entityId: 'climate.living', state: 'off', name: 'Living Room AC', areaId: 'area3' },
      ],
      [
        { areaId: 'area1', name: 'Entrance' },
        { areaId: 'area2', name: 'Kitchen' },
        { areaId: 'area3', name: 'Living Room' },
      ],
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

    // Login as guest
    const guestRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'guest-pass-12345678' }),
    })
    guestCookie = guestRes.headers.get('set-cookie') ?? ''

    // Login as admin
    const adminRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-pass-87654321' }),
    })
    adminCookie = adminRes.headers.get('set-cookie') ?? ''
  })

  afterEach(async () => {
    // Use runtime.close() which handles everything
    await runtime.close()

    // Stop fake
    await fake.stop()

    // Close DB
    db.close()
  })

  describe('GET /api/admin/entities', () => {
    it('returns 401 when no session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`)
      expect(res.status).toBe(401)
    })

    it('returns 403 when guest session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`, {
        headers: { Cookie: guestCookie },
      })
      expect(res.status).toBe(403)
    })

    it('returns 200 with catalog when admin session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveProperty('entities')
      expect(Array.isArray(body.entities)).toBe(true)
      expect(body.entities.length).toBeGreaterThan(0)
    })

    it('catalog includes area and supported flag', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      const porch = body.entities.find((e: { entityId: string }) => e.entityId === 'light.porch')
      expect(porch).toBeDefined()
      expect(porch).toHaveProperty('area')
      expect(porch).toHaveProperty('supported')
    })

    it('catalog includes unsupported entities', async () => {
      const res = await fetch(`${baseUrl}/api/admin/entities`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      const climate = body.entities.find(
        (e: { entityId: string }) => e.entityId === 'climate.living',
      )
      expect(climate).toBeDefined()
      expect(climate.supported).toBe(false)
    })
  })

  describe('GET /api/admin/allowlist', () => {
    it('returns 401 when no session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/allowlist`)
      expect(res.status).toBe(401)
    })

    it('returns 403 when guest session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        headers: { Cookie: guestCookie },
      })
      expect(res.status).toBe(403)
    })

    it('returns 200 with allowlist when admin session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveProperty('devices')
      expect(body).toHaveProperty('orphaned')
      expect(Array.isArray(body.devices)).toBe(true)
      expect(Array.isArray(body.orphaned)).toBe(true)
    })

    it('orphaned is empty when all allowlisted entities exist', async () => {
      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.orphaned).toEqual([])
    })

    it('orphaned lists entity IDs not in catalog', async () => {
      // Add an allowlist entry for a non-existent entity
      allowlist.replace([
        {
          entityId: 'light.porch',
          label: 'Porch',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 1,
        },
        {
          entityId: 'light.deleted',
          label: 'Deleted Light',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 2,
        },
      ])

      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        headers: { Cookie: adminCookie },
      })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.orphaned).toContain('light.deleted')
      expect(body.orphaned).not.toContain('light.porch')
    })
  })

  describe('PUT /api/admin/allowlist', () => {
    it('returns 401 when no session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices: [] }),
      })
      expect(res.status).toBe(401)
    })

    it('returns 403 when guest session', async () => {
      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: guestCookie,
        },
        body: JSON.stringify({ devices: [] }),
      })
      expect(res.status).toBe(403)
    })

    it('persists allowlist and returns 200', async () => {
      const newAllowlist = {
        devices: [
          {
            entityId: 'light.kitchen',
            label: 'Kitchen',
            allowedActions: ['turn_on', 'turn_off'],
            sortOrder: 1,
          },
        ],
      }

      const putRes = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: JSON.stringify(newAllowlist),
      })

      expect(putRes.status).toBe(200)

      // Verify it round-trips
      const getRes = await fetch(`${baseUrl}/api/admin/allowlist`, {
        headers: { Cookie: adminCookie },
      })

      expect(getRes.status).toBe(200)

      const body = await getRes.json()
      expect(body.devices).toHaveLength(1)
      expect(body.devices[0]?.entityId).toBe('light.kitchen')
      expect(body.devices[0]?.label).toBe('Kitchen')
    })

    it('returns 400 for climate.* entity', async () => {
      const payload = {
        devices: [
          {
            entityId: 'climate.living',
            label: 'Living Room',
            allowedActions: ['turn_on'],
            sortOrder: 1,
          },
        ],
      }

      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: JSON.stringify(payload),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for duplicate entity ID', async () => {
      const payload = {
        devices: [
          {
            entityId: 'light.porch',
            label: 'First',
            allowedActions: ['turn_on'],
            sortOrder: 1,
          },
          {
            entityId: 'light.porch',
            label: 'Second',
            allowedActions: ['turn_off'],
            sortOrder: 2,
          },
        ],
      }

      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: JSON.stringify(payload),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for illegal action for domain', async () => {
      const payload = {
        devices: [
          {
            entityId: 'light.porch',
            label: 'Porch',
            allowedActions: ['unlock'],
            sortOrder: 1,
          },
        ],
      }

      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: JSON.stringify(payload),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for empty label', async () => {
      const payload = {
        devices: [
          {
            entityId: 'light.porch',
            label: '',
            allowedActions: ['turn_on'],
            sortOrder: 1,
          },
        ],
      }

      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: JSON.stringify(payload),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for whitespace-only label', async () => {
      const payload = {
        devices: [
          {
            entityId: 'light.porch',
            label: '   ',
            allowedActions: ['turn_on'],
            sortOrder: 1,
          },
        ],
      }

      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: JSON.stringify(payload),
      })

      expect(res.status).toBe(400)
    })

    it('triggers resubscribe and fake.subscribedEntityIds reflects new set', async () => {
      const newAllowlist = {
        devices: [
          {
            entityId: 'light.kitchen',
            label: 'Kitchen',
            allowedActions: ['turn_on', 'turn_off'],
            sortOrder: 1,
          },
          {
            entityId: 'switch.fan',
            label: 'Fan',
            allowedActions: ['turn_on', 'turn_off'],
            sortOrder: 2,
          },
        ],
      }

      const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: JSON.stringify(newAllowlist),
      })

      expect(res.status).toBe(200)

      // Wait for resubscribe to complete
      await new Promise((resolve) => setTimeout(resolve, 200))

      const subscribed = fake.subscribedEntityIds()
      expect(subscribed).toBeDefined()
      expect(subscribed).toContain('light.kitchen')
      expect(subscribed).toContain('switch.fan')
      expect(subscribed).not.toContain('light.porch')
      expect(subscribed).not.toContain('lock.front')
    })
  })
})
