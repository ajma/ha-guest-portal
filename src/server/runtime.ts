import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { parseDomain } from '../shared/devices.js'
import type { Device, Role, SseFrame } from '../shared/api.js'
import { SseFrameSchema } from '../shared/api.js'
import type { Config } from './config.js'
import type { HaClient } from './ha/client.js'
import type { AllowlistStore } from './store/allowlist.js'
import type { AuditLog } from './store/auditlog.js'
import { SESSION_COOKIE, type SessionStore, type LoginRateLimiter } from './http/auth.js'
import type { SseHub } from './http/sse.js'
import { createApp } from './app.js'

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
  server: Server
  close: () => Promise<void>
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

        const devices: Device[] = allowlistRows.map((row) => {
          const state = states.get(row.entityId)
          const domain = parseDomain(row.entityId)

          return {
            entityId: row.entityId,
            label: row.label,
            domain: domain ?? 'unknown',
            allowedActions: row.allowedActions,
            sortOrder: row.sortOrder,
            state: {
              state: state?.state ?? 'unavailable',
              attributes: state?.attributes ?? {},
              stale,
            },
          }
        })

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
    const changedDevices: Device[] = allowlistRows
      .filter((row) => changedStates.has(row.entityId))
      .map((row) => {
        const state = changedStates.get(row.entityId)
        const domain = parseDomain(row.entityId)

        return {
          entityId: row.entityId,
          label: row.label,
          domain: domain ?? 'unknown',
          allowedActions: row.allowedActions,
          sortOrder: row.sortOrder,
          state: {
            state: state?.state ?? 'unavailable',
            attributes: state?.attributes ?? {},
            stale,
          },
        }
      })

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

  // Create HTTP server with SSE interception
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Intercept /api/stream before Hono sees it
    if (url.pathname === '/api/stream' && req.method === 'GET') {
      // Check session using shared helper
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

      const devices: Device[] = allowlistRows.map((row) => {
        const state = states.get(row.entityId)
        const domain = parseDomain(row.entityId)

        return {
          entityId: row.entityId,
          label: row.label,
          domain: domain ?? 'unknown',
          allowedActions: row.allowedActions,
          sortOrder: row.sortOrder,
          state: {
            state: state?.state ?? 'unavailable',
            attributes: state?.attributes ?? {},
            stale,
          },
        }
      })

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
  })

  // Return runtime with close function
  return {
    server,
    close: async () => {
      // Close SSE hub first - ends all streaming connections
      hub.close()

      // Stop HA client
      await ha.stop()

      // Close HTTP server
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}
