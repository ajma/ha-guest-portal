import { useEffect, useState, type ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { performAction } from '../api.js'
import { StaleBadge } from './StaleBadge.js'

type LockTileProps = {
  device: Device
  disabled: boolean
}

type LockAction = 'lock' | 'unlock'

const UNLOCK_CONFIRM_TIMEOUT_MS = 5000

export function LockTile({ device, disabled }: LockTileProps): ReactElement {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [unlockConfirmPending, setUnlockConfirmPending] = useState(false)

  const isStale = device.state.stale || disabled
  const currentState = device.state.state

  // Determine which actions are allowed
  const canLock = device.allowedActions.includes('lock')
  const canUnlock = device.allowedActions.includes('unlock')

  // Timeout for unlock confirmation
  useEffect(() => {
    if (!unlockConfirmPending) return

    const timeoutId = setTimeout(() => {
      setUnlockConfirmPending(false)
    }, UNLOCK_CONFIRM_TIMEOUT_MS)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [unlockConfirmPending])

  async function handleAction(action: LockAction): Promise<void> {
    if (pending || isStale) return

    setError(null)
    setPending(true)

    try {
      const result = await performAction(device.entityId, action)

      if (!result.ok) {
        setError('Action failed')
      }
    } finally {
      setPending(false)
      setUnlockConfirmPending(false)
    }
  }

  function handleLockClick(): void {
    void handleAction('lock')
  }

  function handleUnlockClick(): void {
    if (unlockConfirmPending) {
      // Confirm the unlock
      void handleAction('unlock')
    } else {
      // Enter confirmation state
      setUnlockConfirmPending(true)
    }
  }

  function handleCancelUnlock(): void {
    setUnlockConfirmPending(false)
  }

  return (
    <div className="p-6 border-2 border-orange-500 dark:border-orange-600 rounded-lg bg-white dark:bg-gray-800 shadow-md">
      <div className="mb-4">
        <div className="font-bold text-xl">{device.label}</div>
        <div className="text-base text-gray-700 dark:text-gray-300">
          {isStale ? 'Unknown' : pending ? 'Updating...' : currentState === 'locked' ? 'Locked' : 'Unlocked'}
        </div>
      </div>

      {unlockConfirmPending ? (
        <div className="space-y-2" aria-live="polite">
          <div className="text-sm font-medium text-orange-600 dark:text-orange-400">
            Confirm unlock?
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleUnlockClick}
              disabled={pending || isStale}
              aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
              className="flex-1 py-3 px-4 rounded-lg bg-orange-600 text-white font-semibold hover:bg-orange-700 active:bg-orange-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirm Unlock
            </button>
            <button
              type="button"
              onClick={handleCancelUnlock}
              disabled={pending || isStale}
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
              onClick={handleLockClick}
              disabled={pending || isStale}
              aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
              className={`flex-1 py-3 px-4 rounded-lg font-semibold disabled:cursor-not-allowed ${
                isStale
                  ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
                  : 'bg-gray-600 text-white hover:bg-gray-700 active:bg-gray-800 dark:bg-gray-600 dark:hover:bg-gray-700'
              }`}
            >
              Lock
            </button>
          )}

          {canUnlock && (
            <button
              type="button"
              onClick={handleUnlockClick}
              disabled={pending || isStale}
              aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
              className={`flex-1 py-3 px-4 rounded-lg font-semibold disabled:cursor-not-allowed ${
                isStale
                  ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
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
        <div id={`${device.entityId}-error`} className="text-sm text-red-600 dark:text-red-400 mt-2">
          {error}
        </div>
      )}
    </div>
  )
}
