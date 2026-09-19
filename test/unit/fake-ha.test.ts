import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { FakeHomeAssistant } from '../fake-ha.ts'
import type { EntityEvent } from '../../src/server/ha/schemas.ts'

type TestWebSocket = WebSocket & { messageQueue: unknown[] }

describe('FakeHomeAssistant', () => {
  let fake: FakeHomeAssistant
  let currentWs: TestWebSocket | undefined
  const connections: TestWebSocket[] = []

  beforeEach(async () => {
    fake = await FakeHomeAssistant.start({ token: 'test-token' })
    currentWs = undefined
  })

  afterEach(async () => {
    for (const conn of connections) {
      conn.close()
    }
    connections.length = 0
    currentWs = undefined
    await fake.stop()
  })

  async function connect(): Promise<TestWebSocket> {
    const client = new WebSocket(fake.baseUrl.replace('http://', 'ws://')) as TestWebSocket
    client.messageQueue = []
    connections.push(client)
    currentWs = client

    // Buffer all incoming messages
    client.on('message', (data) => {
      client.messageQueue.push(JSON.parse(data.toString()))
    })

    // Wait for connection to open
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })

    return client
  }

  async function receiveMessage(client: TestWebSocket): Promise<unknown> {
    // If there's a queued message, return it immediately
    if (client.messageQueue.length > 0) {
      return client.messageQueue.shift()
    }

    // Otherwise wait for the next message
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 1000)

      const checkQueue = (): void => {
        if (client.messageQueue.length > 0) {
          clearTimeout(timeout)
          resolve(client.messageQueue.shift())
        } else {
          // Check again in a bit
          setImmediate(checkQueue)
        }
      }

      checkQueue()
    })
  }

  function sendMessage(client: TestWebSocket, msg: unknown): void {
    client.send(JSON.stringify(msg))
  }

  describe('authentication handshake', () => {
    it('should complete full handshake successfully', async () => {
      await connect()

      const authRequired = await receiveMessage(currentWs!)
      expect(authRequired).toMatchObject({
        type: 'auth_required',
        ha_version: expect.any(String),
      })

      sendMessage(currentWs!, { type: 'auth', access_token: 'test-token' })

      const authOk = await receiveMessage(currentWs!)
      expect(authOk).toMatchObject({
        type: 'auth_ok',
        ha_version: expect.any(String),
      })
    })

    it('should reject invalid auth and close socket', async () => {
      fake.rejectAuth(true)
      await connect()

      await receiveMessage(currentWs!) // auth_required

      sendMessage(currentWs!, { type: 'auth', access_token: 'wrong-token' })

      const authInvalid = await receiveMessage(currentWs!)
      expect(authInvalid).toMatchObject({
        type: 'auth_invalid',
        message: expect.any(String),
      })

      // Socket should close
      await new Promise<void>((resolve) => {
        currentWs!.once('close', () => resolve())
      })
    })

    it('should not honor commands sent before auth', async () => {
      await connect()

      await receiveMessage(currentWs!) // auth_required

      // Send command before auth
      sendMessage(currentWs!, { type: 'ping', id: 1 })

      // Complete auth
      sendMessage(currentWs!, { type: 'auth', access_token: 'test-token' })
      await receiveMessage(currentWs!) // auth_ok

      // Send command after auth
      sendMessage(currentWs!, { type: 'ping', id: 2 })

      // Should only receive response to second ping
      const pong = await receiveMessage(currentWs!)
      expect(pong).toEqual({ type: 'pong', id: 2 })
    })
  })

  describe('registry commands', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(currentWs!) // auth_required
      sendMessage(currentWs!, { type: 'auth', access_token: 'test-token' })
      await receiveMessage(currentWs!) // auth_ok
    })

    it('should return seeded areas', async () => {
      fake.seed(
        [],
        [
          { areaId: 'living_room', name: 'Living Room' },
          { areaId: 'bedroom', name: 'Bedroom' },
        ]
      )

      sendMessage(currentWs!, { type: 'config/area_registry/list', id: 1 })

      const result = await receiveMessage(currentWs!)
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: true,
        result: [
          { area_id: 'living_room', name: 'Living Room' },
          { area_id: 'bedroom', name: 'Bedroom' },
        ],
      })
    })

    it('should return seeded devices', async () => {
      fake.seed(
        [],
        [],
        [
          { id: 'device1', name: 'Device 1', areaId: 'living_room' },
          { id: 'device2', name: 'Device 2', areaId: null },
        ]
      )

      sendMessage(currentWs!, { type: 'config/device_registry/list', id: 1 })

      const result = await receiveMessage(currentWs!)
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: true,
        result: [
          { id: 'device1', name: 'Device 1', area_id: 'living_room' },
          { id: 'device2', name: 'Device 2', area_id: null },
        ],
      })
    })

    it('should return seeded entities', async () => {
      fake.seed(
        [
          {
            entityId: 'light.living_room',
            name: 'Living Room Light',
            areaId: 'living_room',
            deviceId: 'device1',
            state: 'on',
            attributes: { brightness: 100 },
            disabledBy: null,
            hiddenBy: null,
          },
        ],
        [{ areaId: 'living_room', name: 'Living Room' }]
      )

      sendMessage(currentWs!, { type: 'config/entity_registry/list', id: 1 })

      const result = await receiveMessage(currentWs!)
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: true,
        result: [
          {
            entity_id: 'light.living_room',
            name: 'Living Room Light',
            area_id: 'living_room',
            device_id: 'device1',
            disabled_by: null,
            hidden_by: null,
          },
        ],
      })
    })

    it('should return config', async () => {
      sendMessage(currentWs!, { type: 'get_config', id: 1 })

      const result = await receiveMessage(currentWs!)
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: true,
        result: expect.objectContaining({
          version: expect.any(String),
        }),
      })
    })
  })

  describe('subscribe_entities', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(currentWs!) // auth_required
      sendMessage(currentWs!, { type: 'auth', access_token: 'test-token' })
      await receiveMessage(currentWs!) // auth_ok

      fake.seed(
        [
          {
            entityId: 'light.living_room',
            state: 'on',
            attributes: { brightness: 100 },
          },
          { entityId: 'light.bedroom', state: 'off', attributes: {} },
        ],
        []
      )
    })

    it('should send snapshot immediately on subscribe with filter', async () => {
      sendMessage(currentWs!, {
        type: 'subscribe_entities',
        id: 1,
        entity_ids: ['light.living_room'],
      })

      const result = await receiveMessage(currentWs!)
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: true,
      })

      const snapshot = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }
      expect(snapshot.type).toBe('event')
      expect(snapshot.id).toBe(1)
      expect(snapshot.event.a).toBeDefined()
      const compressed = snapshot.event.a?.['light.living_room']
      expect(compressed?.s).toBe('on')
      expect(compressed?.a).toEqual({ brightness: 100 })
      expect(compressed?.lc).toEqual(expect.any(Number))
      expect(compressed?.c).toEqual(expect.any(String))
      // lu should NOT be present when lc === lu
      expect(compressed?.lu).toBeUndefined()
      expect(snapshot.event.a?.['light.bedroom']).toBeUndefined()
    })

    it('should send snapshot for all entities when no filter', async () => {
      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })

      const result = await receiveMessage(currentWs!)
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: true,
      })

      const snapshot = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }
      expect(snapshot.event.a?.['light.living_room']).toBeDefined()
      expect(snapshot.event.a?.['light.bedroom']).toBeDefined()
    })

    it('should send minimal diff when only state changes', async () => {
      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      const beforeTime = Date.now() / 1000
      fake.setState('light.living_room', 'off')

      const diff = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }
      expect(diff.type).toBe('event')
      expect(diff.id).toBe(1)
      expect(diff.event.c).toBeDefined()

      const change = diff.event.c?.['light.living_room']
      expect(change?.['+']?.s).toBe('off')
      expect(change?.['+']?.lc).toBeGreaterThanOrEqual(beforeTime)
      // Protocol fidelity: state change sends lc only, not lu
      expect(change?.['+']?.lu).toBeUndefined()
      // Should NOT include attributes when they didn't change
      expect(change?.['+']?.a).toBeUndefined()
    })

    it('should send lu only when attributes change (not lc)', async () => {
      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      // Change only attributes, not state
      fake.setState('light.living_room', 'on', { brightness: 50 })

      const diff = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }
      const change = diff.event.c?.['light.living_room']
      expect(change?.['+']?.a).toEqual({ brightness: 50 })
      expect(change?.['+']?.lu).toBeDefined()
      // lc should NOT be present when state didn't change
      expect(change?.['+']?.lc).toBeUndefined()
      expect(change?.['+']?.s).toBeUndefined()
    })

    it('should include removed attributes in -.a', async () => {
      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      // Remove brightness attribute
      fake.setState('light.living_room', 'on', {})

      const diff = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }
      const change = diff.event.c?.['light.living_room']
      expect(change?.['-']?.a).toEqual(['brightness'])
      expect(change?.['+']?.lu).toBeDefined()
    })

    it('should send removal event', async () => {
      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      fake.removeEntity('light.living_room')

      const removal = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }
      expect(removal.type).toBe('event')
      expect(removal.id).toBe(1)
      expect(removal.event.r).toEqual(['light.living_room'])
    })

    it('should not send events for unsubscribed entities', async () => {
      sendMessage(currentWs!, {
        type: 'subscribe_entities',
        id: 1,
        entity_ids: ['light.living_room'],
      })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      // setState on unsubscribed entity should be no-op
      fake.setState('light.bedroom', 'on')

      // Send another command to verify connection is still alive
      sendMessage(currentWs!, { type: 'ping', id: 2 })
      const pong = await receiveMessage(currentWs!)
      expect(pong).toEqual({ type: 'pong', id: 2 })
    })
  })

  describe('ping/pong', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(currentWs!) // auth_required
      sendMessage(currentWs!, { type: 'auth', access_token: 'test-token' })
      await receiveMessage(currentWs!) // auth_ok
    })

    it('should respond to ping with pong', async () => {
      sendMessage(currentWs!, { type: 'ping', id: 42 })

      const pong = await receiveMessage(currentWs!)
      expect(pong).toEqual({ type: 'pong', id: 42 })
    })
  })

  describe('unknown commands', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(currentWs!) // auth_required
      sendMessage(currentWs!, { type: 'auth', access_token: 'test-token' })
      await receiveMessage(currentWs!) // auth_ok
    })

    it('should return success:false for unknown command', async () => {
      sendMessage(currentWs!, { type: 'unknown_command', id: 1 })

      const result = await receiveMessage(currentWs!)
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: false,
        error: {
          code: expect.any(String),
          message: expect.any(String),
        },
      })
    })
  })

  describe('REST service calls', () => {
    it('should record service call with correct token', async () => {
      const response = await fetch(`${fake.baseUrl}/api/services/light/turn_on`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fake.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entity_id: 'light.living_room' }),
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(Array.isArray(body)).toBe(true)

      expect(fake.serviceCalls).toHaveLength(1)
      expect(fake.serviceCalls[0]).toMatchObject({
        domain: 'light',
        service: 'turn_on',
        body: { entity_id: 'light.living_room' },
        authorization: `Bearer ${fake.token}`,
      })
    })

    it('should return 401 for wrong bearer token', async () => {
      const response = await fetch(`${fake.baseUrl}/api/services/light/turn_on`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(401)
    })

    it('should return 401 for missing authorization', async () => {
      const response = await fetch(`${fake.baseUrl}/api/services/light/turn_on`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(401)
    })

    it('should fail next service call with specified status', async () => {
      fake.failNextServiceCall(502)

      const response = await fetch(`${fake.baseUrl}/api/services/light/turn_on`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fake.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(502)

      // Next call should succeed
      const response2 = await fetch(`${fake.baseUrl}/api/services/light/turn_off`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fake.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      expect(response2.status).toBe(200)
    })
  })

  describe('subscribedEntityIds', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(currentWs!) // auth_required
      sendMessage(currentWs!, { type: 'auth', access_token: 'test-token' })
      await receiveMessage(currentWs!) // auth_ok
    })

    it('should return null when no subscription', () => {
      expect(fake.subscribedEntityIds()).toBeNull()
    })

    it('should return filter from most recent subscribe', async () => {
      sendMessage(currentWs!, {
        type: 'subscribe_entities',
        id: 1,
        entity_ids: ['light.living_room', 'light.bedroom'],
      })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      expect(fake.subscribedEntityIds()).toEqual(['light.living_room', 'light.bedroom'])
    })

    it('should return null for unfiltered subscribe', async () => {
      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      expect(fake.subscribedEntityIds()).toBeNull()
    })
  })

  describe('drop', () => {
    it('should hard-close all sockets', async () => {
      await connect()
      await receiveMessage(currentWs!) // auth_required

      const closed = new Promise<void>((resolve) => {
        currentWs!.once('close', () => resolve())
      })

      fake.drop()

      await closed
    })
  })

  describe('protocol fidelity', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(currentWs!) // auth_required
      sendMessage(currentWs!, { type: 'auth', access_token: 'test-token' })
      await receiveMessage(currentWs!) // auth_ok
    })

    it('snapshot contains s, a, c, lc and NO lu when last_changed equals last_updated', async () => {
      fake.seed(
        [{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }],
        []
      )

      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result

      const snapshot = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }

      const compressed = snapshot.event.a?.['light.test']
      expect(compressed).toBeDefined()
      expect(compressed?.s).toBe('on')
      expect(compressed?.a).toEqual({ brightness: 100 })
      expect(compressed?.c).toEqual(expect.any(String))
      expect(compressed?.lc).toEqual(expect.any(Number))
      expect(compressed?.lu).toBeUndefined() // Must NOT be present when lc === lu
    })

    it('snapshot contains lu when last_updated differs from last_changed', async () => {
      fake.seed(
        [{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }],
        []
      )

      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      // Change only attributes, not state
      fake.setState('light.test', 'on', { brightness: 50 })

      const diff1 = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }

      // Now subscribe again to get a fresh snapshot where lu !== lc
      sendMessage(currentWs!, { type: 'subscribe_entities', id: 2 })
      await receiveMessage(currentWs!) // result

      const snapshot = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }

      const compressed = snapshot.event.a?.['light.test']
      expect(compressed?.lc).toEqual(expect.any(Number))
      expect(compressed?.lu).toEqual(expect.any(Number))
      expect(compressed?.lu).not.toBe(compressed?.lc)
    })

    it('context in snapshot is a string', async () => {
      fake.seed(
        [{ entityId: 'light.test', state: 'on', attributes: {} }],
        []
      )

      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result

      const snapshot = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }

      const compressed = snapshot.event.a?.['light.test']
      expect(typeof compressed?.c).toBe('string')
    })

    it('timestamps are float seconds not milliseconds', async () => {
      fake.seed(
        [{ entityId: 'light.test', state: 'on', attributes: {} }],
        []
      )

      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result

      const snapshot = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }

      const compressed = snapshot.event.a?.['light.test']
      const now = Date.now() / 1000

      // lc should be within 2 seconds of now (float seconds)
      // A millisecond timestamp would be ~1.8e12
      expect(compressed?.lc).toBeGreaterThan(now - 2)
      expect(compressed?.lc).toBeLessThan(now + 2)
    })

    it('state-change diff contains lc and NOT lu', async () => {
      fake.seed(
        [{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }],
        []
      )

      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      // Change state
      fake.setState('light.test', 'off', { brightness: 100 })

      const diff = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }

      const change = diff.event.c?.['light.test']
      expect(change?.['+']?.s).toBe('off')
      expect(change?.['+']?.lc).toEqual(expect.any(Number))
      expect(change?.['+']?.lu).toBeUndefined() // Must NOT be present
    })

    it('attribute-only diff contains lu and NOT lc', async () => {
      fake.seed(
        [{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }],
        []
      )

      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      // Change only attributes
      fake.setState('light.test', 'on', { brightness: 50 })

      const diff = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }

      const change = diff.event.c?.['light.test']
      expect(change?.['+']?.s).toBeUndefined()
      expect(change?.['+']?.lc).toBeUndefined() // Must NOT be present
      expect(change?.['+']?.lu).toEqual(expect.any(Number))
      expect(change?.['+']?.a).toEqual({ brightness: 50 })
    })

    it('newly added attribute appears under +.a', async () => {
      fake.seed(
        [{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }],
        []
      )

      sendMessage(currentWs!, { type: 'subscribe_entities', id: 1 })
      await receiveMessage(currentWs!) // result
      await receiveMessage(currentWs!) // snapshot

      // Add a new attribute
      fake.setState('light.test', 'on', { brightness: 100, color_temp: 4000 })

      const diff = (await receiveMessage(currentWs!)) as {
        type: string
        id: number
        event: EntityEvent
      }

      const change = diff.event.c?.['light.test']
      // Only the new attribute should appear
      expect(change?.['+']?.a).toEqual({ color_temp: 4000 })
    })
  })
})
