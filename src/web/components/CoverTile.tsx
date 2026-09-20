import type { ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { useCoverDevice } from '../hooks/useCoverDevice.js'
import { StaleBadge } from './StaleBadge.js'

type CoverTileProps = {
  device: Device
  disabled: boolean
}

export function CoverTile({ device, disabled }: CoverTileProps): ReactElement {
  const { isStale, pending, error, stateText, canOpen, canClose, canStop, open, close, stop } =
    useCoverDevice(device, disabled)

  return (
    <div className="p-4 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      <div className="mb-3">
        <div className="font-semibold text-lg">{device.label}</div>
        <div className="text-base text-gray-700 dark:text-gray-300">{stateText}</div>
      </div>

      <div className="flex gap-2">
        {canOpen && (
          <button
            type="button"
            onClick={() => {
              void open()
            }}
            disabled={pending || disabled}
            aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-lg font-medium disabled:cursor-not-allowed ${
              disabled
                ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
                : isStale
                  ? 'bg-gray-400 text-gray-700 dark:bg-gray-600 dark:text-gray-300'
                  : 'bg-gray-600 text-white hover:bg-gray-700 active:bg-gray-800 dark:bg-gray-600 dark:hover:bg-gray-700'
            }`}
          >
            Open
          </button>
        )}

        {canStop && (
          <button
            type="button"
            onClick={() => {
              void stop()
            }}
            disabled={pending || disabled}
            aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-lg font-medium disabled:cursor-not-allowed ${
              disabled
                ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
                : isStale
                  ? 'bg-gray-400 text-gray-700 dark:bg-gray-600 dark:text-gray-300'
                  : 'bg-gray-500 text-white hover:bg-gray-600 active:bg-gray-700'
            }`}
          >
            Stop
          </button>
        )}

        {canClose && (
          <button
            type="button"
            onClick={() => {
              void close()
            }}
            disabled={pending || disabled}
            aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-lg font-medium disabled:cursor-not-allowed ${
              disabled
                ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
                : isStale
                  ? 'bg-gray-400 text-gray-700 dark:bg-gray-600 dark:text-gray-300'
                  : 'bg-gray-600 text-white hover:bg-gray-700 active:bg-gray-800 dark:bg-gray-600 dark:hover:bg-gray-700'
            }`}
          >
            Close
          </button>
        )}
      </div>

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
