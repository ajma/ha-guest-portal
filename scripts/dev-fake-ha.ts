// Standalone fake Home Assistant for interactive development.
//
// The e2e harness spins one of these up per run and tears it down again. This
// script keeps one alive on a fixed port so `pnpm dev` has something to talk to
// without needing a real Home Assistant instance.
//
// Seeded with one entity per supported domain so every tile type is reachable
// in the UI.

import { FakeHomeAssistant } from '../test/fake-ha.ts'

const PORT = Number(process.env.FAKE_HA_PORT ?? 8124)
const TOKEN = process.env.FAKE_HA_TOKEN ?? 'dev-fake-ha-token'

const fake = await FakeHomeAssistant.start({ token: TOKEN, port: PORT })

fake.seed(
  [
    {
      entityId: 'light.porch',
      name: 'Porch Light',
      areaId: 'front_yard',
      state: 'off',
      attributes: { brightness: 0 },
    },
    {
      entityId: 'switch.living_room_lamp',
      name: 'Living Room Lamp',
      areaId: 'living_room',
      state: 'on',
      attributes: {},
    },
    {
      entityId: 'cover.garage_door',
      name: 'Garage Door',
      areaId: 'garage',
      state: 'closed',
      attributes: { current_position: 0 },
    },
    {
      entityId: 'lock.front_door',
      name: 'Front Door Lock',
      areaId: 'front_yard',
      state: 'locked',
      attributes: {},
    },
    {
      entityId: 'climate.living_room',
      name: 'Living Room Thermostat',
      areaId: 'living_room',
      state: 'heat',
      attributes: {},
    },
  ],
  [
    { areaId: 'front_yard', name: 'Front Yard' },
    { areaId: 'living_room', name: 'Living Room' },
    { areaId: 'garage', name: 'Garage' },
  ],
)

console.log(`[fake-ha] listening on ${fake.baseUrl} (token: ${TOKEN})`)
console.log('[fake-ha] seeded 5 entities across light/switch/cover/lock/climate')

const shutdown = async (): Promise<void> => {
  console.log('[fake-ha] shutting down')
  await fake.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
