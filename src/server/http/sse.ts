import type { ServerResponse } from 'node:http'
import type { SseFrame } from '../../shared/api.js'

export class SseHub {
  private readonly clients = new Set<ServerResponse>()
  private readonly heartbeatMs: number
  private readonly maxBufferBytes: number
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(opts?: { heartbeatMs?: number; maxBufferBytes?: number }) {
    this.heartbeatMs = opts?.heartbeatMs ?? 25_000
    this.maxBufferBytes = opts?.maxBufferBytes ?? 1_048_576 // 1 MB default
  }

  add(res: ServerResponse): () => void {
    // Write SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Flush headers immediately so EventSource fires 'open'
    res.flushHeaders()

    // Add to clients
    this.clients.add(res)

    // Start heartbeat if this is the first client
    if (this.clients.size === 1 && this.heartbeatTimer === null) {
      this.startHeartbeat()
    }

    // Auto-remove on close or error
    const remove = () => {
      if (this.clients.has(res)) {
        this.clients.delete(res)

        // Stop heartbeat if no clients remain
        if (this.clients.size === 0) {
          this.stopHeartbeat()
        }
      }
    }

    res.on('close', remove)
    res.on('error', remove)

    // Return idempotent remover
    return () => {
      // Detach listeners
      res.off('close', remove)
      res.off('error', remove)

      remove()
      // Safe to call end on already-closed response
      if (!res.writableEnded) {
        res.end()
      }
    }
  }

  broadcast(frame: SseFrame): void {
    let data: string
    try {
      data = `data: ${JSON.stringify(frame)}\n\n`
    } catch (_error) {
      // Frame not serialisable - drop this broadcast
      return
    }

    for (const client of this.clients) {
      try {
        if (client.writableEnded) {
          continue
        }

        // Evict client if buffer exceeds cap
        if (client.writableLength > this.maxBufferBytes) {
          this.clients.delete(client)
          client.end()
          continue
        }

        client.write(data)
      } catch (_error) {
        // Remove dead client silently
        this.clients.delete(client)
      }
    }
  }

  send(res: ServerResponse, frame: SseFrame): void {
    let data: string
    try {
      data = `data: ${JSON.stringify(frame)}\n\n`
    } catch (_error) {
      // Frame not serialisable - drop this send
      return
    }

    try {
      if (!res.writableEnded) {
        res.write(data)
      }
    } catch {
      // Ignore write errors on individual send
    }
  }

  get clientCount(): number {
    return this.clients.size
  }

  close(): void {
    // End all responses
    for (const client of this.clients) {
      if (!client.writableEnded) {
        client.end()
      }
    }

    // Clear clients
    this.clients.clear()

    // Stop heartbeat
    this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const ping = ': ping\n\n'

      for (const client of this.clients) {
        try {
          if (client.writableEnded) {
            continue
          }

          // Evict client if buffer exceeds cap
          if (client.writableLength > this.maxBufferBytes) {
            this.clients.delete(client)
            client.end()
            continue
          }

          client.write(ping)
        } catch (_error) {
          // Remove dead client silently
          this.clients.delete(client)
        }
      }

      // Stop heartbeat if all clients died
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
