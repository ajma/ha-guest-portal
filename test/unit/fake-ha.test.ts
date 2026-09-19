import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { z } from 'zod'
import {
  type CompressedState,
  type EntityEvent,
  InboundFrame,
} from '../../src/server/ha/schemas.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

type TestWebSocket = WebSocket & { messageQueue: unknown[] }
type InboundFrameType = z.infer<typeof InboundFrame>

type FrameOf<T extends InboundFrameType['type']> = Extract<InboundFrameType, { type: T }>

function expectFrame<T extends InboundFrameType['type']>(
  frame: InboundFrameType,
  type: T,
): asserts frame is FrameOf<T> {
  if (frame.type !== type) {
    throw new Error(
      `expected a "${type}" frame but received "${frame.type}": ${JSON.stringify(frame)}`,
    )
  }
}

function expectEventFrame(frame: InboundFrameType): FrameOf<'event'> {
  expectFrame(frame, 'event')
  return frame
}

function requireWs(ws: TestWebSocket | undefined): TestWebSocket {
  if (!ws) throw new Error('websocket not initialised')
  return ws
}

function getAddedEntity(event: EntityEvent, entityId: string): CompressedState {
  const added = event.a?.[entityId]
  if (!added) {
    throw new Error(
      `expected entity "${entityId}" in added section (a) but not found: ${JSON.stringify(event)}`,
    )
  }
  return added
}

function getChangedEntity(
  event: EntityEvent,
  entityId: string,
): {
  '+'?: CompressedState | undefined
  '-'?: { a?: string[] | undefined } | undefined
} {
  const changed = event.c?.[entityId]
  if (!changed) {
    throw new Error(
      `expected entity "${entityId}" in changed section (c) but not found: ${JSON.stringify(event)}`,
    )
  }
  return changed
}

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
    const ws = new WebSocket(fake.baseUrl.replace('http://', 'ws://'))
    const client: TestWebSocket = Object.assign(ws, { messageQueue: [] })
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

  async function receiveMessage(client: TestWebSocket): Promise<z.infer<typeof InboundFrame>> {
    // If there's a queued message, return it immediately
    if (client.messageQueue.length > 0) {
      const msg = client.messageQueue.shift()
      return InboundFrame.parse(msg)
    }

    // Otherwise wait for the next message
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 1000)

      const checkQueue = (): void => {
        if (client.messageQueue.length > 0) {
          clearTimeout(timeout)
          const msg = client.messageQueue.shift()
          try {
            resolve(InboundFrame.parse(msg))
          } catch (err) {
            reject(err)
          }
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

      const authRequired = await receiveMessage(requireWs(currentWs))
      expect(authRequired).toMatchObject({
        type: 'auth_required',
        ha_version: expect.any(String),
      })

      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })

      const authOk = await receiveMessage(requireWs(currentWs))
      expect(authOk).toMatchObject({
        type: 'auth_ok',
        ha_version: expect.any(String),
      })
    })

    it('should reject invalid auth and close socket', async () => {
      fake.rejectAuth(true)
      await connect()

      await receiveMessage(requireWs(currentWs)) // auth_required

      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'wrong-token' })

      const authInvalid = await receiveMessage(requireWs(currentWs))
      expect(authInvalid).toMatchObject({
        type: 'auth_invalid',
        message: expect.any(String),
      })

      // Socket should close
      await new Promise<void>((resolve) => {
        requireWs(currentWs).once('close', () => resolve())
      })
    })

    it('should reject malformed JSON silently', async () => {
      await connect()
      await receiveMessage(requireWs(currentWs)) // auth_required

      // Send malformed JSON
      requireWs(currentWs).send('not valid json{{{')

      // Complete auth (should still work)
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      const authOk = await receiveMessage(requireWs(currentWs))
      expect(authOk).toMatchObject({ type: 'auth_ok' })
    })

    it('should reject wrong-shape frames with error result', async () => {
      await connect()
      await receiveMessage(requireWs(currentWs)) // auth_required
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      await receiveMessage(requireWs(currentWs)) // auth_ok

      // Send well-formed JSON but wrong shape (id field exists but value is wrong type)
      requireWs(currentWs).send(JSON.stringify({ type: 'ping', id: 123 }))
      // This should succeed (valid ping)
      const pong = await receiveMessage(requireWs(currentWs))
      expect(pong).toMatchObject({ type: 'pong', id: 123 })

      // Send frame with number id but completely wrong structure
      requireWs(currentWs).send(JSON.stringify({ id: 456, totally: 'wrong', structure: true }))

      const error = await receiveMessage(requireWs(currentWs))
      expect(error).toMatchObject({
        type: 'result',
        id: 456,
        success: false,
        error: {
          code: 'invalid_format',
          message: 'Invalid message format',
        },
      })
    })

    it('should not honor commands sent before auth', async () => {
      await connect()

      await receiveMessage(requireWs(currentWs)) // auth_required

      // Send command before auth
      sendMessage(requireWs(currentWs), { type: 'ping', id: 1 })

      // Complete auth
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      await receiveMessage(requireWs(currentWs)) // auth_ok

      // Send command after auth
      sendMessage(requireWs(currentWs), { type: 'ping', id: 2 })

      // Should only receive response to second ping
      const pong = await receiveMessage(requireWs(currentWs))
      expect(pong).toEqual({ type: 'pong', id: 2 })
    })
  })

  describe('registry commands', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(requireWs(currentWs)) // auth_required
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      await receiveMessage(requireWs(currentWs)) // auth_ok
    })

    it('should return seeded areas', async () => {
      fake.seed(
        [],
        [
          { areaId: 'living_room', name: 'Living Room' },
          { areaId: 'bedroom', name: 'Bedroom' },
        ],
      )

      sendMessage(requireWs(currentWs), { type: 'config/area_registry/list', id: 1 })

      const result = await receiveMessage(requireWs(currentWs))
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
        ],
      )

      sendMessage(requireWs(currentWs), { type: 'config/device_registry/list', id: 1 })

      const result = await receiveMessage(requireWs(currentWs))
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
        [{ areaId: 'living_room', name: 'Living Room' }],
      )

      sendMessage(requireWs(currentWs), { type: 'config/entity_registry/list', id: 1 })

      const result = await receiveMessage(requireWs(currentWs))
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
      sendMessage(requireWs(currentWs), { type: 'get_config', id: 1 })

      const result = await receiveMessage(requireWs(currentWs))
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
      await receiveMessage(requireWs(currentWs)) // auth_required
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      await receiveMessage(requireWs(currentWs)) // auth_ok

      fake.seed(
        [
          {
            entityId: 'light.living_room',
            state: 'on',
            attributes: { brightness: 100 },
          },
          { entityId: 'light.bedroom', state: 'off', attributes: {} },
        ],
        [],
      )
    })

    it('should send snapshot immediately on subscribe with filter', async () => {
      sendMessage(requireWs(currentWs), {
        type: 'subscribe_entities',
        id: 1,
        entity_ids: ['light.living_room'],
      })

      const result = await receiveMessage(requireWs(currentWs))
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: true,
      })

      const snapshot = expectEventFrame(await receiveMessage(requireWs(currentWs)))
      expect(snapshot.type).toBe('event')
      expect(snapshot.id).toBe(1)
      expect(snapshot.event.a).toBeDefined()
      const compressed = getAddedEntity(snapshot.event, 'light.living_room')
      expect(compressed.s).toBe('on')
      expect(compressed.a).toEqual({ brightness: 100 })
      expect(compressed.lc).toEqual(expect.any(Number))
      expect(compressed.c).toEqual(expect.any(String))
      // lu should NOT be present when lc === lu
      expect(compressed.lu).toBeUndefined()
      expect(snapshot.event.a?.['light.bedroom']).toBeUndefined()
    })

    it('should send snapshot for all entities when no filter', async () => {
      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })

      const result = await receiveMessage(requireWs(currentWs))
      expect(result).toMatchObject({
        type: 'result',
        id: 1,
        success: true,
      })

      const snapshot = expectEventFrame(await receiveMessage(requireWs(currentWs)))
      expect(snapshot.event.a?.['light.living_room']).toBeDefined()
      expect(snapshot.event.a?.['light.bedroom']).toBeDefined()
    })

    it('should send minimal diff when only state changes', async () => {
      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      const beforeTime = Date.now() / 1000
      fake.setState('light.living_room', 'off')

      const diff = expectEventFrame(await receiveMessage(requireWs(currentWs)))
      expect(diff.type).toBe('event')
      expect(diff.id).toBe(1)
      expect(diff.event.c).toBeDefined()

      const change = getChangedEntity(diff.event, 'light.living_room')
      expect(change['+']?.s).toBe('off')
      expect(change['+']?.lc).toBeGreaterThanOrEqual(beforeTime)
      // Protocol fidelity: state change sends lc only, not lu
      expect(change['+']?.lu).toBeUndefined()
      // Should NOT include attributes when they didn't change
      expect(change['+']?.a).toBeUndefined()
    })

    it('should send lu only when attributes change (not lc)', async () => {
      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      // Change only attributes, not state
      fake.setState('light.living_room', 'on', { brightness: 50 })

      const diff = expectEventFrame(await receiveMessage(requireWs(currentWs)))
      const change = getChangedEntity(diff.event, 'light.living_room')
      expect(change['+']?.a).toEqual({ brightness: 50 })
      expect(change['+']?.lu).toBeDefined()
      // lc should NOT be present when state didn't change
      expect(change['+']?.lc).toBeUndefined()
      expect(change['+']?.s).toBeUndefined()
    })

    it('should include removed attributes in -.a', async () => {
      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      // Remove brightness attribute
      fake.setState('light.living_room', 'on', {})

      const diff = expectEventFrame(await receiveMessage(requireWs(currentWs)))
      const change = getChangedEntity(diff.event, 'light.living_room')
      expect(change['-']?.a).toEqual(['brightness'])
      expect(change['+']?.lu).toBeDefined()
    })

    it('should send removal event', async () => {
      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      fake.removeEntity('light.living_room')

      const removal = expectEventFrame(await receiveMessage(requireWs(currentWs)))
      expect(removal.type).toBe('event')
      expect(removal.id).toBe(1)
      expect(removal.event.r).toEqual(['light.living_room'])
    })

    it('should not send events for unsubscribed entities', async () => {
      sendMessage(requireWs(currentWs), {
        type: 'subscribe_entities',
        id: 1,
        entity_ids: ['light.living_room'],
      })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      // setState on unsubscribed entity should be no-op
      fake.setState('light.bedroom', 'on')

      // Send another command to verify connection is still alive
      sendMessage(requireWs(currentWs), { type: 'ping', id: 2 })
      const pong = await receiveMessage(requireWs(currentWs))
      expect(pong).toEqual({ type: 'pong', id: 2 })
    })
  })

  describe('ping/pong', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(requireWs(currentWs)) // auth_required
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      await receiveMessage(requireWs(currentWs)) // auth_ok
    })

    it('should respond to ping with pong', async () => {
      sendMessage(requireWs(currentWs), { type: 'ping', id: 42 })

      const pong = await receiveMessage(requireWs(currentWs))
      expect(pong).toEqual({ type: 'pong', id: 42 })
    })
  })

  describe('unknown commands', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(requireWs(currentWs)) // auth_required
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      await receiveMessage(requireWs(currentWs)) // auth_ok
    })

    it('should return success:false for unknown command', async () => {
      sendMessage(requireWs(currentWs), { type: 'unknown_command', id: 1 })

      const result = await receiveMessage(requireWs(currentWs))
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
      await receiveMessage(requireWs(currentWs)) // auth_required
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      await receiveMessage(requireWs(currentWs)) // auth_ok
    })

    it('should return null when no subscription', () => {
      expect(fake.subscribedEntityIds()).toBeNull()
    })

    it('should return filter from most recent subscribe', async () => {
      sendMessage(requireWs(currentWs), {
        type: 'subscribe_entities',
        id: 1,
        entity_ids: ['light.living_room', 'light.bedroom'],
      })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      expect(fake.subscribedEntityIds()).toEqual(['light.living_room', 'light.bedroom'])
    })

    it('should return null for unfiltered subscribe', async () => {
      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      expect(fake.subscribedEntityIds()).toBeNull()
    })
  })

  describe('drop', () => {
    it('should hard-close all sockets', async () => {
      await connect()
      await receiveMessage(requireWs(currentWs)) // auth_required

      const closed = new Promise<void>((resolve) => {
        requireWs(currentWs).once('close', () => resolve())
      })

      fake.drop()

      await closed
    })
  })

  describe('protocol fidelity', () => {
    beforeEach(async () => {
      await connect()
      await receiveMessage(requireWs(currentWs)) // auth_required
      sendMessage(requireWs(currentWs), { type: 'auth', access_token: 'test-token' })
      await receiveMessage(requireWs(currentWs)) // auth_ok
    })

    it('snapshot contains s, a, c, lc and NO lu when last_changed equals last_updated', async () => {
      fake.seed([{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }], [])

      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result

      const snapshot = expectEventFrame(await receiveMessage(requireWs(currentWs)))

      const compressed = getAddedEntity(snapshot.event, 'light.test')
      expect(compressed).toBeDefined()
      expect(compressed.s).toBe('on')
      expect(compressed.a).toEqual({ brightness: 100 })
      expect(compressed.c).toEqual(expect.any(String))
      expect(compressed.lc).toEqual(expect.any(Number))
      expect(compressed.lu).toBeUndefined() // Must NOT be present when lc === lu
    })

    it('snapshot contains lu when last_updated differs from last_changed', async () => {
      fake.seed([{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }], [])

      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      // Change only attributes, not state
      fake.setState('light.test', 'on', { brightness: 50 })

      await receiveMessage(requireWs(currentWs)) // diff1

      // Now subscribe again to get a fresh snapshot where lu !== lc
      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 2 })
      await receiveMessage(requireWs(currentWs)) // result

      const snapshot = expectEventFrame(await receiveMessage(requireWs(currentWs)))

      const compressed = getAddedEntity(snapshot.event, 'light.test')
      expect(compressed.lc).toEqual(expect.any(Number))
      expect(compressed.lu).toEqual(expect.any(Number))
      expect(compressed.lu).not.toBe(compressed.lc)
    })

    it('context in snapshot is a string', async () => {
      fake.seed([{ entityId: 'light.test', state: 'on', attributes: {} }], [])

      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result

      const snapshot = expectEventFrame(await receiveMessage(requireWs(currentWs)))

      const compressed = getAddedEntity(snapshot.event, 'light.test')
      expect(typeof compressed.c).toBe('string')
    })

    it('timestamps are float seconds not milliseconds', async () => {
      fake.seed([{ entityId: 'light.test', state: 'on', attributes: {} }], [])

      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result

      const snapshot = expectEventFrame(await receiveMessage(requireWs(currentWs)))

      const compressed = getAddedEntity(snapshot.event, 'light.test')
      const now = Date.now() / 1000

      // lc should be within 2 seconds of now (float seconds)
      // A millisecond timestamp would be ~1.8e12
      expect(compressed.lc).toBeGreaterThan(now - 2)
      expect(compressed.lc).toBeLessThan(now + 2)
    })

    it('state-change diff contains lc and NOT lu', async () => {
      fake.seed([{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }], [])

      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      // Change state
      fake.setState('light.test', 'off', { brightness: 100 })

      const diff = expectEventFrame(await receiveMessage(requireWs(currentWs)))

      const change = getChangedEntity(diff.event, 'light.test')
      expect(change['+']?.s).toBe('off')
      expect(change['+']?.lc).toEqual(expect.any(Number))
      expect(change['+']?.lu).toBeUndefined() // Must NOT be present
    })

    it('attribute-only diff contains lu and NOT lc', async () => {
      fake.seed([{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }], [])

      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      // Change only attributes
      fake.setState('light.test', 'on', { brightness: 50 })

      const diff = expectEventFrame(await receiveMessage(requireWs(currentWs)))

      const change = getChangedEntity(diff.event, 'light.test')
      expect(change['+']?.s).toBeUndefined()
      expect(change['+']?.lc).toBeUndefined() // Must NOT be present
      expect(change['+']?.lu).toEqual(expect.any(Number))
      expect(change['+']?.a).toEqual({ brightness: 50 })
    })

    it('newly added attribute appears under +.a', async () => {
      fake.seed([{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }], [])

      sendMessage(requireWs(currentWs), { type: 'subscribe_entities', id: 1 })
      await receiveMessage(requireWs(currentWs)) // result
      await receiveMessage(requireWs(currentWs)) // snapshot

      // Add a new attribute
      fake.setState('light.test', 'on', { brightness: 100, color_temp: 4000 })

      const diff = expectEventFrame(await receiveMessage(requireWs(currentWs)))

      const change = getChangedEntity(diff.event, 'light.test')
      // Only the new attribute should appear
      expect(change['+']?.a).toEqual({ color_temp: 4000 })
    })
  })
})
