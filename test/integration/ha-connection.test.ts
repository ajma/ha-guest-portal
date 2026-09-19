import { afterEach, describe, expect, it } from 'vitest'
import { HaConnection } from '../../src/server/ha/connection.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

describe('HaConnection', () => {
  let fake: FakeHomeAssistant | null = null

  afterEach(async () => {
    if (fake) {
      await fake.stop()
      fake = null
    }
  })

  it('connects and reaches ready status', async () => {
    fake = await FakeHomeAssistant.start()
    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    const statuses: string[] = []
    conn.onStatus((s) => statuses.push(s))

    conn.start()

    // Wait for ready status
    await waitFor(() => conn.status === 'ready', 2000)

    expect(conn.status).toBe('ready')
    expect(statuses).toContain('connecting')
    expect(statuses).toContain('ready')

    await conn.stop()
  })

  it('send resolves with parsed result payload, not envelope', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed([{ entityId: 'light.test', state: 'off' }], [{ areaId: 'hall', name: 'Hall' }])

    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    const { z } = await import('zod')
    const AreaSchema = z.array(
      z
        .object({
          area_id: z.string(),
          name: z.string(),
        })
        .passthrough(),
    )

    const areas = await conn.send({ type: 'config/area_registry/list' }, AreaSchema)

    // Should get the payload directly, not wrapped in envelope
    expect(areas).toEqual([{ area_id: 'hall', name: 'Hall' }])

    await conn.stop()
  })

  it('send rejects on HA error frame', async () => {
    fake = await FakeHomeAssistant.start()
    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    const { z } = await import('zod')

    // Send unknown command that will return error
    await expect(conn.send({ type: 'unknown_command_xyz' }, z.unknown())).rejects.toThrow()

    await conn.stop()
  })

  it('send rejects when result does not match schema', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed([{ entityId: 'light.test', state: 'off' }], [{ areaId: 'hall', name: 'Hall' }])

    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    // Use a schema that expects wrong structure for area registry
    const { z } = await import('zod')
    const BadSchema = z.object({
      wrongField: z.string(), // Areas are an array, not an object
    })

    // Send valid command but with wrong schema expectation
    await expect(conn.send({ type: 'config/area_registry/list' }, BadSchema)).rejects.toThrow()

    await conn.stop()
  })

  it('drop() causes disconnected then auto-reconnects to ready', async () => {
    fake = await FakeHomeAssistant.start()
    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    const statuses: string[] = []
    conn.onStatus((s) => statuses.push(s))

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    // Clear statuses after initial connection
    statuses.length = 0

    // Drop the connection
    fake.drop()

    // Should go to disconnected
    await waitFor(() => statuses.includes('disconnected'), 2000)

    // Then auto-reconnect to ready
    await waitFor(() => conn.status === 'ready', 3000)

    expect(statuses).toContain('disconnected')
    expect(statuses).toContain('connecting')
    expect(statuses).toContain('ready')

    await conn.stop()
  })

  it('in-flight send rejects on socket drop', async () => {
    fake = await FakeHomeAssistant.start()
    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    const { z } = await import('zod')

    // Start a send but don't await it yet
    const sendPromise = conn.send({ type: 'get_config' }, z.unknown())

    // Immediately drop the connection
    fake.drop()

    // The promise should reject, not hang
    await expect(sendPromise).rejects.toThrow()

    await conn.stop()
  })

  it('rejectAuth causes disconnected with NO reconnect attempts', async () => {
    fake = await FakeHomeAssistant.start()
    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    // Enable auth rejection
    fake.rejectAuth(true)

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 50, // Very short for testing
      reconnectMaxMs: 200,
      pingIntervalMs: 5000,
    })

    const statuses: string[] = []
    conn.onStatus((s) => statuses.push(s))

    conn.start()

    // Should reach disconnected
    await waitFor(() => conn.status === 'disconnected', 2000)

    // Wait well past multiple backoff intervals
    await sleep(500)

    // Should still be disconnected, no reconnect attempts
    expect(conn.status).toBe('disconnected')

    // Should only have tried once (connecting -> disconnected)
    const connectingCount = statuses.filter((s) => s === 'connecting').length
    expect(connectingCount).toBe(1)

    await conn.stop()
  })

  it('subscription delivers events', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [{ entityId: 'light.living_room', state: 'off' }],
      [{ areaId: 'living_room', name: 'Living Room' }],
    )

    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    const events: unknown[] = []
    const sub = await conn.subscribe({ type: 'subscribe_entities' }, (event) => events.push(event))

    // Should get initial snapshot
    await waitFor(() => events.length > 0, 2000)

    // Change entity state
    fake.setState('light.living_room', 'on')

    // Should get update event
    await waitFor(() => events.length > 1, 2000)

    expect(events.length).toBeGreaterThan(1)

    await sub.unsubscribe()
    await conn.stop()
  })

  it('stop is idempotent and leaves no open handles', async () => {
    fake = await FakeHomeAssistant.start()
    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    // Call stop multiple times
    await conn.stop()
    await conn.stop()
    await conn.stop()

    expect(conn.status).toBe('disconnected')

    // Wait a bit to ensure no reconnect happens
    await sleep(300)
    expect(conn.status).toBe('disconnected')
  })

  it('derives wsUrl from baseUrl with http->ws conversion', async () => {
    fake = await FakeHomeAssistant.start()

    const conn = new HaConnection({
      baseUrl: fake.baseUrl, // http://...
      token: fake.token,
      // No wsUrl provided - should derive
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    expect(conn.status).toBe('ready')

    await conn.stop()
  })

  it('uses explicit wsUrl when provided', async () => {
    fake = await FakeHomeAssistant.start()
    const explicitWsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: 'http://different-host:8123', // Different from actual
      token: fake.token,
      wsUrl: explicitWsUrl, // But explicit URL should be used
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    expect(conn.status).toBe('ready')

    await conn.stop()
  })

  it('subscription survives reconnect', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed([{ entityId: 'light.test', state: 'off' }], [])

    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    const events: unknown[] = []
    await conn.subscribe({ type: 'subscribe_entities' }, (event) => events.push(event))

    // Wait for initial snapshot
    await waitFor(() => events.length > 0, 2000)
    const eventsBeforeDrop = events.length

    // Drop connection
    fake.drop()

    // Wait for reconnect
    await waitFor(() => conn.status === 'ready', 3000)

    // Change state - should receive event after reconnect
    fake.setState('light.test', 'on')

    // Assert event count increases
    await waitFor(() => events.length > eventsBeforeDrop, 2000)
    expect(events.length).toBeGreaterThan(eventsBeforeDrop)

    await conn.stop()
  })

  it('fresh snapshot after reconnect', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed([{ entityId: 'light.test', state: 'off' }], [])

    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    const events: unknown[] = []
    await conn.subscribe({ type: 'subscribe_entities' }, (event) => events.push(event))

    // Wait for initial snapshot
    await waitFor(() => events.length > 0, 2000)

    // Clear events
    events.length = 0

    // Drop connection
    fake.drop()

    // Wait for reconnect
    await waitFor(() => conn.status === 'ready', 3000)

    // Wait for post-reconnect snapshot
    await waitFor(() => events.length > 0, 2000)

    // First event after reconnect should be an object with "a" section
    const firstEvent = events[0]
    expect(typeof firstEvent).toBe('object')
    expect(firstEvent).not.toBeNull()

    // Should include "a" (added) section with snapshot
    expect(firstEvent).toHaveProperty('a')

    await conn.stop()
  })

  it('unsubscribe still works after reconnect', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed([{ entityId: 'light.test', state: 'off' }], [])

    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    const events: unknown[] = []
    const sub = await conn.subscribe({ type: 'subscribe_entities' }, (event) => events.push(event))

    // Wait for initial snapshot
    await waitFor(() => events.length > 0, 2000)

    // Drop connection
    fake.drop()

    // Wait for reconnect
    await waitFor(() => conn.status === 'ready', 3000)

    // Clear events received during reconnect
    events.length = 0

    // Unsubscribe
    await sub.unsubscribe()

    // Change state - should NOT receive event
    fake.setState('light.test', 'on')

    // Wait to ensure no events arrive
    await sleep(300)

    expect(events.length).toBe(0)

    await conn.stop()
  })

  it('start() twice is safe', async () => {
    fake = await FakeHomeAssistant.start()
    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })

    // Call start twice
    conn.start()
    conn.start()

    // Should reach ready
    await waitFor(() => conn.status === 'ready', 2000)

    // Wait to ensure stays ready
    await sleep(300)
    expect(conn.status).toBe('ready')

    await conn.stop()
  })

  it('no orphaned sockets after multiple reconnects', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed([{ entityId: 'light.test', state: 'off' }], [])

    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`

    const conn = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      pingIntervalMs: 5000,
    })

    conn.start()
    await waitFor(() => conn.status === 'ready', 2000)

    const events: unknown[] = []
    await conn.subscribe({ type: 'subscribe_entities' }, (event) => events.push(event))

    // Wait for initial snapshot
    await waitFor(() => events.length > 0, 2000)

    // Multiple drop/reconnect cycles
    for (let i = 0; i < 3; i++) {
      events.length = 0
      fake.drop()
      await waitFor(() => conn.status === 'ready', 2000)
      await waitFor(() => events.length > 0, 2000)
    }

    // Clear events and test for duplicates
    events.length = 0

    // Send one state change
    fake.setState('light.test', 'on')

    // Wait for event
    await waitFor(() => events.length > 0, 2000)

    // Should receive exactly one event, not duplicates
    expect(events.length).toBe(1)

    await conn.stop()
  })
})

describe('loadConfig', () => {
  it('rejects .local hostnames', async () => {
    const { loadConfig } = await import('../../src/server/config.ts')

    const env = {
      HA_BASE_URL: 'http://homeassistant.local:8123',
      HA_TOKEN: 'test-token',
      GUEST_PASSWORD: 'guest12345',
      ADMIN_PASSWORD: 'admin12345',
    }

    expect(() => loadConfig(env)).toThrow(/mDNS/)
  })

  it('accepts non-.local hostnames', async () => {
    const { loadConfig } = await import('../../src/server/config.ts')

    const env = {
      HA_BASE_URL: 'http://192.168.1.100:8123',
      HA_TOKEN: 'test-token',
      GUEST_PASSWORD: 'guest12345',
      ADMIN_PASSWORD: 'admin12345',
    }

    const config = loadConfig(env)
    expect(config.haBaseUrl).toBe('http://192.168.1.100:8123')
  })

  it('includes haWsUrl when HA_WS_URL is provided', async () => {
    const { loadConfig } = await import('../../src/server/config.ts')

    const env = {
      HA_BASE_URL: 'http://192.168.1.100:8123',
      HA_WS_URL: 'ws://supervisor/core/websocket',
      HA_TOKEN: 'test-token',
      GUEST_PASSWORD: 'guest12345',
      ADMIN_PASSWORD: 'admin12345',
    }

    const config = loadConfig(env)
    expect(config.haWsUrl).toBe('ws://supervisor/core/websocket')
  })

  it('haWsUrl is undefined when HA_WS_URL is not provided', async () => {
    const { loadConfig } = await import('../../src/server/config.ts')

    const env = {
      HA_BASE_URL: 'http://192.168.1.100:8123',
      HA_TOKEN: 'test-token',
      GUEST_PASSWORD: 'guest12345',
      ADMIN_PASSWORD: 'admin12345',
    }

    const config = loadConfig(env)
    expect(config.haWsUrl).toBeUndefined()
  })
})

// Helper functions
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`)
    }
    await sleep(50)
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
