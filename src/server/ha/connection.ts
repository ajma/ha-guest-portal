import WebSocket from 'ws'
import type { z } from 'zod'
import {
  InboundFrame,
  type EntityEvent,
} from './schemas.js'

export type ConnectionStatus = 'connecting' | 'ready' | 'disconnected'

export type HaConnectionOptions = {
  baseUrl: string
  token: string
  wsUrl?: string
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  pingIntervalMs?: number
}

type PendingRequest = {
  resolve: (raw: unknown) => void
  reject: (error: Error) => void
}

type Subscription = {
  id: number
  onEvent: (event: EntityEvent) => void
  unsubscribe: () => Promise<void>
}

export class ConnectionDroppedError extends Error {
  constructor() {
    super('Connection dropped')
    this.name = 'ConnectionDroppedError'
  }
}

export class HaConnection {
  private opts: Required<HaConnectionOptions>
  private ws: WebSocket | null = null
  private status_: ConnectionStatus = 'disconnected'
  private messageId = 0
  private pendingRequests = new Map<number, PendingRequest>()
  private subscriptions = new Map<number, Subscription>()
  private statusListeners: Array<(status: ConnectionStatus) => void> = []
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private stopped = false
  private authFailed = false
  private lastPongReceived = Date.now()
  private wsUrl: string

  constructor(opts: HaConnectionOptions) {
    this.opts = {
      baseUrl: opts.baseUrl,
      token: opts.token,
      wsUrl: opts.wsUrl ?? '',
      reconnectBaseMs: opts.reconnectBaseMs ?? 500,
      reconnectMaxMs: opts.reconnectMaxMs ?? 30_000,
      pingIntervalMs: opts.pingIntervalMs ?? 20_000,
    }

    // Derive WebSocket URL if not explicitly provided
    if (opts.wsUrl) {
      this.wsUrl = opts.wsUrl
    } else {
      const url = new URL(opts.baseUrl)
      const wsScheme = url.protocol === 'https:' ? 'wss:' : 'ws:'
      this.wsUrl = `${wsScheme}//${url.host}/api/websocket`
    }
  }

  get status(): ConnectionStatus {
    return this.status_
  }

  start(): void {
    if (this.stopped) {
      return
    }
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearReconnectTimer()
    this.clearPingTimer()

    // Reject all pending requests
    const requests = Array.from(this.pendingRequests.values())
    this.pendingRequests.clear()
    for (const req of requests) {
      req.reject(new ConnectionDroppedError())
    }

    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
      this.ws = null
    }

    this.setStatus('disconnected')
  }

  async send<T>(payload: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    if (this.status_ !== 'ready') {
      throw new Error('Connection not ready')
    }

    const id = ++this.messageId
    const message = { ...payload, id }

    const raw = await new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      this.ws?.send(JSON.stringify(message))
    })

    return schema.parse(raw)
  }

  async subscribe(
    payload: Record<string, unknown>,
    onEvent: (event: EntityEvent) => void
  ): Promise<{ unsubscribe: () => Promise<void> }> {
    if (this.status_ !== 'ready') {
      throw new Error('Connection not ready')
    }

    const id = ++this.messageId
    const message = { ...payload, id }

    return new Promise<{ unsubscribe: () => Promise<void> }>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: () => {
          // Subscription confirmed
          const subscription: Subscription = {
            id,
            onEvent,
            unsubscribe: async () => {
              this.subscriptions.delete(id)
            },
          }
          this.subscriptions.set(id, subscription)
          resolve({ unsubscribe: subscription.unsubscribe })
        },
        reject,
      })

      this.ws?.send(JSON.stringify(message))
    })
  }

  onStatus(fn: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.push(fn)
    return () => {
      const index = this.statusListeners.indexOf(fn)
      if (index !== -1) {
        this.statusListeners.splice(index, 1)
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status_ !== status) {
      this.status_ = status
      for (const listener of this.statusListeners) {
        listener(status)
      }
    }
  }

  private connect(): void {
    if (this.stopped || this.authFailed) {
      return
    }

    this.clearReconnectTimer()
    this.setStatus('connecting')

    // Reset message ID for new connection
    this.messageId = 0

    const ws = new WebSocket(this.wsUrl)
    this.ws = ws

    ws.on('open', () => {
      // Wait for auth_required
    })

    ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data)
    })

    ws.on('close', () => {
      this.handleDisconnect()
    })

    ws.on('error', (err) => {
      // Connection errors will trigger close event
      console.error('WebSocket error:', err.message)
    })
  }

  private handleMessage(data: WebSocket.RawData): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      return
    }

    const parseResult = InboundFrame.safeParse(parsed)
    if (!parseResult.success) {
      return
    }

    const frame = parseResult.data

    switch (frame.type) {
      case 'auth_required':
        this.sendAuth()
        break

      case 'auth_ok':
        this.reconnectAttempts = 0
        this.setStatus('ready')
        this.startPingTimer()
        break

      case 'auth_invalid':
        // Fatal - do not reconnect
        this.authFailed = true
        this.handleDisconnect()
        break

      case 'result': {
        const pending = this.pendingRequests.get(frame.id)
        if (!pending) {
          return
        }
        this.pendingRequests.delete(frame.id)

        if (!frame.success) {
          const errorMsg = frame.error?.message ?? 'Unknown error'
          pending.reject(new Error(errorMsg))
          return
        }

        pending.resolve(frame.result)
        break
      }

      case 'pong':
        this.lastPongReceived = Date.now()
        break

      case 'event': {
        const subscription = this.subscriptions.get(frame.id)
        if (subscription) {
          subscription.onEvent(frame.event)
        }
        break
      }
    }
  }

  private sendAuth(): void {
    const authMessage = {
      type: 'auth',
      access_token: this.opts.token,
    }
    this.ws?.send(JSON.stringify(authMessage))
  }

  private handleDisconnect(): void {
    this.clearPingTimer()

    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws = null
    }

    // Reject all pending requests
    const requests = Array.from(this.pendingRequests.values())
    this.pendingRequests.clear()
    for (const req of requests) {
      req.reject(new ConnectionDroppedError())
    }

    this.setStatus('disconnected')

    // Reconnect unless stopped or auth failed
    if (!this.stopped && !this.authFailed) {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()

    // Exponential backoff with jitter
    const baseDelay = this.opts.reconnectBaseMs * 2 ** this.reconnectAttempts
    const cappedDelay = Math.min(baseDelay, this.opts.reconnectMaxMs)
    const jitter = Math.random() * 0.3 * cappedDelay // ±30% jitter
    const delay = cappedDelay + jitter

    this.reconnectAttempts++

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }

  private startPingTimer(): void {
    this.clearPingTimer()
    this.lastPongReceived = Date.now()

    this.pingTimer = setInterval(() => {
      // Check if we missed a pong
      const timeSinceLastPong = Date.now() - this.lastPongReceived
      if (timeSinceLastPong > this.opts.pingIntervalMs * 2) {
        // Missed pong - force reconnect
        this.handleDisconnect()
        return
      }

      // Send ping
      const id = ++this.messageId
      const pingMessage = { type: 'ping', id }
      this.ws?.send(JSON.stringify(pingMessage))
    }, this.opts.pingIntervalMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}
