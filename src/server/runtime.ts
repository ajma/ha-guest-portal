import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import type { SseFrame } from '../shared/api.js'
import { SseFrameSchema } from '../shared/api.js'
import type { Config } from './config.js'
import type { HaClient } from './ha/client.js'
import type { AllowlistStore } from './store/allowlist.js'
import type { AuditLog } from './store/auditlog.js'
import type { SettingsStore } from './store/settings.js'
import type { InteractionStore } from './store/interactions.js'
import type { PortalStore } from './store/portals.js'
import { sessionIdFromCookie, type SessionStore, type SessionData, type LoginRateLimiter } from './http/auth.js'
import type { SseHub } from './http/sse.js'
import { createApp } from './app.js'
import { assembleDevices } from './device-assembly.js'

/**
 * Home Assistant Supervisor address.
 * Hardcoded per HA add-on developer docs: "Only connections from 172.30.32.2 must be allowed."
 * Requests from this address on the ingress port are treated as pre-authenticated admin.
 */
const SUPERVISOR_ADDRESS = '172.30.32.2' as const

/**
 * The pathname of a raw request, without constructing a URL.
 *
 * `new URL(req.url, base)` throws ERR_INVALID_URL on inputs like `//`, which
 * is a protocol-relative URL with an empty host. These handlers run outside
 * Hono and outside any try/catch, so that throw took the process down — an
 * unauthenticated remote kill on the guest-facing port. Only the pathname is
 * ever needed, and it requires no parsing.
 *
 * Matching is now on the raw target (before normalization), so dot-segment
 * variants (`/foo/../api/stream`), backslash, and absolute-form requests
 * (`http://evil.com/api/stream`) deliberately no longer match the intercept.
 * This is a fail-closed tightening.
 */
export function requestPathname(rawUrl: string | undefined): string {
  const raw = rawUrl ?? '/'
  const queryAt = raw.indexOf('?')
  const hashAt = raw.indexOf('#')
  const cuts = [queryAt, hashAt].filter((i) => i >= 0)
  return cuts.length > 0 ? raw.slice(0, Math.min(...cuts)) : raw
}

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

export type Runtime = {
  servers: Server[]
  close: () => Promise<void>
}

/**
 * Check if a request is from the Home Assistant Supervisor.
 * Handles both IPv4 and IPv6-mapped IPv4 addresses.
 *
 * @param remoteAddress - The raw socket remote address
 * @returns true if the request is from the Supervisor
 */
export function isFromSupervisor(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false

  // Handle IPv6-mapped IPv4: ::ffff:172.30.32.2
  if (remoteAddress === SUPERVISOR_ADDRESS) return true
  if (remoteAddress === `::ffff:${SUPERVISOR_ADDRESS}`) return true

  return false
}

// Shared session check used by both Hono middleware and SSE handler
export function checkSession(
  cookie: string | undefined,
  sessions: SessionStore,
): SessionData | null {
  const sessionId = sessionIdFromCookie(cookie)
  if (sessionId === null) return null

  return sessions.get(sessionId) ?? null
}

export function createRuntime(deps: Deps): Runtime {
  const { ha, allowlist, hub, sessions, portals, settings } = deps

  // Every entity any portal still wants. HA is subscribed to exactly this set,
  // so anything that changes which portals or rows exist has to recompute it.
  function watchedUnion(): string[] {
    const union = new Set<string>()
    for (const portal of portals.list()) {
      for (const entityId of allowlist.entityIds(portal.id)) {
        union.add(entityId)
      }
    }
    return [...union]
  }

  // Wire allowlist.onChange → ha.setWatchedEntities (union across ALL portals)
  // → broadcast a fresh snapshot to just the portal that changed.
  allowlist.onChange((portalId, _entityIds) => {
    ha.setWatchedEntities(watchedUnion())
      .then(() => {
        const allowlistRows = allowlist.list(portalId)
        const states = ha.getStates()
        const stale = ha.stale
        const devices = assembleDevices(allowlistRows, states, stale)

        const snapshot: SseFrame = SseFrameSchema.parse({ type: 'snapshot', devices, stale })
        hub.broadcastToPortal(portalId, snapshot)
      })
      .catch((error) => {
        console.error('Failed to update watched entities:', error)
      })
  })

  // Wire ha.onChange → for each portal whose allowlist includes a changed
  // entity, broadcast a patch scoped to that portal. One HA state change can
  // fan out to more than one portal, since an entity may be shared.
  ha.onChange((changedStates) => {
    const stale = ha.stale

    for (const portal of portals.list()) {
      const allowlistRows = allowlist.list(portal.id)
      const affectedRows = allowlistRows.filter((row) => changedStates.has(row.entityId))
      if (affectedRows.length === 0) continue

      const changedDevices = assembleDevices(affectedRows, changedStates, stale)
      const patch: SseFrame = SseFrameSchema.parse({ type: 'patch', devices: changedDevices })
      hub.broadcastToPortal(portal.id, patch)
    }
  })

  // Wire ha.onStaleChange → broadcast to everyone (HA reachability is a
  // deployment-wide fact, not a per-portal one — `broadcast`, not
  // `broadcastToPortal`, is correct here).
  ha.onStaleChange((stale) => {
    const degraded: SseFrame = SseFrameSchema.parse({ type: 'degraded', stale })
    hub.broadcast(degraded)
  })

  // Wire portals.onEnabledChange → broadcast to that portal + drop its guests.
  portals.onEnabledChange((portalId, enabled) => {
    const frame: SseFrame = SseFrameSchema.parse({ type: 'portal', enabled })
    hub.broadcastToPortal(portalId, frame)

    // Broadcast first, then drop: a guest that receives the frame switches to
    // the disabled screen immediately. Closing the stream is the fallback —
    // the client's existing stream-drop recheck hits /api/session and lands on
    // the same screen even if the frame was missed.
    if (!enabled) {
      hub.closePortalGuests(portalId)
    }
  })

  // Wire portals.onDelete → the same teardown as disabling, plus session
  // eviction: a deleted portal's guests have nothing left to reconnect to.
  portals.onDelete((portalId) => {
    const frame: SseFrame = SseFrameSchema.parse({ type: 'portal', enabled: false })
    hub.broadcastToPortal(portalId, frame)

    sessions.destroyPortalSessions(portalId)

    // Admins too, unlike the disable path: the portal is gone, so an admin
    // stream still bound to it would receive nothing for the rest of its life,
    // and an ingress admin stream has no session for `destroyPortalSessions`
    // to evict. The frame above goes out first, so a client that is still
    // listening learns why before the connection drops.
    hub.closePortalStreams(portalId)

    // The portal's allowlist rows went with it by FK cascade, which fires no
    // store listener — so recompute here or HA keeps streaming entities that
    // no portal can show any more.
    ha.setWatchedEntities(watchedUnion()).catch((error) => {
      console.error('Failed to update watched entities after portal delete:', error)
    })

    // An admin's last-selected pointer outlives the portal it names, and the
    // UI would open on a portal that no longer exists.
    if (settings.getLastSelectedPortalId() === portalId) {
      settings.clearLastSelectedPortalId()
    }
  })

  // Create Hono app
  const app = createApp(deps)

  // Get Hono's request listener
  const honoListener = getRequestListener(app.fetch)

  // Direct port request handler
  function handleDirectRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) {
    try {
      // Normalize single trailing slash
      let pathname = requestPathname(req.url)
      if (pathname.endsWith('/') && pathname.length > 1) {
        pathname = pathname.slice(0, -1)
      }

      // Intercept /api/stream before Hono sees it
      if (pathname === '/api/stream' && req.method === 'GET') {
        const session = checkSession(req.headers.cookie, sessions)
        if (!session) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }

        const url = new URL(req.url ?? '/', 'http://localhost')
        const portalId =
          session.role === 'guest' ? session.portalId : url.searchParams.get('portalId')

        if (portalId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing portalId' }))
          return
        }

        // Same contract as the Hono routes, which this intercept bypasses: a
        // guest hears only `portal_disabled`, an admin hears that the portal
        // they named is not there rather than getting an open stream and an
        // empty snapshot they cannot tell from a real, empty portal.
        const portal = portals.get(portalId)
        if (session.role === 'guest') {
          if (portal === null || !portal.enabled) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'portal_disabled' }))
            return
          }
        } else if (portal === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }

        hub.add(res, session.role, portalId, sessionIdFromCookie(req.headers.cookie))

        // Send initial snapshot immediately
        const allowlistRows = allowlist.list(portalId)
        const states = ha.getStates()
        const stale = ha.stale

        const devices = assembleDevices(allowlistRows, states, stale)

        const snapshot: SseFrame = SseFrameSchema.parse({
          type: 'snapshot',
          devices,
          stale,
        })

        hub.send(res, snapshot)
        // Response now owned by hub
        return
      }

      // All other routes go through Hono
      honoListener(req, res)
    } catch (error) {
      console.error('Uncaught error in handleDirectRequest:', error)
      // Only send 500 if headers not already sent
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
      } else {
        // Headers already sent, destroy the socket
        res.destroy()
      }
    }
  }

  // Ingress port request handler - enforces Supervisor source check first
  function handleIngressRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) {
    const remoteAddress = req.socket.remoteAddress

    // Ingress listener security gate: ONLY Supervisor connections allowed
    // This must be the first check - before static serving, before SSE, before Hono
    // Keep this outside try/catch - it must not become reachable through an error path
    if (!isFromSupervisor(remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden' }))
      return
    }

    try {
      // Valid Supervisor request - continue to handler logic
      // Normalize single trailing slash
      let pathname = requestPathname(req.url)
      if (pathname.endsWith('/') && pathname.length > 1) {
        pathname = pathname.slice(0, -1)
      }

      // Intercept /api/stream before Hono sees it
      if (pathname === '/api/stream' && req.method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const portalId = url.searchParams.get('portalId')

        if (portalId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing portalId' }))
          return
        }

        if (portals.get(portalId) === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }

        // Supervisor-authenticated request - grant admin access without session
        hub.add(res, 'admin', portalId)

        // Send initial snapshot immediately
        const allowlistRows = allowlist.list(portalId)
        const states = ha.getStates()
        const stale = ha.stale

        const devices = assembleDevices(allowlistRows, states, stale)

        const snapshot: SseFrame = SseFrameSchema.parse({
          type: 'snapshot',
          devices,
          stale,
        })

        hub.send(res, snapshot)
        return
      }

      // All other routes go through Hono (which will grant admin via middleware)
      honoListener(req, res)
    } catch (error) {
      console.error('Uncaught error in handleIngressRequest:', error)
      // Only send 500 if headers not already sent
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
      } else {
        // Headers already sent, destroy the socket
        res.destroy()
      }
    }
  }

  // Create HTTP server(s)
  const directServer = createServer(handleDirectRequest)
  const servers: Server[] = [directServer]

  // Create ingress server if configured
  if (deps.cfg.ingressPort) {
    const ingressServer = createServer(handleIngressRequest)
    servers.push(ingressServer)
  }

  // Return runtime with close function
  let closing = false
  return {
    servers,
    close: async () => {
      // Make close() idempotent - return early if already closing
      if (closing) return
      closing = true

      // Close SSE hub first - ends all streaming connections
      hub.close()

      // Stop HA client
      await ha.stop()

      // Close all HTTP servers (ignore ERR_SERVER_NOT_RUNNING on second call)
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close((err) => {
                // Ignore ERR_SERVER_NOT_RUNNING - server already closed
                if (err && 'code' in err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
                  console.error('Error closing server:', err)
                }
                resolve()
              })
            }),
        ),
      )
    },
  }
}
