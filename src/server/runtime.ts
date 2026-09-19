import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import type { Role, SseFrame } from '../shared/api.js'
import { SseFrameSchema } from '../shared/api.js'
import type { Config } from './config.js'
import type { HaClient } from './ha/client.js'
import type { AllowlistStore } from './store/allowlist.js'
import type { AuditLog } from './store/auditlog.js'
import { SESSION_COOKIE, type SessionStore, type LoginRateLimiter } from './http/auth.js'
import type { SseHub } from './http/sse.js'
import { createApp } from './app.js'
import { assembleDevices } from './device-assembly.js'

/**
 * Home Assistant Supervisor address.
 * Hardcoded per HA add-on developer docs: "Only connections from 172.30.32.2 must be allowed."
 * Requests from this address on the ingress port are treated as pre-authenticated admin.
 */
const SUPERVISOR_ADDRESS = '172.30.32.2' as const

export type Deps = {
  cfg: Config
  ha: HaClient
  allowlist: AllowlistStore
  audit: AuditLog
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
): Role | null {
  if (!cookie) return null

  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)
  if (!match) return null

  const sessionId = match[1]
  if (!sessionId) return null

  return sessions.get(sessionId) ?? null
}

export function createRuntime(deps: Deps): Runtime {
  const { ha, allowlist, hub, sessions } = deps

  // Wire allowlist.onChange → ha.setWatchedEntities → broadcast snapshot
  allowlist.onChange((entityIds) => {
    ha.setWatchedEntities(entityIds)
      .then(() => {
        // After resubscribing, send a fresh snapshot to all clients
        const allowlistRows = allowlist.list()
        const states = ha.getStates()
        const stale = ha.stale

        const devices = assembleDevices(allowlistRows, states, stale)

        const snapshot: SseFrame = SseFrameSchema.parse({
          type: 'snapshot',
          devices,
          stale,
        })

        hub.broadcast(snapshot)
      })
      .catch((error) => {
        console.error('Failed to update watched entities:', error)
      })
  })

  // Wire ha.onChange → hub.broadcast({type:'patch'})
  ha.onChange((changedStates) => {
    const allowlistRows = allowlist.list()
    const stale = ha.stale

    // Only include changed devices that are in the allowlist
    const allowlistRowsFiltered = allowlistRows.filter((row) =>
      changedStates.has(row.entityId),
    )
    const changedDevices = assembleDevices(allowlistRowsFiltered, changedStates, stale)

    if (changedDevices.length > 0) {
      const patch: SseFrame = SseFrameSchema.parse({
        type: 'patch',
        devices: changedDevices,
      })

      hub.broadcast(patch)
    }
  })

  // Wire ha.onStaleChange → hub.broadcast({type:'degraded'})
  ha.onStaleChange((stale) => {
    const degraded: SseFrame = SseFrameSchema.parse({
      type: 'degraded',
      stale,
    })

    hub.broadcast(degraded)
  })

  // Create Hono app
  const app = createApp(deps)

  // Get Hono's request listener
  const honoListener = getRequestListener(app.fetch)

  // Direct port request handler
  function handleDirectRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Normalize single trailing slash
    let pathname = url.pathname
    if (pathname.endsWith('/') && pathname.length > 1) {
      pathname = pathname.slice(0, -1)
    }

    // Intercept /api/stream before Hono sees it
    if (pathname === '/api/stream' && req.method === 'GET') {
      // Check session
      const role = checkSession(req.headers.cookie, sessions)
      if (!role) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      // Session valid - handle SSE
      hub.add(res)

      // Send initial snapshot immediately
      const allowlistRows = allowlist.list()
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
  }

  // Ingress port request handler - enforces Supervisor source check first
  function handleIngressRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const remoteAddress = req.socket.remoteAddress

    // Ingress listener security gate: ONLY Supervisor connections allowed
    // This must be the first check - before static serving, before SSE, before Hono
    if (!isFromSupervisor(remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden' }))
      return
    }

    // Valid Supervisor request - continue to handler logic
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Normalize single trailing slash
    let pathname = url.pathname
    if (pathname.endsWith('/') && pathname.length > 1) {
      pathname = pathname.slice(0, -1)
    }

    // Intercept /api/stream before Hono sees it
    if (pathname === '/api/stream' && req.method === 'GET') {
      // Supervisor-authenticated request - grant admin access without session
      hub.add(res)

      // Send initial snapshot immediately
      const allowlistRows = allowlist.list()
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
