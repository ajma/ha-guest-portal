import { useEffect, type ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { connectDeviceStore, useDeviceStore } from '../store.js'
import { ToggleTile } from '../components/ToggleTile.js'
import { CoverTile } from '../components/CoverTile.js'
import { LockTile } from '../components/LockTile.js'

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

export function Guest(): ReactElement {
  // Connect to the device store on mount
  useEffect(() => {
    const teardown = connectDeviceStore()
    return teardown
  }, [])

  const { devices, stale, connected } = useDeviceStore()

  // Sort devices by sortOrder
  const sortedDevices = [...devices].sort((a, b) => a.sortOrder - b.sortOrder)

  // Tiles should be disabled if disconnected or store is stale
  const tilesDisabled = !connected || stale

  return (
    <div data-testid="guest-screen" className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-6">Guest Portal</h1>

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
