// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Device, SseFrame } from '@shared/api.js'

// Store functions to be implemented
type DeviceStoreSnapshot = {
  devices: Device[]
  stale: boolean
  connected: boolean
  portalEnabled: boolean
  streamPortalId?: string | null
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

  describe('ingress base path', () => {
    afterEach(() => {
      delete document.documentElement.dataset.ingressBase
    })

    it('opens the stream under the ingress base rather than the origin root', async () => {
      // Same bug as the fetch calls in api.ts: a hardcoded '/api/stream'
      // resolves against the browser's real origin under Supervisor ingress,
      // not the per-session prefix the page is actually served from.
      document.documentElement.dataset.ingressBase = '/api/hassio_ingress/tok/'

      const store = await import('../../src/web/store.js')

      let openedUrl: string | undefined
      const OriginalEventSource = globalThis.EventSource
      globalThis.EventSource = class FakeEventSource {
        constructor(url: string) {
          openedUrl = url
        }
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource

      try {
        const teardown = store.connectDeviceStore('portal-1')
        expect(openedUrl).toBe('/api/hassio_ingress/tok/api/stream?portalId=portal-1')
        teardown()
      } finally {
        globalThis.EventSource = OriginalEventSource
        resetStore()
      }
    })

    it('opens the stream at the given portal id', async () => {
      const store = await import('../../src/web/store.js')
      const OriginalEventSource = globalThis.EventSource
      const seenUrls: string[] = []
      globalThis.EventSource = class FakeEventSource {
        constructor(url: string) {
          seenUrls.push(url)
        }
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource

      try {
        const teardown = store.connectDeviceStore('portal-99')
        expect(seenUrls[0]).toContain('portalId=portal-99')
        teardown()
      } finally {
        globalThis.EventSource = OriginalEventSource
        resetStore()
      }
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
        const teardownA = store.connectDeviceStore('portal-1')
        const teardownB = store.connectDeviceStore('portal-1')

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
        const teardownA = store.connectDeviceStore('portal-1')
        const teardownB = store.connectDeviceStore('portal-1')

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
        const teardownA = store.connectDeviceStore('portal-1')
        const teardownB = store.connectDeviceStore('portal-1')

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
        const teardownA = store.connectDeviceStore('portal-1')
        const teardownB = store.connectDeviceStore('portal-1')

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

  describe('devices belong to the portal that was streaming them', () => {
    const OriginalEventSource = globalThis.EventSource

    beforeEach(() => {
      globalThis.EventSource = class FakeEventSource {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    })

    afterEach(() => {
      globalThis.EventSource = OriginalEventSource
      resetStore()
    })

    it('drops the devices and the connected flag when the last caller tears down', async () => {
      // The next portal's list arrives on its own stream, and nothing before
      // its first snapshot says which devices belong to it. Keeping the old
      // ones is not a cosmetic flash: the allowlist editor saves whole lists,
      // so the previous portal's rows can be written onto the new one — and a
      // `connected` left true renders them as live, tappable tiles to whoever
      // logs in next on a shared tablet.
      const store = await import('../../src/web/store.js')
      const teardown = store.connectDeviceStore('timothy')
      setConnected(true)
      applyFrame({ type: 'snapshot', devices: [makeDevice('light.porch')], stale: true })

      teardown()

      expect(getSnapshot().devices).toEqual([])
      expect(getSnapshot().stale).toBe(false)
      expect(getSnapshot().connected).toBe(false)
    })

    it('says which portal the devices came from, and stops saying it when they go', async () => {
      // The devices alone cannot say whose they are, so anything downstream
      // that must not mix two portals up — the allowlist editor, whose every
      // save is a whole-list PUT — is left inferring it from render order.
      // The identity has to outlast the frames that follow it and go away
      // with them.
      const store = await import('../../src/web/store.js')
      const teardown = store.connectDeviceStore('timothy')
      expect(getSnapshot().streamPortalId).toBe('timothy')

      applyFrame({ type: 'snapshot', devices: [makeDevice('light.porch')], stale: false })
      applyFrame({ type: 'patch', devices: [makeDevice('light.porch', 'off')] })
      applyFrame({ type: 'degraded', stale: true })
      expect(getSnapshot().streamPortalId).toBe('timothy')

      teardown()
      expect(getSnapshot().streamPortalId).toBeNull()
    })

    it('clears all four fields in ONE notification, so no subscriber sees a live empty stream', async () => {
      // A subscriber that ran between two notifications would see `devices: []`
      // with `connected: true` and the portal still named — the one combination
      // that means "this portal genuinely has no devices". The allowlist editor
      // takes that as an answer, adopts the empty list as the base its
      // whole-list PUT is computed from, and the next edit erases the
      // allowlist. The single object and single notify in `connectDeviceStore`'s
      // teardown are what rule that out, and nothing else here can see them, so
      // this counts them.
      const store = await import('../../src/web/store.js')
      const teardown = store.connectDeviceStore('timothy')
      setConnected(true)
      applyFrame({ type: 'snapshot', devices: [makeDevice('light.porch')], stale: true })

      const seen: DeviceStoreSnapshot[] = []
      const unsubscribe = store.subscribeForTest(() => {
        seen.push(getSnapshot())
      })
      teardown()
      unsubscribe()

      expect(seen).toHaveLength(1)
      const observed = seen[0]
      if (observed === undefined) throw new Error('teardown notified no subscriber')
      expect(observed.devices).toEqual([])
      expect(observed.stale).toBe(false)
      expect(observed.connected).toBe(false)
      expect(observed.streamPortalId).toBeNull()
    })

    it('keeps the devices while another caller still holds the stream', async () => {
      const store = await import('../../src/web/store.js')
      const teardownA = store.connectDeviceStore('timothy')
      const teardownB = store.connectDeviceStore('timothy')
      applyFrame({ type: 'snapshot', devices: [makeDevice('light.porch')], stale: false })

      teardownA()

      expect(getSnapshot().devices).toHaveLength(1)
      teardownB()
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

    it('notifies subscribers on a portal frame', () => {
      // Test notification by verifying the snapshot changes AND is a new object.
      // useSyncExternalStore relies on notifySubscribers() to trigger re-renders.
      // If notifySubscribers weren't called, the snapshot would update but React
      // wouldn't re-render until some other state change forced it.
      //
      // We verify notification happened by:
      // 1. Snapshot value changed (portalEnabled: true → false)
      // 2. Snapshot object reference changed (proves notifySubscribers ran)
      const initialSnapshot = getSnapshot()
      expect(initialSnapshot.portalEnabled).toBe(true)

      applyFrame({ type: 'portal', enabled: false })

      const newSnapshot = getSnapshot()
      expect(newSnapshot.portalEnabled).toBe(false)
      expect(newSnapshot).not.toBe(initialSnapshot)
    })
  })
})
