import { useState, type ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { performAction } from '../api.js'
import { StaleBadge } from './StaleBadge.js'

type CoverTileProps = {
  device: Device
  disabled: boolean
}

type CoverAction = 'open_cover' | 'close_cover' | 'stop_cover'

export function CoverTile({ device, disabled }: CoverTileProps): ReactElement {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const isStale = device.state.stale || disabled
  const currentState = device.state.state

  // Determine which actions are allowed
  const canOpen = device.allowedActions.includes('open_cover')
  const canClose = device.allowedActions.includes('close_cover')
  const canStop = device.allowedActions.includes('stop_cover')

  async function handleAction(action: CoverAction): Promise<void> {
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
    }
  }

  // Render state text
  function getStateText(): string {
    if (isStale) return 'Unknown'
    if (pending) return 'Updating...'
    if (currentState === 'opening') return 'Opening'
    if (currentState === 'closing') return 'Closing'
    if (currentState === 'open') return 'Open'
    if (currentState === 'closed') return 'Closed'
    return currentState
  }

  return (
    <div className="p-4 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      <div className="mb-3">
        <div className="font-semibold text-lg">{device.label}</div>
        <div className="text-base text-gray-700 dark:text-gray-300">{getStateText()}</div>
      </div>

      <div className="flex gap-2">
        {canOpen && (
          <button
            type="button"
            onClick={() => {
              void handleAction('open_cover')
            }}
            disabled={pending || isStale}
            aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-lg font-medium disabled:cursor-not-allowed ${
              isStale
                ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
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
              void handleAction('stop_cover')
            }}
            disabled={pending || isStale}
            aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-lg font-medium disabled:cursor-not-allowed ${
              isStale
                ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
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
              void handleAction('close_cover')
            }}
            disabled={pending || isStale}
            aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-lg font-medium disabled:cursor-not-allowed ${
              isStale
                ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
                : 'bg-gray-600 text-white hover:bg-gray-700 active:bg-gray-800 dark:bg-gray-600 dark:hover:bg-gray-700'
            }`}
          >
            Close
          </button>
        )}
      </div>

      {isStale && <StaleBadge />}
      {error !== null && (
        <div id={`${device.entityId}-error`} className="text-sm text-red-600 dark:text-red-400 mt-1">
          {error}
        </div>
      )}
    </div>
  )
}
