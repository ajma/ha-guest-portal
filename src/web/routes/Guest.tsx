import { useEffect, useState, type ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { connectDeviceStore, useDeviceStore } from '../store.js'
import { ToggleTile } from '../components/ToggleTile.js'
import { CoverTile } from '../components/CoverTile.js'
import { LockTile } from '../components/LockTile.js'

type GuestProps = {
  onLogout: () => Promise<void>
}

function DeviceTile({ device, disabled }: { device: Device; disabled: boolean }): ReactElement {
  const domain = device.domain

  if (domain === 'light' || domain === 'switch' || domain === 'fan' || domain === 'input_boolean') {
    return <ToggleTile device={device} disabled={disabled} />
  }

  if (domain === 'cover') {
    return <CoverTile device={device} disabled={disabled} />
  }

  if (domain === 'lock') {
    return <LockTile device={device} disabled={disabled} />
  }

  // Fallback for unsupported domains (shouldn't happen)
  return <div>Unsupported device type: {domain}</div>
}

export function Guest({ onLogout }: GuestProps): ReactElement {
  const [loggingOut, setLoggingOut] = useState(false)

  // Connect to the device store on mount
  useEffect(() => {
    const teardown = connectDeviceStore()
    return teardown
  }, [])

  const { devices, connected } = useDeviceStore()

  // Sort devices by sortOrder
  const sortedDevices = [...devices].sort((a, b) => a.sortOrder - b.sortOrder)

  // Tiles should be disabled only if disconnected
  // Stale state is shown visually but controls remain enabled
  const tilesDisabled = !connected

  async function handleLogout(): Promise<void> {
    setLoggingOut(true)
    await onLogout()
  }

  return (
    <div data-testid="guest-screen" className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Guest Portal</h1>
        <button
          type="button"
          onClick={() => {
            void handleLogout()
          }}
          disabled={loggingOut}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loggingOut ? 'Logging out...' : 'Log out'}
        </button>
      </div>

      {sortedDevices.length === 0 ? (
        <p className="text-gray-600 dark:text-gray-400">No devices available</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-7xl">
          {sortedDevices.map((device) => (
            <DeviceTile key={device.entityId} device={device} disabled={tilesDisabled} />
          ))}
        </div>
      )}
    </div>
  )
}
