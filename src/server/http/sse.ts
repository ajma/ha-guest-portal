import type { ServerResponse } from 'node:http'
import type { Role, SseFrame } from '../../shared/api.js'

type ClientInfo = { role: Role; portalId: string | null }

export class SseHub {
  private readonly clients = new Map<ServerResponse, ClientInfo>()
  private readonly heartbeatMs: number
  private readonly maxBufferBytes: number
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(opts?: { heartbeatMs?: number; maxBufferBytes?: number }) {
    this.heartbeatMs = opts?.heartbeatMs ?? 25_000
    this.maxBufferBytes = opts?.maxBufferBytes ?? 1_048_576
  }

  add(res: ServerResponse, role: Role, portalId: string | null): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Flush headers immediately so EventSource fires 'open'
    res.flushHeaders()

    this.clients.set(res, { role, portalId })

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
   * Ends every guest stream bound to this portal, leaving its admins and every
   * other portal's connections untouched. Used by the kill-switch: disabling
   * one portal must drop only that portal's guests.
   */
  closePortalGuests(portalId: string): void {
    for (const [client, info] of this.clients) {
      if (info.role !== 'guest' || info.portalId !== portalId) continue

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
