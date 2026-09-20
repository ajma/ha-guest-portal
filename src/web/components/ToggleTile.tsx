import type { ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { useToggleDevice } from '../hooks/useToggleDevice.js'
import { StaleBadge } from './StaleBadge.js'

type ToggleTileProps = {
  device: Device
  disabled: boolean
}

export function ToggleTile({ device, disabled }: ToggleTileProps): ReactElement {
  const { isOn, isStale, pending, error, activate, canActivate } = useToggleDevice(device, disabled)

  // Don't render if no valid actions
  if (!canActivate) {
    return (
      <div className="p-4 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
        <div className="font-semibold text-lg">{device.label}</div>
        <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">No actions available</div>
      </div>
    )
  }

  return (
    <div className="p-4 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      <button
        type="button"
        onClick={() => {
          void activate()
        }}
        disabled={pending || disabled}
        aria-label={device.label}
        aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
        className={`
          w-full min-h-24 p-4 rounded-lg font-semibold text-lg
          transition-colors duration-150
          disabled:cursor-not-allowed
          ${
            disabled
              ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
              : isStale
                ? 'bg-gray-300 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                : isOn
                  ? 'bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-700'
                  : 'bg-gray-200 text-gray-900 hover:bg-gray-300 active:bg-gray-400 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600'
          }
        `}
      >
        <div>{device.label}</div>
        <div className="text-base font-normal mt-1">
          {isStale ? 'Unknown' : pending ? 'Updating...' : isOn ? 'On' : 'Off'}
        </div>
      </button>
      {isStale && <StaleBadge />}
      {error !== null && (
        <div
          id={`${device.entityId}-error`}
          className="text-sm text-red-600 dark:text-red-400 mt-1"
        >
          {error}
        </div>
      )}
    </div>
  )
}
