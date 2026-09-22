import { useSyncExternalStore } from 'react'
import type { Device, SseFrame } from '@shared/api.js'
import { SseFrameSchema } from '@shared/api.js'
import { apiUrl } from './basePath.js'

export type DeviceStoreSnapshot = {
  devices: Device[]
  stale: boolean
  connected: boolean
  portalEnabled: boolean
  /**
   * The portal whose stream produced `devices`, or null when no stream is
   * open. Without it, nothing downstream can say which portal the devices it
   * is holding describe, and a consumer that needs to know — the allowlist
   * editor, whose every save is a whole-list PUT — has to infer it from the
   * order renders happen to land in. Every portal-crossing bug in this area
   * has come from that inference.
   *
   * Optional only so that a test double for `useDeviceStore` may omit it;
   * `StoreState` below requires it, so the store itself can never lose it.
   * Read it as `?? null`: absent and null both mean "no stream to speak of".
   */
  streamPortalId?: string | null
}

/**
 * What the store actually holds. Every snapshot it builds must name the portal
 * it describes, and several are built field by field rather than by spreading
 * — typed as `DeviceStoreSnapshot` those would silently drop the identity on
 * the next frame, which is worse than never having had it.
 */
type StoreState = DeviceStoreSnapshot & { streamPortalId: string | null }

// Internal state
let snapshot: StoreState = {
  devices: [],
  stale: false,
  connected: false,
  portalEnabled: true,
  streamPortalId: null,
}

const subscribers = new Set<() => void>()

// EventSource connection
let eventSource: EventSource | null = null
let connectionRefCount = 0

// Exported for testing only
export function resetStore(): void {
  snapshot = {
    devices: [],
    stale: false,
    connected: false,
    portalEnabled: true,
    streamPortalId: null,
  }
  subscribers.clear()
  if (eventSource !== null) {
    eventSource.close()
    eventSource = null
  }
  connectionRefCount = 0
}

/**
 * Exported for testing only: subscribe outside React, and count.
 *
 * `useSyncExternalStore` is the only production subscriber and React batches
 * notifications, so from a `renderHook` subscriber an intermediate snapshot
 * between two `notifySubscribers()` calls is invisible. That intermediate is
 * exactly the state the teardown must never publish — an empty device list on
 * a stream still claiming to be live and named reads as "this portal has no
 * devices" and licenses a save that erases the allowlist. Seeing it takes a
 * raw subscriber; `notifySubscribers` is private and `getSnapshot` is wired
 * into `useSyncExternalStore` through a local binding, so neither can be
 * spied on from a test.
 */
export function subscribeForTest(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    subscriber()
  }
}

// Exported for testing
export function applyFrame(frame: SseFrame): void {
  // Validate the frame
  const parseResult = SseFrameSchema.safeParse(frame)
  if (!parseResult.success) {
    // Malformed frame - ignore it
    return
  }

  const validFrame = parseResult.data

  if (validFrame.type === 'snapshot') {
    // Replace the device list wholesale
    snapshot = {
      devices: validFrame.devices,
      stale: validFrame.stale,
      connected: snapshot.connected,
      portalEnabled: snapshot.portalEnabled,
      streamPortalId: snapshot.streamPortalId,
    }
    notifySubscribers()
  } else if (validFrame.type === 'patch') {
    // Update only the named devices, preserving references and order
    const patchMap = new Map(validFrame.devices.map((d) => [d.entityId, d]))

    const updatedDevices = snapshot.devices.map((device) => {
      const patched = patchMap.get(device.entityId)
      return patched ?? device
    })

    snapshot = {
      devices: updatedDevices,
      stale: snapshot.stale,
      connected: snapshot.connected,
      portalEnabled: snapshot.portalEnabled,
      streamPortalId: snapshot.streamPortalId,
    }
    notifySubscribers()
  } else if (validFrame.type === 'degraded') {
    // Set stale on all devices
    const updatedDevices = snapshot.devices.map((device) => ({
      ...device,
      state: {
        ...device.state,
        stale: validFrame.stale,
      },
    }))

    snapshot = {
      devices: updatedDevices,
      stale: validFrame.stale,
      connected: snapshot.connected,
      portalEnabled: snapshot.portalEnabled,
      streamPortalId: snapshot.streamPortalId,
    }
    notifySubscribers()
  } else if (validFrame.type === 'portal') {
    snapshot = {
      ...snapshot,
      portalEnabled: validFrame.enabled,
    }
    notifySubscribers()
  }
}

// Exported for testing
export function setConnected(connected: boolean): void {
  snapshot = {
    ...snapshot,
    connected,
  }
  notifySubscribers()
}

// Exported so App can seed the value from /api/session. Guests have their
// stream closed when the portal is disabled, so they cannot rely on the
// 'portal' SSE frame; the session response is their source of truth.
export function setPortalEnabled(enabled: boolean): void {
  snapshot = {
    ...snapshot,
    portalEnabled: enabled,
  }
  notifySubscribers()
}

// Exported for testing
export function getSnapshot(): DeviceStoreSnapshot {
  return snapshot
}

export function connectDeviceStore(portalId: string): () => void {
  connectionRefCount++

  // Create EventSource on 0→1 transition
  if (connectionRefCount === 1) {
    // Name the portal before its first frame can arrive. The devices that
    // follow describe this portal and nothing else in the snapshot says so;
    // a consumer left to work it out from render order gets it wrong exactly
    // when a frame and a portal switch land in the same batch.
    //
    // Check if EventSource is available (not available in some test environments)
    if (typeof EventSource === 'undefined') {
      // In test environment without EventSource, just set disconnected — in
      // the same object as the identity, so no subscriber ever sees one
      // without the other.
      snapshot = { ...snapshot, streamPortalId: portalId, connected: false }
      notifySubscribers()
    } else {
      snapshot = { ...snapshot, streamPortalId: portalId }
      notifySubscribers()

      eventSource = new EventSource(apiUrl(`/api/stream?portalId=${encodeURIComponent(portalId)}`), {
        withCredentials: true,
      })

      eventSource.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data)
          applyFrame(data)
        } catch {
          // Malformed JSON - ignore
        }
      })

      eventSource.addEventListener('error', () => {
        setConnected(false)
      })

      eventSource.addEventListener('open', () => {
        setConnected(true)
      })
    }
  }

  // Return teardown that decrements and is idempotent
  let teardownCalled = false
  return () => {
    if (teardownCalled) return
    teardownCalled = true

    connectionRefCount--

    // Close EventSource on 1→0 transition
    if (connectionRefCount === 0) {
      if (eventSource !== null) {
        eventSource.close()
        eventSource = null
      }

      // The devices in here describe the portal whose stream just closed, and
      // only the next stream's first snapshot can say what the next portal
      // holds. Keeping them would show one portal's devices under another's
      // name — to the owner, whose editor then saves that whole list onto the
      // new portal, and to the next guest on a shared tablet. `connected` goes
      // with them: left true, those tiles render live rather than greyed. So
      // does `streamPortalId` — there is no stream now, and a stale one would
      // let a consumer take the next portal's rows for this portal's.
      //
      // One object and one notification, deliberately: split across two, a
      // subscriber would run against a snapshot claiming a live, named,
      // empty stream, which is the one state that means "this portal has no
      // devices" and licenses a save that erases the allowlist.
      snapshot = {
        ...snapshot,
        devices: [],
        stale: false,
        connected: false,
        streamPortalId: null,
      }
      notifySubscribers()
    }
  }
}

export function useDeviceStore(): DeviceStoreSnapshot {
  return useSyncExternalStore(
    (callback) => {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    getSnapshot,
    getSnapshot, // Server snapshot (same as client for this app)
  )
}
