import { describe, it, expect, afterEach } from 'vitest'
import { FakeHomeAssistant } from '../fake-ha.ts'
import { HaConnection } from '../../src/server/ha/connection.ts'
import { fetchCatalog } from '../../src/server/ha/catalog.ts'

describe('fetchCatalog', () => {
  let fake: FakeHomeAssistant | null = null
  let conn: HaConnection | null = null

  afterEach(async () => {
    if (conn) {
      await conn.stop()
      conn = null
    }
    if (fake) {
      await fake.stop()
      fake = null
    }
  })

  async function setupConnection(): Promise<HaConnection> {
    if (!fake) {
      throw new Error('FakeHomeAssistant not started')
    }
    const wsUrl = `${fake.baseUrl.replace('http://', 'ws://')}/api/websocket`
    const connection = new HaConnection({
      baseUrl: fake.baseUrl,
      token: fake.token,
      wsUrl,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      pingIntervalMs: 5000,
    })
    connection.start()
    await waitFor(() => connection.status === 'ready', 2000)
    conn = connection
    return connection
  }

  it('entity-level area_id wins over device area', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'light.bedroom',
          name: 'Bedroom Light',
          state: 'off',
          deviceId: 'device1',
          areaId: 'bedroom',
        },
      ],
      [
        { areaId: 'bedroom', name: 'Bedroom' },
        { areaId: 'kitchen', name: 'Kitchen' },
      ],
      [{ id: 'device1', name: 'Device 1', areaId: 'kitchen' }]
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      entityId: 'light.bedroom',
      name: 'Bedroom Light',
      area: 'Bedroom',
      domain: 'light',
      supported: true,
    })
  })

  it('entity with no area inherits device area', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'switch.hallway',
          name: 'Hallway Switch',
          state: 'on',
          deviceId: 'device2',
          areaId: null,
        },
      ],
      [{ areaId: 'hallway', name: 'Hallway' }],
      [{ id: 'device2', name: 'Device 2', areaId: 'hallway' }]
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      entityId: 'switch.hallway',
      name: 'Hallway Switch',
      area: 'Hallway',
      domain: 'switch',
      supported: true,
    })
  })

  it('area is null when neither entity nor device has one', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'fan.orphan',
          name: 'Orphan Fan',
          state: 'off',
          deviceId: 'device3',
          areaId: null,
        },
      ],
      [],
      [{ id: 'device3', name: 'Device 3', areaId: null }]
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      entityId: 'fan.orphan',
      name: 'Orphan Fan',
      area: null,
      domain: 'fan',
      supported: true,
    })
  })

  it('area is null when device_id references absent device', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'light.dangling',
          name: 'Dangling Light',
          state: 'off',
          deviceId: 'missing-device',
          areaId: null,
        },
      ],
      [{ areaId: 'living_room', name: 'Living Room' }],
      []
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      entityId: 'light.dangling',
      name: 'Dangling Light',
      area: null,
      domain: 'light',
      supported: true,
    })
  })

  it('area is null when area_id references absent area', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'switch.broken',
          name: 'Broken Switch',
          state: 'on',
          deviceId: null,
          areaId: 'missing-area',
        },
      ],
      [],
      []
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      entityId: 'switch.broken',
      name: 'Broken Switch',
      area: null,
      domain: 'switch',
      supported: true,
    })
  })

  it('entity name fallback chain: name -> original_name -> entityId', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'light.with_name',
          name: 'Custom Name',
          state: 'off',
        },
        {
          entityId: 'light.fallback',
          state: 'off',
        },
      ],
      [],
      []
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(2)
    const withName = catalog.find((e) => e.entityId === 'light.with_name')
    const fallback = catalog.find((e) => e.entityId === 'light.fallback')

    expect(withName).toMatchObject({
      entityId: 'light.with_name',
      name: 'Custom Name',
    })
    expect(fallback).toMatchObject({
      entityId: 'light.fallback',
      name: 'light.fallback',
    })
  })

  it('excludes entities with disabled_by set', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'light.enabled',
          name: 'Enabled Light',
          state: 'off',
        },
        {
          entityId: 'light.disabled',
          name: 'Disabled Light',
          state: 'off',
          disabledBy: 'user',
        },
      ],
      [],
      []
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.entityId).toBe('light.enabled')
  })

  it('excludes entities with hidden_by set', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'switch.visible',
          name: 'Visible Switch',
          state: 'on',
        },
        {
          entityId: 'switch.hidden',
          name: 'Hidden Switch',
          state: 'on',
          hiddenBy: 'integration',
        },
      ],
      [],
      []
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.entityId).toBe('switch.visible')
  })

  it('includes unsupported entities with supported: false', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'climate.thermostat',
          name: 'Thermostat',
          state: 'heat',
        },
      ],
      [],
      []
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      entityId: 'climate.thermostat',
      name: 'Thermostat',
      domain: 'climate',
      supported: false,
    })
  })

  it('includes supported entities with supported: true', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'light.living_room',
          name: 'Living Room Light',
          state: 'on',
        },
      ],
      [],
      []
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      entityId: 'light.living_room',
      name: 'Living Room Light',
      domain: 'light',
      supported: true,
    })
  })

  it('sorts results by display name', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'light.zebra',
          name: 'Zebra Light',
          state: 'off',
        },
        {
          entityId: 'light.apple',
          name: 'Apple Light',
          state: 'off',
        },
        {
          entityId: 'light.monkey',
          name: 'Monkey Light',
          state: 'off',
        },
      ],
      [],
      []
    )
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toHaveLength(3)
    expect(catalog[0]?.name).toBe('Apple Light')
    expect(catalog[1]?.name).toBe('Monkey Light')
    expect(catalog[2]?.name).toBe('Zebra Light')
  })

  it('empty registry yields empty array', async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed([], [], [])
    const connection = await setupConnection()

    const catalog = await fetchCatalog(connection)

    expect(catalog).toEqual([])
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
