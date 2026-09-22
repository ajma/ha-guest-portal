import { useSyncExternalStore } from 'react'
import type { Device, SseFrame } from '@shared/api.js'
import { SseFrameSchema } from '@shared/api.js'
import { apiUrl } from './basePath.js'

export type DeviceStoreSnapshot = {
  devices: Device[]
  stale: boolean
  connected: boolean
  portalEnabled: boolean
}

// Internal state
let snapshot: DeviceStoreSnapshot = {
  devices: [],
  stale: false,
  connected: false,
  portalEnabled: true,
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
  }
  subscribers.clear()
  if (eventSource !== null) {
    eventSource.close()
    eventSource = null
  }
  connectionRefCount = 0
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
    // Check if EventSource is available (not available in some test environments)
    if (typeof EventSource === 'undefined') {
      // In test environment without EventSource, just set disconnected
      setConnected(false)
    } else {
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
      // with them: left true, those tiles render live rather than greyed.
      snapshot = { ...snapshot, devices: [], stale: false, connected: false }
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
