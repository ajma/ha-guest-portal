import { describe, expect, it, beforeEach } from 'vitest'
import type { Device, SseFrame } from '@shared/api.js'

// Store functions to be implemented
type DeviceStoreSnapshot = {
  devices: Device[]
  stale: boolean
  connected: boolean
  portalEnabled: boolean
}

// We'll test the internal applyFrame function directly
// since happy-dom doesn't have a real EventSource server
let applyFrame: (frame: SseFrame) => void
let getSnapshot: () => DeviceStoreSnapshot
let setConnected: (connected: boolean) => void
let setPortalEnabled: (enabled: boolean) => void
let resetStore: () => void

describe('Device store', () => {
  beforeEach(async () => {
    // Dynamic import to avoid module-level issues
    const store = await import('../../src/web/store.js')
    applyFrame = store.applyFrame
    getSnapshot = store.getSnapshot
    setConnected = store.setConnected
    setPortalEnabled = store.setPortalEnabled
    resetStore = store.resetStore

    // Reset state before each test
    resetStore()
  })

  const makeDevice = (entityId: string, state = 'on'): Device => ({
    entityId,
    label: `Label ${entityId}`,
    domain: 'light',
    allowedActions: ['turn_on', 'turn_off'],
    sortOrder: 0,
    state: {
      state,
      attributes: {},
      stale: false,
    },
  })

  describe('snapshot frame', () => {
    it('replaces the device list and sets stale', () => {
      const device1 = makeDevice('light.living_room')
      const device2 = makeDevice('light.bedroom')

      applyFrame({
        type: 'snapshot',
        devices: [device1],
        stale: false,
      })

      let snapshot = getSnapshot()
      expect(snapshot.devices).toEqual([device1])
      expect(snapshot.stale).toBe(false)

      applyFrame({
        type: 'snapshot',
        devices: [device2],
        stale: true,
      })

      snapshot = getSnapshot()
      expect(snapshot.devices).toEqual([device2])
      expect(snapshot.stale).toBe(true)
    })
  })

  describe('patch frame', () => {
    it('updates only the named devices and leaves others untouched', () => {
      const device1 = makeDevice('light.living_room', 'off')
      const device2 = makeDevice('light.bedroom', 'off')
      const device3 = makeDevice('light.kitchen', 'off')

      applyFrame({
        type: 'snapshot',
        devices: [device1, device2, device3],
        stale: false,
      })

      // Get references from the snapshot (after Zod parsing)
      const snapshotAfterInit = getSnapshot()
      const device1Ref = snapshotAfterInit.devices[0]
      const device2Ref = snapshotAfterInit.devices[1]
      const device3Ref = snapshotAfterInit.devices[2]

      if (!device2Ref) throw new Error('device2 not found')

      const updatedDevice2 = { ...device2Ref, state: { ...device2Ref.state, state: 'on' } }
      applyFrame({
        type: 'patch',
        devices: [updatedDevice2],
      })

      const snapshot = getSnapshot()
      expect(snapshot.devices).toHaveLength(3)
      expect(snapshot.devices[0]).toBe(device1Ref) // unchanged, same reference
      expect(snapshot.devices[1]).toEqual(updatedDevice2) // updated
      expect(snapshot.devices[2]).toBe(device3Ref) // unchanged, same reference
    })
  })

  describe('degraded frame', () => {
    it('sets stale on all devices without discarding them', () => {
      const device1 = makeDevice('light.living_room')
      const device2 = makeDevice('light.bedroom')

      applyFrame({
        type: 'snapshot',
        devices: [device1, device2],
        stale: false,
      })

      const snapshotBefore = getSnapshot()
      expect(snapshotBefore.stale).toBe(false)

      applyFrame({
        type: 'degraded',
        stale: true,
      })

      const snapshotAfter = getSnapshot()
      // Devices should have stale flag updated
      expect(snapshotAfter.devices).toEqual([
        { ...device1, state: { ...device1.state, stale: true } },
        { ...device2, state: { ...device2.state, stale: true } },
      ])
      expect(snapshotAfter.stale).toBe(true)
    })
  })

  describe('snapshot referential stability', () => {
    it('returns the same object across two getSnapshot calls with no intervening frame', () => {
      const device = makeDevice('light.living_room')

      applyFrame({
        type: 'snapshot',
        devices: [device],
        stale: false,
      })

      const snapshot1 = getSnapshot()
      const snapshot2 = getSnapshot()

      expect(snapshot1).toBe(snapshot2) // referential equality
    })

    it('returns a new object after applying a frame', () => {
      const device = makeDevice('light.living_room')

      applyFrame({
        type: 'snapshot',
        devices: [device],
        stale: false,
      })

      const snapshot1 = getSnapshot()

      applyFrame({
        type: 'degraded',
        stale: true,
      })

      const snapshot2 = getSnapshot()

      expect(snapshot1).not.toBe(snapshot2) // different reference
    })
  })

  describe('malformed frame handling', () => {
    it('ignores a malformed frame and does not throw', () => {
      const device = makeDevice('light.living_room')

      applyFrame({
        type: 'snapshot',
        devices: [device],
        stale: false,
      })

      const snapshotBefore = getSnapshot()

      // Malformed frame - missing required fields
      expect(() => {
        applyFrame({ type: 'snapshot' } as SseFrame)
      }).not.toThrow()

      const snapshotAfter = getSnapshot()
      expect(snapshotAfter).toEqual(snapshotBefore)
    })
  })

  describe('connection state', () => {
    it('tracks connected state', () => {
      setConnected(true)
      expect(getSnapshot().connected).toBe(true)

      setConnected(false)
      expect(getSnapshot().connected).toBe(false)
    })
  })

  describe('connection reference counting', () => {
    it('two callers share one connection', async () => {
      const store = await import('../../src/web/store.js')

      // Mock EventSource
      let eventSourceInstances = 0
      const OriginalEventSource = globalThis.EventSource
      globalThis.EventSource = class FakeEventSource {
        constructor() {
          eventSourceInstances++
        }
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource

      try {
        const teardownA = store.connectDeviceStore()
        const teardownB = store.connectDeviceStore()

        expect(eventSourceInstances).toBe(1) // Only one connection created

        teardownA()
        teardownB()
      } finally {
        globalThis.EventSource = OriginalEventSource
        resetStore()
      }
    })

    it('first teardown leaves second caller with live stream', async () => {
      const store = await import('../../src/web/store.js')

      let eventSourceClosed = false
      const OriginalEventSource = globalThis.EventSource
      globalThis.EventSource = class FakeEventSource {
        addEventListener() {}
        close() {
          eventSourceClosed = true
        }
      } as unknown as typeof EventSource

      try {
        const teardownA = store.connectDeviceStore()
        const teardownB = store.connectDeviceStore()

        teardownA()
        expect(eventSourceClosed).toBe(false) // B still connected

        teardownB()
        expect(eventSourceClosed).toBe(true) // Now closed
      } finally {
        globalThis.EventSource = OriginalEventSource
        resetStore()
      }
    })

    it('connection closes only after both tear down', async () => {
      const store = await import('../../src/web/store.js')

      let eventSourceClosed = false
      const OriginalEventSource = globalThis.EventSource
      globalThis.EventSource = class FakeEventSource {
        addEventListener() {}
        close() {
          eventSourceClosed = true
        }
      } as unknown as typeof EventSource

      try {
        const teardownA = store.connectDeviceStore()
        const teardownB = store.connectDeviceStore()

        teardownA()
        expect(eventSourceClosed).toBe(false)

        teardownB()
        expect(eventSourceClosed).toBe(true)
      } finally {
        globalThis.EventSource = OriginalEventSource
        resetStore()
      }
    })

    it('calling a teardown twice does not over-decrement', async () => {
      const store = await import('../../src/web/store.js')

      let eventSourceClosed = false
      const OriginalEventSource = globalThis.EventSource
      globalThis.EventSource = class FakeEventSource {
        addEventListener() {}
        close() {
          eventSourceClosed = true
        }
      } as unknown as typeof EventSource

      try {
        const teardownA = store.connectDeviceStore()
        const teardownB = store.connectDeviceStore()

        teardownA()
        teardownA() // Double call - should be idempotent
        expect(eventSourceClosed).toBe(false)

        teardownB()
        expect(eventSourceClosed).toBe(true)
      } finally {
        globalThis.EventSource = OriginalEventSource
        resetStore()
      }
    })
  })

  describe('portal frame', () => {
    beforeEach(() => {
      resetStore()
    })

    it('defaults portalEnabled to true', () => {
      expect(getSnapshot().portalEnabled).toBe(true)
    })

    it('applies a portal frame', () => {
      applyFrame({ type: 'portal', enabled: false })
      expect(getSnapshot().portalEnabled).toBe(false)
    })

    it('leaves devices untouched on a portal frame', () => {
      applyFrame({
        type: 'snapshot',
        stale: false,
        devices: [
          {
            entityId: 'light.porch',
            label: 'Porch',
            domain: 'light',
            allowedActions: ['turn_on'],
            sortOrder: 0,
            state: { state: 'off', attributes: {}, stale: false },
          },
        ],
      })

      applyFrame({ type: 'portal', enabled: false })

      expect(getSnapshot().devices).toHaveLength(1)
    })

    it('setPortalEnabled updates the snapshot', () => {
      setPortalEnabled(false)
      expect(getSnapshot().portalEnabled).toBe(false)
    })

    it('snapshot frame does not clobber portalEnabled', () => {
      setPortalEnabled(false)

      applyFrame({
        type: 'snapshot',
        stale: false,
        devices: [
          {
            entityId: 'light.porch',
            label: 'Porch',
            domain: 'light',
            allowedActions: ['turn_on'],
            sortOrder: 0,
            state: { state: 'off', attributes: {}, stale: false },
          },
        ],
      })

      expect(getSnapshot().portalEnabled).toBe(false)
    })

    it('patch frame does not clobber portalEnabled', () => {
      // Set up initial state with a device
      applyFrame({
        type: 'snapshot',
        stale: false,
        devices: [
          {
            entityId: 'light.porch',
            label: 'Porch',
            domain: 'light',
            allowedActions: ['turn_on'],
            sortOrder: 0,
            state: { state: 'off', attributes: {}, stale: false },
          },
        ],
      })

      setPortalEnabled(false)

      const snapshotAfterInit = getSnapshot()
      const device = snapshotAfterInit.devices[0]
      if (!device) throw new Error('device not found')

      const updatedDevice = { ...device, state: { ...device.state, state: 'on' } }
      applyFrame({
        type: 'patch',
        devices: [updatedDevice],
      })

      expect(getSnapshot().portalEnabled).toBe(false)
    })

    it('degraded frame does not clobber portalEnabled', () => {
      // Set up initial state with a device
      applyFrame({
        type: 'snapshot',
        stale: false,
        devices: [
          {
            entityId: 'light.porch',
            label: 'Porch',
            domain: 'light',
            allowedActions: ['turn_on'],
            sortOrder: 0,
            state: { state: 'off', attributes: {}, stale: false },
          },
        ],
      })

      setPortalEnabled(false)

      applyFrame({
        type: 'degraded',
        stale: true,
      })

      expect(getSnapshot().portalEnabled).toBe(false)
    })
  })
})
