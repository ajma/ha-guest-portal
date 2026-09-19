import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { validateAction } from '../../shared/devices.js'
import { DevicesResponse, LoginRequest, SessionResponse } from '../../shared/api.js'
import type { HaClient } from '../ha/client.js'
import type { AllowlistStore } from '../store/allowlist.js'
import type { AuditLog } from '../store/auditlog.js'
import type { SettingsStore } from '../store/settings.js'
import type { InteractionStore } from '../store/interactions.js'
import type { Config } from '../config.js'
import {
  SESSION_COOKIE,
  type SessionStore,
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
  sessions: SessionStore
  limiter: LoginRateLimiter
  hub: SseHub
}

type HonoContext = Context<Env>

// Helper to extract client IP from request
function getClientIp(c: HonoContext, cfg: Config): string {
  const rawIp = c.env.incoming.socket.remoteAddress ?? '0.0.0.0'
  const forwardedFor = c.req.header('x-forwarded-for')
  const trustProxy = cfg.trustProxy
  return clientIp(rawIp, forwardedFor, trustProxy)
}

const FAILURE_STATUS = {
  not_allowlisted: 404,
  unsupported_domain: 403,
  action_not_valid_for_domain: 403,
  action_not_permitted: 403,
} as const satisfies Record<string, ContentfulStatusCode>

export function createRoutes(deps: Deps) {
  const { cfg, ha, allowlist, audit, settings, sessions, limiter } = deps

  return {
    // POST /api/login
    async login(c: HonoContext) {
      const ip = getClientIp(c, cfg)

      // Check rate limit
      const rateLimitResult = limiter.check(ip)
      if (!rateLimitResult.allowed) {
        return c.json(
          { error: 'Too many failed login attempts' },
          {
            status: 429,
            headers: {
              'Retry-After': String(rateLimitResult.retryAfterSec),
            },
          },
        )
      }

      // Parse request body
      const parseResult = LoginRequest.safeParse(await c.req.json())
      if (!parseResult.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const { password } = parseResult.data

      // Classify password
      const role = classify(password, cfg)

      if (role === null) {
        // Record failure
        limiter.recordFailure(ip)
        return c.json({ error: 'Invalid credentials' }, 401)
      }

      // Record success
      limiter.recordSuccess(ip)

      // Create session
      const sessionId = sessions.create(role)

      // Set cookie
      // httpOnly: prevent XSS
      // SameSite=Lax: prevent CSRF
      // Path=/: session is valid for all routes
      // NO Secure: this is plain HTTP on LAN; setting Secure would cause
      //            browsers to silently drop the cookie, breaking login
      const cookieValue = `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`

      return c.json(SessionResponse.parse({ role, portalEnabled: settings.getPortalEnabled() }), {
        headers: {
          'Set-Cookie': cookieValue,
        },
      })
    },

    // POST /api/logout
    async logout(c: HonoContext) {
      const cookie = c.req.header('cookie')
      if (!cookie) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      // Parse session cookie
      const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)
      if (match) {
        const sessionId = match[1]
        if (sessionId) {
          sessions.destroy(sessionId)
        }
      }

      // Clear cookie
      const cookieValue = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`

      return c.json(
        { ok: true },
        {
          headers: {
            'Set-Cookie': cookieValue,
          },
        },
      )
    },

    // GET /api/session
    async session(c: HonoContext) {
      const role = c.var.role
      if (!role) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      return c.json(SessionResponse.parse({ role, portalEnabled: settings.getPortalEnabled() }))
    },

    // GET /api/devices
    async devices(c: HonoContext) {
      const role = c.var.role
      if (!role) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const allowlistRows = allowlist.list()
      const states = ha.getStates()
      const stale = ha.stale

      const devices = assembleDevices(allowlistRows, states, stale)

      return c.json(DevicesResponse.parse({ devices, stale }))
    },

    // POST /api/devices/:entityId/:action
    async callAction(c: HonoContext) {
      const role = c.var.role
      if (!role) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const entityId = c.req.param('entityId')
      const action = c.req.param('action')

      if (!entityId || !action) {
        return c.json({ error: 'Missing parameters' }, 400)
      }

      // Validate action
      const validation = validateAction(entityId, action, allowlist.asMap())

      const ts = Date.now()

      if (!validation.ok) {
        // Record audit log for failed attempt
        audit.record({
          ts,
          entityId,
          action,
          role,
          ok: false,
        })

        // not_allowlisted returns 404 to avoid confirming entity existence
        // All other validation failures return 403
        const status = FAILURE_STATUS[validation.reason]
        return c.json(
          { error: validation.reason === 'not_allowlisted' ? 'Not found' : 'Forbidden' },
          status,
        )
      }

      // Call Home Assistant
      const result = await ha.callAction(validation.domain, validation.service, entityId)

      // Record audit log
      audit.record({
        ts,
        entityId,
        action,
        role,
        ok: result.ok,
      })

      if (!result.ok) {
        // Log the detailed error server-side
        console.error(`HA action failed for ${entityId}/${action}:`, result.message)
        // Return a generic error to the client
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
