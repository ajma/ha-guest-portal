import { afterEach, describe, expect, it } from 'vitest'
import { fetchCatalog } from '../../src/server/ha/catalog.ts'
import { HaConnection } from '../../src/server/ha/connection.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

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
      [{ id: 'device1', name: 'Device 1', areaId: 'kitchen' }],
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
      [{ id: 'device2', name: 'Device 2', areaId: 'hallway' }],
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
      [{ id: 'device3', name: 'Device 3', areaId: null }],
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
      [],
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
      [],
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
      [],
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
      [],
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
      [],
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
      [],
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
      [],
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
      [],
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

  describe('icon resolution (mirrors HA Entity.icon precedence)', () => {
    it('registry icon override wins over the integration default', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'light.override',
            name: 'Override Light',
            state: 'on',
            icon: 'mdi:lightbulb-on',
            originalIcon: 'mdi:lightbulb',
          },
        ],
        [],
        [],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.icon).toBe('mdi:lightbulb-on')
    })

    it('falls back to original_icon when there is no registry override', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'light.default',
            name: 'Default Light',
            state: 'on',
            originalIcon: 'mdi:lightbulb',
          },
        ],
        [],
        [],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.icon).toBe('mdi:lightbulb')
    })

    it('is null when neither icon nor original_icon is set', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'light.no_icon',
            name: 'No Icon Light',
            state: 'on',
          },
        ],
        [],
        [],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.icon).toBeNull()
    })
  })

  describe('display name resolution (mirrors HA Entity._friendly_name_internal)', () => {
    it('registry override (entity.name) always wins', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'lock.override',
            name: 'Custom Override Name',
            originalName: '',
            hasEntityName: true,
            deviceId: 'device1',
            state: 'locked',
          },
        ],
        [],
        [{ id: 'device1', name: 'Device Name', areaId: null }],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('Custom Override Name')
    })

    it('empty registry override falls through to device name', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'light.empty_override',
            name: '',
            originalName: '',
            hasEntityName: true,
            deviceId: 'device2',
            state: 'off',
          },
        ],
        [],
        [{ id: 'device2', name: 'Device With Name', areaId: null }],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('Device With Name')
      // Fails against implementation that trusts entity.name verbatim without nonEmpty()
    })

    it('has_entity_name + device with empty suffix uses device name (real case: lock.front_door_lock)', async () => {
      fake = await FakeHomeAssistant.start()
      // Real shape from probe: {"entity_id":"lock.front_door_lock","name":null,"original_name":"","has_entity_name":true,"device_name":"Front Door Lock","device_name_by_user":null}
      fake.seed(
        [
          {
            entityId: 'lock.front_door_lock',
            originalName: '',
            hasEntityName: true,
            deviceId: 'dev_front_door',
            state: 'locked',
          },
        ],
        [],
        [{ id: 'dev_front_door', name: 'Front Door Lock', areaId: null }],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('Front Door Lock')
      // Fails against the old `??` implementation which would return ""
    })

    it('has_entity_name + device_name_by_user wins over device_name (real case: light.kitchen_sink_light)', async () => {
      fake = await FakeHomeAssistant.start()
      // Real shape: {"entity_id":"light.kitchen_sink_light","name":null,"original_name":"","has_entity_name":true,"device_name":"Kitchen Sink","device_name_by_user":"Kitchen Sink Light"}
      fake.seed(
        [
          {
            entityId: 'light.kitchen_sink_light',
            originalName: '',
            hasEntityName: true,
            deviceId: 'dev_kitchen_sink',
            state: 'off',
          },
        ],
        [],
        [
          {
            id: 'dev_kitchen_sink',
            name: 'Kitchen Sink',
            nameByUser: 'Kitchen Sink Light',
            areaId: null,
          },
        ],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('Kitchen Sink Light')
      // Fails against implementation that doesn't check name_by_user
    })

    it('has_entity_name + device + non-empty suffix appends suffix to device name', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'sensor.garage_door_battery',
            originalName: 'Battery',
            hasEntityName: true,
            deviceId: 'dev_garage_door',
            state: '85',
          },
        ],
        [],
        [{ id: 'dev_garage_door', name: 'Garage Door', areaId: null }],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('Garage Door Battery')
      // Fails against implementation that doesn't append suffix
    })

    it('original_name empty string with no device falls through to entity_id', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'light.orphan_empty',
            originalName: '',
            hasEntityName: false,
            state: 'off',
          },
        ],
        [],
        [],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('light.orphan_empty')
      // Fails against the old `??` implementation which would return ""
    })

    it('whitespace-only original_name is treated as absent', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'switch.whitespace',
            originalName: '   ',
            hasEntityName: false,
            state: 'on',
          },
        ],
        [],
        [],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('switch.whitespace')
      // Fails against implementation that doesn't trim whitespace
    })

    it('has_entity_name absent (older HA) behaves as before', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'light.legacy',
            originalName: 'Legacy Light',
            deviceId: 'dev_legacy',
            state: 'off',
          },
        ],
        [],
        [{ id: 'dev_legacy', name: 'Legacy Device', areaId: null }],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('Legacy Light')
      // When has_entity_name is absent, use original_name if present
    })

    it('has_entity_name false uses original_name', async () => {
      fake = await FakeHomeAssistant.start()
      fake.seed(
        [
          {
            entityId: 'fan.standalone',
            originalName: 'Standalone Fan',
            hasEntityName: false,
            deviceId: 'dev_fan',
            state: 'off',
          },
        ],
        [],
        [{ id: 'dev_fan', name: 'Fan Device', areaId: null }],
      )
      const connection = await setupConnection()

      const catalog = await fetchCatalog(connection)

      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.name).toBe('Standalone Fan')
      // has_entity_name=false means don't use device name
    })
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
