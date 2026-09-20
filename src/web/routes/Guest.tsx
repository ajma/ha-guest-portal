import { useEffect, useState, type ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { readPortalTitle } from '../portalTitle.js'
import { connectDeviceStore, useDeviceStore } from '../store.js'
import { activeTheme, componentsFor } from '../themes/active.js'
import type { DEFAULT_COMPONENTS } from '../themes/default/index.js'

type GuestProps = {
  onLogout: () => Promise<void>
}

type Components = typeof DEFAULT_COMPONENTS

/**
 * Declared at module scope, not inside `Guest`. A component defined during
 * render is a new type on every render, which remounts the whole grid and
 * throws away each tile's optimistic state.
 */
function DeviceTile({
  device,
  disabled,
  components,
}: {
  device: Device
  disabled: boolean
  components: Components
}): ReactElement {
  const { ToggleTile, CoverTile, LockTile } = components
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

  // The theme supplies the frame and every tile; this route only decides which
  // slot a device belongs in. Reading it per render is free — the slots are
  // stable module-level functions, so React sees the same element types.
  const components = componentsFor(activeTheme())
  const { Shell } = components

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
    <Shell
      title={readPortalTitle()}
      loggingOut={loggingOut}
      onLogout={() => {
        void handleLogout()
      }}
    >
      {sortedDevices.length === 0 ? (
        <p className="text-[var(--textMuted)]">No devices available</p>
      ) : (
        sortedDevices.map((device) => (
          <DeviceTile
            key={device.entityId}
            device={device}
            disabled={tilesDisabled}
            components={components}
          />
        ))
      )}
    </Shell>
  )
}
