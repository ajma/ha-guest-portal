import type { ServerResponse } from 'node:http'
import type { Role, SseFrame } from '../../shared/api.js'

type ClientInfo = { role: Role; portalId: string | null; sessionId: string | null }

export class SseHub {
  private readonly clients = new Map<ServerResponse, ClientInfo>()
  private readonly heartbeatMs: number
  private readonly maxBufferBytes: number
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(opts?: { heartbeatMs?: number; maxBufferBytes?: number }) {
    this.heartbeatMs = opts?.heartbeatMs ?? 25_000
    this.maxBufferBytes = opts?.maxBufferBytes ?? 1_048_576
  }

  /**
   * `sessionId` is null for the ingress listener, whose admin access comes
   * from the Supervisor source check rather than from a session there is any
   * cookie for. Those streams are simply never closed by `closeSession`.
   */
  add(
    res: ServerResponse,
    role: Role,
    portalId: string | null,
    sessionId: string | null = null,
  ): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Flush headers immediately so EventSource fires 'open'
    res.flushHeaders()

    this.clients.set(res, { role, portalId, sessionId })

    if (this.clients.size === 1 && this.heartbeatTimer === null) {
      this.startHeartbeat()
    }

    const remove = () => {
      if (this.clients.has(res)) {
        this.clients.delete(res)
        if (this.clients.size === 0) {
          this.stopHeartbeat()
        }
      }
    }

    res.on('close', remove)
    res.on('error', remove)

    return () => {
      res.off('close', remove)
      res.off('error', remove)
      remove()
      if (!res.writableEnded) {
        res.end()
      }
    }
  }

  private writeFrame(client: ServerResponse, frame: SseFrame): void {
    let data: string
    try {
      data = `data: ${JSON.stringify(frame)}\n\n`
    } catch {
      // Frame not serialisable - drop this send
      return
    }

    try {
      if (client.writableEnded) return

      if (client.writableLength > this.maxBufferBytes) {
        this.clients.delete(client)
        client.end()
        return
      }

      client.write(data)
    } catch {
      this.clients.delete(client)
    }
  }

  broadcast(frame: SseFrame): void {
    for (const client of this.clients.keys()) {
      this.writeFrame(client, frame)
    }
  }

  broadcastToPortal(portalId: string, frame: SseFrame): void {
    for (const [client, info] of this.clients) {
      if (info.portalId === portalId) {
        this.writeFrame(client, frame)
      }
    }
  }

  /**
   * Ends every stream whose client matches, and leaves every other one open.
   * The three public closers differ only in that predicate, so they share this
   * rather than each repeating the delete-end-stop dance.
   */
  private closeMatching(matches: (info: ClientInfo) => boolean): void {
    for (const [client, info] of this.clients) {
      if (!matches(info)) continue

      this.clients.delete(client)

      try {
        if (!client.writableEnded) {
          client.end()
        }
      } catch {
        // Already torn down; nothing to clean up.
      }
    }

    if (this.clients.size === 0) {
      this.stopHeartbeat()
    }
  }

  /**
   * Ends every guest stream bound to this portal, leaving its admins and every
   * other portal's connections untouched. Used by the kill-switch: disabling
   * one portal must drop only that portal's guests.
   */
  closePortalGuests(portalId: string): void {
    this.closeMatching((info) => info.role === 'guest' && info.portalId === portalId)
  }

  /**
   * Ends every stream bound to this portal, admins included. Used when the
   * portal is deleted rather than merely disabled: there is nothing left for
   * an admin stream to watch, and an ingress admin stream holds no session, so
   * `closeSession` can never reach it. Left open, it would sit silent forever.
   */
  closePortalStreams(portalId: string): void {
    this.closeMatching((info) => info.portalId === portalId)
  }

  /**
   * Ends every stream opened by one session. Logging out destroys the session
   * server-side, but the stream it opened was already authenticated and would
   * otherwise keep delivering that portal's state to a browser that believes
   * it has signed off.
   */
  closeSession(sessionId: string): void {
    this.closeMatching((info) => info.sessionId === sessionId)
  }

  send(res: ServerResponse, frame: SseFrame): void {
    this.writeFrame(res, frame)
  }

  get clientCount(): number {
    return this.clients.size
  }

  close(): void {
    for (const client of this.clients.keys()) {
      if (!client.writableEnded) {
        client.end()
      }
    }
    this.clients.clear()
    this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const ping = ': ping\n\n'

      for (const client of this.clients.keys()) {
        try {
          if (client.writableEnded) continue

          if (client.writableLength > this.maxBufferBytes) {
            this.clients.delete(client)
            client.end()
            continue
          }

          client.write(ping)
        } catch {
          this.clients.delete(client)
        }
      }

      if (this.clients.size === 0) {
        this.stopHeartbeat()
      }
    }, this.heartbeatMs)

    // Don't keep process alive if only the heartbeat is running
    this.heartbeatTimer.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
