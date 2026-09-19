import { useSyncExternalStore } from 'react'
import type { Device, SseFrame } from '@shared/api.js'
import { SseFrameSchema } from '@shared/api.js'

export type DeviceStoreSnapshot = {
  devices: Device[]
  stale: boolean
  connected: boolean
}

// Internal state
let snapshot: DeviceStoreSnapshot = {
  devices: [],
  stale: false,
  connected: false,
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
    }
    notifySubscribers()
  } else if (validFrame.type === 'degraded') {
    // Set stale without discarding devices
    snapshot = {
      devices: snapshot.devices,
      stale: validFrame.stale,
      connected: snapshot.connected,
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

// Exported for testing
export function getSnapshot(): DeviceStoreSnapshot {
  return snapshot
}

export function connectDeviceStore(): () => void {
  connectionRefCount++

  // Create EventSource on 0→1 transition
  if (connectionRefCount === 1) {
    eventSource = new EventSource('/api/stream', { withCredentials: true })

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

  // Return teardown that decrements and is idempotent
  let teardownCalled = false
  return () => {
    if (teardownCalled) return
    teardownCalled = true

    connectionRefCount--

    // Close EventSource on 1→0 transition
    if (connectionRefCount === 0 && eventSource !== null) {
      eventSource.close()
      eventSource = null
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
