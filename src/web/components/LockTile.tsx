import type { ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { useLockDevice } from '../hooks/useLockDevice.js'
import { StaleBadge } from './StaleBadge.js'

type LockTileProps = {
  device: Device
  disabled: boolean
}

export function LockTile({ device, disabled }: LockTileProps): ReactElement {
  const { isStale, pending, error, stateText, canLock, canUnlock, unlockConfirmPending, lock, requestUnlock, cancelUnlock } =
    useLockDevice(device, disabled)

  return (
    <div className="p-6 border-2 border-orange-500 dark:border-orange-600 rounded-lg bg-white dark:bg-gray-800 shadow-md">
      <div className="mb-4">
        <div className="font-bold text-xl">{device.label}</div>
        <div className="text-base text-gray-700 dark:text-gray-300">{stateText}</div>
      </div>

      {unlockConfirmPending ? (
        <div className="space-y-2" aria-live="polite">
          <div className="text-sm font-medium text-orange-600 dark:text-orange-400">
            Confirm unlock?
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={requestUnlock}
              disabled={pending || disabled}
              aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
              className="flex-1 py-3 px-4 rounded-lg bg-orange-600 text-white font-semibold hover:bg-orange-700 active:bg-orange-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirm Unlock
            </button>
            <button
              type="button"
              onClick={cancelUnlock}
              disabled={pending || disabled}
              className="flex-1 py-3 px-4 rounded-lg bg-gray-500 text-white font-semibold hover:bg-gray-600 active:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {canLock && (
            <button
              type="button"
              onClick={lock}
              disabled={pending || disabled}
              aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
              className={`flex-1 py-3 px-4 rounded-lg font-semibold disabled:cursor-not-allowed ${
                disabled
                  ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
                  : isStale
                    ? 'bg-gray-400 text-gray-700 dark:bg-gray-600 dark:text-gray-300'
                    : 'bg-gray-600 text-white hover:bg-gray-700 active:bg-gray-800 dark:bg-gray-600 dark:hover:bg-gray-700'
              }`}
            >
              Lock
            </button>
          )}

          {canUnlock && (
            <button
              type="button"
              onClick={requestUnlock}
              disabled={pending || disabled}
              aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
              className={`flex-1 py-3 px-4 rounded-lg font-semibold disabled:cursor-not-allowed ${
                disabled
                  ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
                  : isStale
                    ? 'bg-red-400 text-red-900 dark:bg-red-900 dark:text-red-200'
                    : 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 dark:bg-red-600 dark:hover:bg-red-700'
              }`}
            >
              Unlock
            </button>
          )}
        </div>
      )}

      {isStale && <StaleBadge />}
      {error !== null && (
        <div
          id={`${device.entityId}-error`}
          className="text-sm text-red-600 dark:text-red-400 mt-2"
        >
          {error}
        </div>
      )}
    </div>
  )
}
