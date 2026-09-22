/**
 * The admin gate on /api/admin/* is assembled in app.ts — `requireSession`
 * mounted there, then the role check mountAdminRoutes installs — and every
 * other admin-route test stands up its own bespoke harness with a stand-in
 * gate, so none of them would notice if the real wiring came apart. This file
 * drives the real `createApp` over a real socket for exactly that reason.
 */
import { getRequestListener } from '@hono/node-server'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.ts'
import type { Config } from '../../src/server/config.ts'
import { HaClient } from '../../src/server/ha/client.ts'
import { LoginRateLimiter, SessionStore } from '../../src/server/http/auth.ts'
import type { Deps } from '../../src/server/http/routes-guest.ts'
import { SseHub } from '../../src/server/http/sse.ts'
import { AllowlistStore } from '../../src/server/store/allowlist.ts'
import { AuditLog } from '../../src/server/store/auditlog.ts'
import { openDb } from '../../src/server/store/db.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'
import { PortalStore } from '../../src/server/store/portals.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'

const GUEST_PASSWORD = 'guest-pass-12345678'
const ADMIN_PASSWORD = 'admin-pass-87654321'

describe('admin authorization on the real app', () => {
  let db: import('node:sqlite').DatabaseSync
  let portals: PortalStore
  let allowlist: AllowlistStore
  let server: Server
  let baseUrl: string
  let portalId: string

  async function loginAs(password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const cookie = res.headers.get('set-cookie')
    if (!cookie) throw new Error(`login with ${password} did not set a cookie`)
    return cookie
  }

  function putAllowlist(cookie?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/admin/portals/${portalId}/allowlist`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({
        devices: [
          { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on'], sortOrder: 0 },
        ],
      }),
    })
  }

  beforeEach(async () => {
    db = openDb(':memory:')
    portals = new PortalStore(db)
    allowlist = new AllowlistStore(db)
    portalId = portals.create({ title: 'Timothy', password: GUEST_PASSWORD }).id

    const cfg: Config = {
      haBaseUrl: 'http://127.0.0.1:1',
      haWsUrl: undefined,
      haToken: 'test-ha-token',
      adminPassword: ADMIN_PASSWORD,
      port: 8080,
      // Off deliberately: with ingress on, a Supervisor-sourced request is
      // pre-authenticated as admin, and this file is about the session gate.
      ingressPort: undefined,
      dbPath: ':memory:',
      trustProxy: undefined,
    }

    const deps: Deps = {
      cfg,
      // Never started, so it opens no socket. No route exercised here calls it.
      ha: HaClient.create({ haBaseUrl: cfg.haBaseUrl, haToken: cfg.haToken }),
      allowlist,
      audit: new AuditLog(db),
      settings: new SettingsStore(db),
      interactions: new InteractionStore(db),
      portals,
      sessions: new SessionStore(),
      limiter: new LoginRateLimiter({ perIpMax: 10, windowMs: 60_000 }),
      hub: new SseHub(),
    }

    server = createServer(getRequestListener(createApp(deps).fetch))
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
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  })

  it("refuses a guest session on another's allowlist with 403", async () => {
    const guestCookie = await loginAs(GUEST_PASSWORD)

    const res = await putAllowlist(guestCookie)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(allowlist.list(portalId)).toEqual([])
  })

  it('refuses a guest session on the portal list with 403', async () => {
    const guestCookie = await loginAs(GUEST_PASSWORD)

    const res = await fetch(`${baseUrl}/api/admin/portals`, { headers: { cookie: guestCookie } })

    expect(res.status).toBe(403)
  })

  it('refuses an unauthenticated request with 401', async () => {
    const res = await putAllowlist()
    expect(res.status).toBe(401)
  })

  it('lets an admin session through', async () => {
    const adminCookie = await loginAs(ADMIN_PASSWORD)

    const res = await putAllowlist(adminCookie)

    expect(res.status).toBe(200)
    expect(allowlist.list(portalId).map((d) => d.entityId)).toEqual(['light.porch'])
  })
})
