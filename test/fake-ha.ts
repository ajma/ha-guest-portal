import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import {
  AuthRequired,
  AuthOk,
  AuthInvalid,
  ResultFrame,
  PongFrame,
  EventFrame,
  type CompressedState,
  type EntityEvent,
} from '../src/server/ha/schemas.ts'

export type FakeEntity = {
  entityId: string
  name?: string
  areaId?: string | null
  deviceId?: string | null
  state: string
  attributes?: Record<string, unknown>
  disabledBy?: string | null
  hiddenBy?: string | null
}

export type ServiceCall = {
  domain: string
  service: string
  body: unknown
  authorization: string | undefined
}

type EntityState = {
  state: string
  attributes: Record<string, unknown>
  lastChanged: number
  lastUpdated: number
}

type Subscription = {
  id: number
  entityIds: string[] | null
}

export class FakeHomeAssistant {
  private wss: WebSocketServer | null = null
  private httpServer: Server | null = null
  private entities = new Map<string, EntityState>()
  private contextCounter = 0
  private lastTimestamp = 0
  private areas: Array<{ areaId: string; name: string }> = []
  private devices: Array<{ id: string; name: string; areaId: string | null }> = []
  private entityMeta = new Map<
    string,
    {
      name?: string
      areaId?: string | null
      deviceId?: string | null
      disabledBy?: string | null
      hiddenBy?: string | null
    }
  >()
  private connections = new Set<WebSocket>()
  private authenticatedConnections = new Set<WebSocket>()
  private subscriptions = new Map<WebSocket, Subscription>()
  private latestSubscription: Subscription | null = null
  private _serviceCalls: ServiceCall[] = []
  private rejectNextAuth = false
  private nextServiceCallStatus: number | null = null

  readonly baseUrl!: string
  readonly token: string

  private constructor(token: string) {
    this.token = token
  }

  private getTimestamp(): number {
    const now = Date.now() / 1000
    // Ensure timestamps always increase by at least 0.001 seconds
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 0.001)
    return this.lastTimestamp
  }

  static async start(opts?: { token?: string }): Promise<FakeHomeAssistant> {
    const token = opts?.token ?? 'fake-token'
    const httpServer = createServer()
    const wss = new WebSocketServer({ noServer: true })

    const instance = new FakeHomeAssistant(token)
    instance.httpServer = httpServer
    instance.wss = wss

    httpServer.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        instance.handleConnection(ws)
      })
    })

    httpServer.on('request', (req, res) => {
      instance.handleHttpRequest(req, res)
    })

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address()
        if (addr && typeof addr === 'object') {
          ;(instance as { baseUrl: string }).baseUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })

    return instance
  }

  private handleHttpRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (req.method === 'POST' && url.pathname.startsWith('/api/services/')) {
      const pathParts = url.pathname.split('/')
      const domain = pathParts[3]
      const service = pathParts[4]

      if (!domain || !service) {
        res.writeHead(404)
        res.end()
        return
      }

      const auth = req.headers.authorization

      if (auth !== `Bearer ${this.token}`) {
        res.writeHead(401)
        res.end()
        return
      }

      if (this.nextServiceCallStatus !== null) {
        const status = this.nextServiceCallStatus
        this.nextServiceCallStatus = null
        res.writeHead(status)
        res.end()
        return
      }

      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        const parsedBody = body ? JSON.parse(body) : {}
        this._serviceCalls.push({
          domain,
          service,
          body: parsedBody,
          authorization: auth,
        })

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('[]')
      })
      return
    }

    res.writeHead(404)
    res.end()
  }

  private handleConnection(ws: WebSocket): void {
    this.connections.add(ws)

    ws.on('message', (data) => {
      this.handleMessage(ws, data)
    })

    ws.on('close', () => {
      this.connections.delete(ws)
      this.authenticatedConnections.delete(ws)
      this.subscriptions.delete(ws)
    })

    // Send auth_required immediately (WebSocket is already open at this point)
    this.sendValidated(ws, {
      type: 'auth_required',
      ha_version: '2026.9.0',
    }, AuthRequired)
  }

  private handleMessage(ws: WebSocket, data: WebSocket.RawData): void {
    const msg = JSON.parse(data.toString()) as { type: string; id?: number; access_token?: string; entity_ids?: string[] }

    if (msg.type === 'auth') {
      if (this.rejectNextAuth || msg.access_token !== this.token) {
        this.sendValidated(ws, {
          type: 'auth_invalid',
          message: 'Invalid access token',
        }, AuthInvalid)
        // Close socket after auth_invalid
        setTimeout(() => ws.close(), 10)
        return
      }

      this.authenticatedConnections.add(ws)
      this.sendValidated(ws, {
        type: 'auth_ok',
        ha_version: '2026.9.0',
      }, AuthOk)
      return
    }

    // Commands before auth are not honored
    if (!this.authenticatedConnections.has(ws)) {
      return
    }

    const id = msg.id
    if (id === undefined) {
      return
    }

    switch (msg.type) {
      case 'ping':
        this.sendValidated(ws, { type: 'pong', id }, PongFrame)
        break

      case 'get_config':
        this.sendValidated(ws, {
          type: 'result',
          id,
          success: true,
          result: {
            version: '2026.9.0',
            location_name: 'Home',
            latitude: 0,
            longitude: 0,
            elevation: 0,
            unit_system: {
              length: 'km',
              mass: 'kg',
              volume: 'L',
              temperature: 'C',
            },
            time_zone: 'UTC',
          },
        }, ResultFrame)
        break

      case 'config/area_registry/list':
        this.sendValidated(ws, {
          type: 'result',
          id,
          success: true,
          result: this.areas.map((a) => ({ area_id: a.areaId, name: a.name })),
        }, ResultFrame)
        break

      case 'config/device_registry/list':
        this.sendValidated(ws, {
          type: 'result',
          id,
          success: true,
          result: this.devices.map((d) => ({
            id: d.id,
            name: d.name,
            name_by_user: null,
            area_id: d.areaId,
          })),
        }, ResultFrame)
        break

      case 'config/entity_registry/list':
        this.sendValidated(ws, {
          type: 'result',
          id,
          success: true,
          result: Array.from(this.entities.keys()).map((entityId) => {
            const meta = this.entityMeta.get(entityId)
            return {
              entity_id: entityId,
              name: meta?.name ?? null,
              original_name: meta?.name ?? null,
              area_id: meta?.areaId ?? null,
              device_id: meta?.deviceId ?? null,
              disabled_by: meta?.disabledBy ?? null,
              hidden_by: meta?.hiddenBy ?? null,
              entity_category: null,
            }
          }),
        }, ResultFrame)
        break

      case 'subscribe_entities': {
        const entityIds = msg.entity_ids ?? null
        const subscription: Subscription = { id, entityIds }
        this.subscriptions.set(ws, subscription)
        this.latestSubscription = subscription

        this.sendValidated(ws, {
          type: 'result',
          id,
          success: true,
        }, ResultFrame)

        // Send snapshot immediately
        const snapshot = this.buildSnapshot(entityIds)
        this.sendValidated(ws, {
          type: 'event',
          id,
          event: snapshot,
        }, EventFrame)
        break
      }

      default:
        this.sendValidated(ws, {
          type: 'result',
          id,
          success: false,
          error: {
            code: 'unknown_command',
            message: `Unknown command: ${msg.type}`,
          },
        }, ResultFrame)
        break
    }
  }

  private sendValidated(ws: WebSocket, frame: unknown, schema: { parse: (val: unknown) => unknown }): void {
    // Validate the frame against the schema before sending
    try {
      schema.parse(frame)
    } catch (err) {
      throw new Error(`Frame validation failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    ws.send(JSON.stringify(frame))
  }

  private buildSnapshot(entityIds: string[] | null): EntityEvent {
    const added: Record<string, CompressedState> = {}

    for (const [entityId, state] of this.entities) {
      if (entityIds && !entityIds.includes(entityId)) {
        continue
      }

      const contextId = `context-${this.contextCounter++}`
      const compressed: CompressedState = {
        s: state.state,
        a: state.attributes,
        c: contextId,
        lc: state.lastChanged,
      }

      // Only include lu when it differs from lc
      if (state.lastUpdated !== state.lastChanged) {
        compressed.lu = state.lastUpdated
      }

      added[entityId] = compressed
    }

    return { a: added }
  }

  private buildDiff(_entityId: string, oldState: EntityState, newState: EntityState): CompressedState {
    const plus: CompressedState = {}
    const minus: { a?: string[] } = {}

    // Check if state changed
    if (oldState.state !== newState.state) {
      plus.s = newState.state
    }

    // Send lc XOR lu, never both
    // When last_changed moved (state changed), send lc only
    // When only last_updated moved (attribute change), send lu only
    if (oldState.lastChanged !== newState.lastChanged) {
      plus.lc = newState.lastChanged
    } else if (oldState.lastUpdated !== newState.lastUpdated) {
      plus.lu = newState.lastUpdated
    }

    // Check for attribute changes
    const oldAttrs = oldState.attributes
    const newAttrs = newState.attributes
    const removedAttrs: string[] = []

    // Find removed attributes
    for (const key of Object.keys(oldAttrs)) {
      if (!(key in newAttrs)) {
        removedAttrs.push(key)
      }
    }

    // Find added or changed attributes
    const changedAttrs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(newAttrs)) {
      if (!(key in oldAttrs) || JSON.stringify(oldAttrs[key]) !== JSON.stringify(value)) {
        changedAttrs[key] = value
      }
    }

    if (Object.keys(changedAttrs).length > 0) {
      plus.a = changedAttrs
    }

    if (removedAttrs.length > 0) {
      minus.a = removedAttrs
    }

    return plus
  }

  seed(
    entities: FakeEntity[],
    areas: Array<{ areaId: string; name: string }>,
    devices?: Array<{ id: string; name: string; areaId: string | null }>
  ): void {
    this.entities.clear()
    this.entityMeta.clear()
    this.areas = areas
    this.devices = devices ?? []

    const now = this.getTimestamp()
    for (const entity of entities) {
      this.entities.set(entity.entityId, {
        state: entity.state,
        attributes: entity.attributes ?? {},
        lastChanged: now,
        lastUpdated: now,
      })

      const meta: {
        name?: string
        areaId?: string | null
        deviceId?: string | null
        disabledBy?: string | null
        hiddenBy?: string | null
      } = {}
      if (entity.name !== undefined) meta.name = entity.name
      if (entity.areaId !== undefined) meta.areaId = entity.areaId
      if (entity.deviceId !== undefined) meta.deviceId = entity.deviceId
      if (entity.disabledBy !== undefined) meta.disabledBy = entity.disabledBy
      if (entity.hiddenBy !== undefined) meta.hiddenBy = entity.hiddenBy
      this.entityMeta.set(entity.entityId, meta)
    }
  }

  setState(entityId: string, state: string, attributes?: Record<string, unknown>): void {
    const oldState = this.entities.get(entityId)
    if (!oldState) {
      // Unknown entity is a no-op
      return
    }

    const now = this.getTimestamp()
    const stateChanged = oldState.state !== state
    const newState: EntityState = {
      state,
      attributes: attributes ?? oldState.attributes,
      lastChanged: stateChanged ? now : oldState.lastChanged,
      lastUpdated: now,
    }

    this.entities.set(entityId, newState)

    // Send diffs to all subscribed clients
    for (const [ws, subscription] of this.subscriptions) {
      if (subscription.entityIds && !subscription.entityIds.includes(entityId)) {
        continue
      }

      const diff = this.buildDiff(entityId, oldState, newState)
      const event: EntityEvent = {
        c: {
          [entityId]: {
            '+': diff,
          },
        },
      }

      // Add removals if any
      const removedAttrs: string[] = []
      for (const key of Object.keys(oldState.attributes)) {
        if (!(key in newState.attributes)) {
          removedAttrs.push(key)
        }
      }

      if (removedAttrs.length > 0) {
        const change = event.c?.[entityId]
        if (change) {
          change['-'] = { a: removedAttrs }
        }
      }

      this.sendValidated(ws, {
        type: 'event',
        id: subscription.id,
        event,
      }, EventFrame)
    }
  }

  removeEntity(entityId: string): void {
    if (!this.entities.has(entityId)) {
      // Unknown entity is a no-op
      return
    }

    this.entities.delete(entityId)
    this.entityMeta.delete(entityId)

    // Send removal events to subscribed clients
    for (const [ws, subscription] of this.subscriptions) {
      if (subscription.entityIds && !subscription.entityIds.includes(entityId)) {
        continue
      }

      const event: EntityEvent = {
        r: [entityId],
      }

      this.sendValidated(ws, {
        type: 'event',
        id: subscription.id,
        event,
      }, EventFrame)
    }
  }

  get serviceCalls(): ServiceCall[] {
    return this._serviceCalls
  }

  failNextServiceCall(status: number): void {
    this.nextServiceCallStatus = status
  }

  subscribedEntityIds(): string[] | null {
    return this.latestSubscription?.entityIds ?? null
  }

  drop(): void {
    // Hard-close all sockets without clean handshake
    for (const ws of this.connections) {
      ws.terminate()
    }
    this.connections.clear()
    this.authenticatedConnections.clear()
    this.subscriptions.clear()
  }

  rejectAuth(on: boolean): void {
    this.rejectNextAuth = on
  }

  async stop(): Promise<void> {
    // Clean close
    for (const ws of this.connections) {
      ws.close()
    }
    this.connections.clear()
    this.authenticatedConnections.clear()
    this.subscriptions.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    if (this.httpServer) {
      const server = this.httpServer
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      this.httpServer = null
    }
  }
}
