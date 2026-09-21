import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import { validateAction } from '../../shared/devices.js'
import { DevicesResponse, LoginRequest, SessionResponse } from '../../shared/api.js'
import type { HaClient } from '../ha/client.js'
import type { AllowlistStore } from '../store/allowlist.js'
import type { AuditLog } from '../store/auditlog.js'
import type { SettingsStore } from '../store/settings.js'
import type { InteractionStore } from '../store/interactions.js'
import type { PortalStore } from '../store/portals.js'
import type { Config } from '../config.js'
import {
  SESSION_COOKIE,
  type SessionStore,
  type SessionData,
  type LoginRateLimiter,
  classify,
  clientIp,
} from './auth.js'
import type { SseHub } from './sse.js'
import type { Env } from '../app.js'
import type { Context } from 'hono'
import { assembleDevices } from '../device-assembly.js'

export type Deps = {
  cfg: Config
  ha: HaClient
  allowlist: AllowlistStore
  audit: AuditLog
  settings: SettingsStore
  interactions: InteractionStore
  portals: PortalStore
  sessions: SessionStore
  limiter: LoginRateLimiter
  hub: SseHub
}

type HonoContext = Context<Env>

function getClientIp(c: HonoContext, cfg: Config): string {
  const rawIp = c.env.incoming.socket.remoteAddress ?? '0.0.0.0'
  const forwardedFor = c.req.header('x-forwarded-for')
  const trustProxy = cfg.trustProxy
  return clientIp(rawIp, forwardedFor, trustProxy)
}

/**
 * A guest's portal is fixed by their session. An admin session carries no
 * portal of its own — they act on whichever portal `?portalId=` names, since
 * one admin identity reaches every portal.
 */
export function resolvePortalId(c: HonoContext, session: SessionData): string | null {
  if (session.role === 'guest') return session.portalId
  const fromQuery = c.req.query('portalId')
  return fromQuery ?? null
}

const FAILURE_STATUS = {
  not_allowlisted: 404,
  unsupported_domain: 403,
  action_not_valid_for_domain: 403,
  action_not_permitted: 403,
} as const satisfies Record<string, ContentfulStatusCode>

export function createRoutes(deps: Deps) {
  const { cfg, ha, allowlist, audit, interactions, portals, sessions, limiter } = deps

  function sessionResponseFor(session: SessionData): z.infer<typeof SessionResponse> {
    if (session.role === 'admin') return { role: 'admin' }

    const portal = portals.get(session.portalId)
    // The portal was deleted out from under an active guest session. Report
    // disabled rather than throwing: the client's existing "disabled" screen
    // is the correct outcome, and a delete-while-logged-in race is the only
    // way to reach this.
    if (portal === null) {
      return {
        role: 'guest',
        portalId: session.portalId,
        portalTitle: '',
        portalTheme: 'classic',
        portalEnabled: false,
      }
    }

    return {
      role: 'guest',
      portalId: portal.id,
      portalTitle: portal.title,
      portalTheme: portal.theme,
      portalEnabled: portal.enabled,
    }
  }

  return {
    // POST /api/login
    async login(c: HonoContext) {
      const ip = getClientIp(c, cfg)

      const rateLimitResult = limiter.check(ip)
      if (!rateLimitResult.allowed) {
        return c.json(
          { error: 'Too many failed login attempts' },
          { status: 429, headers: { 'Retry-After': String(rateLimitResult.retryAfterSec) } },
        )
      }

      const parseResult = LoginRequest.safeParse(await c.req.json())
      if (!parseResult.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const { password } = parseResult.data
      const resolved = classify(password, cfg, portals)

      if (resolved === null) {
        limiter.recordFailure(ip)
        return c.json({ error: 'Invalid credentials' }, 401)
      }

      if (resolved.role === 'guest') {
        const portal = portals.get(resolved.portalId)
        // Cannot be null here in practice — classify() just found this portal
        // by password — but the type is nullable, so this is a defensive exit.
        if (portal === null) {
          limiter.recordFailure(ip)
          return c.json({ error: 'Invalid credentials' }, 401)
        }

        if (!portal.enabled) {
          // Deliberately does NOT call limiter.recordFailure() — the password
          // was correct, and counting it would let a disabled portal lock out
          // a guest who keeps retrying, leaving them locked out after
          // re-enabling.
          return c.json({ error: 'portal_disabled' }, 403)
        }

        limiter.recordSuccess(ip)
        interactions.record({
          portalId: portal.id,
          ts: Date.now(),
          kind: 'login',
          entityId: null,
          label: null,
          action: null,
          ok: true,
        })
      } else {
        limiter.recordSuccess(ip)
      }

      const sessionId = sessions.create(resolved)
      const session = sessions.get(sessionId)
      // Just created it; always present.
      if (session === undefined) throw new Error('Session vanished immediately after creation')

      // httpOnly: prevent XSS
      // SameSite=Lax: prevent CSRF
      // Path=/: session is valid for all routes
      // NO Secure: this is plain HTTP on LAN; setting Secure would cause
      //            browsers to silently drop the cookie, breaking login
      const cookieValue = `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`

      return c.json(SessionResponse.parse(sessionResponseFor(session)), {
        headers: { 'Set-Cookie': cookieValue },
      })
    },

    // POST /api/logout
    async logout(c: HonoContext) {
      const cookie = c.req.header('cookie')
      if (!cookie) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)
      if (match) {
        const sessionId = match[1]
        if (sessionId) {
          sessions.destroy(sessionId)
        }
      }

      const cookieValue = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`

      return c.json({ ok: true }, { headers: { 'Set-Cookie': cookieValue } })
    },

    // GET /api/session
    async session(c: HonoContext) {
      const session = c.var.session
      if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      return c.json(SessionResponse.parse(sessionResponseFor(session)))
    },

    // GET /api/devices
    async devices(c: HonoContext) {
      const session = c.var.session
      if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const portalId = resolvePortalId(c, session)
      if (portalId === null) {
        return c.json({ error: 'Missing portalId' }, 400)
      }

      if (session.role === 'guest') {
        const portal = portals.get(portalId)
        if (portal === null || !portal.enabled) {
          return c.json({ error: 'portal_disabled' }, 403)
        }
      }

      const allowlistRows = allowlist.list(portalId)
      const states = ha.getStates()
      const stale = ha.stale

      const devices = assembleDevices(allowlistRows, states, stale)

      return c.json(DevicesResponse.parse({ devices, stale }))
    },

    // POST /api/devices/:entityId/:action
    async callAction(c: HonoContext) {
      const session = c.var.session
      if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const portalId = resolvePortalId(c, session)
      if (portalId === null) {
        return c.json({ error: 'Missing portalId' }, 400)
      }

      if (session.role === 'guest') {
        const portal = portals.get(portalId)
        if (portal === null || !portal.enabled) {
          return c.json({ error: 'portal_disabled' }, 403)
        }
      }

      const entityId = c.req.param('entityId')
      const action = c.req.param('action')

      if (!entityId || !action) {
        return c.json({ error: 'Missing parameters' }, 400)
      }

      const validation = validateAction(entityId, action, allowlist.asMap(portalId))

      const ts = Date.now()

      if (!validation.ok) {
        audit.record({ portalId, ts, entityId, action, role: session.role, ok: false })

        if (session.role === 'guest') {
          interactions.record({
            portalId,
            ts,
            kind: 'action',
            entityId,
            label: allowlist.list(portalId).find((d) => d.entityId === entityId)?.label ?? null,
            action,
            ok: false,
          })
        }

        // not_allowlisted returns 404 to avoid confirming entity existence
        // All other validation failures return 403
        const status = FAILURE_STATUS[validation.reason]
        return c.json(
          { error: validation.reason === 'not_allowlisted' ? 'Not found' : 'Forbidden' },
          status,
        )
      }

      const result = await ha.callAction(validation.domain, validation.service, entityId)

      audit.record({ portalId, ts, entityId, action, role: session.role, ok: result.ok })

      if (session.role === 'guest') {
        interactions.record({
          portalId,
          ts,
          kind: 'action',
          entityId,
          label: allowlist.list(portalId).find((d) => d.entityId === entityId)?.label ?? null,
          action,
          ok: result.ok,
        })
      }

      if (!result.ok) {
        console.error(`HA action failed for ${entityId}/${action}:`, result.message)
        return c.json({ error: 'Service unavailable' }, 503)
      }

      return c.json({ ok: true })
    },

    // GET /api/health
    // Unauthenticated healthcheck for Docker HEALTHCHECK.
    // Reports process health, not Home Assistant reachability — if HA is
    // unreachable we return 200 with haStale:true rather than failing, because
    // restarting the container does not fix HA connectivity and would drop all
    // guest sessions. The portal can still serve pages and actuate devices over
    // REST even when the WebSocket is down.
    async health(c: HonoContext) {
      return c.json({ ok: true, haStale: ha.stale })
    },
  }
}
