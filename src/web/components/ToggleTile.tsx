import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { Device } from '@shared/api.js'
import { performAction } from '../api.js'
import { StaleBadge } from './StaleBadge.js'

type ToggleTileProps = {
  device: Device
  disabled: boolean
}

export function ToggleTile({ device, disabled }: ToggleTileProps): ReactElement {
  const [optimisticState, setOptimisticState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const deviceStateRef = useRef(device.state)

  // Clear optimistic state when device state changes (any patch), on disconnect, or after timeout
  useEffect(() => {
    // Clear on disconnect
    if (disabled && optimisticState !== null) {
      setOptimisticState(null)
      deviceStateRef.current = device.state
      return
    }

    // Clear when device.state object reference changes (patch arrived)
    if (optimisticState !== null && device.state !== deviceStateRef.current) {
      setOptimisticState(null)
    }
    deviceStateRef.current = device.state

    // Timeout backstop: clear after 5s if no patch arrives
    if (optimisticState === null) return undefined

    const timeoutId = setTimeout(() => {
      setOptimisticState(null)
    }, 5000)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [device.state, disabled, optimisticState])

  // Use optimistic state if present, otherwise use actual state
  const displayState = optimisticState ?? device.state.state
  const isOn = displayState === 'on'
  const isStale = device.state.stale || disabled

  // Determine which action to use based on allowedActions
  const canTurnOn = device.allowedActions.includes('turn_on')
  const canTurnOff = device.allowedActions.includes('turn_off')
  const canToggle = device.allowedActions.includes('toggle')

  // Don't render if no valid actions
  if (!canTurnOn && !canTurnOff && !canToggle) {
    return <div className="p-4 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      <div className="font-semibold text-lg">{device.label}</div>
      <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">No actions available</div>
    </div>
  }

  async function handleClick(): Promise<void> {
    if (pending || isStale) return

    setError(null)
    const targetState = isOn ? 'off' : 'on'

    // Choose action based on allowedActions
    let action: string
    if (isOn && canTurnOff) {
      action = 'turn_off'
    } else if (!isOn && canTurnOn) {
      action = 'turn_on'
    } else if (canToggle) {
      action = 'toggle'
    } else {
      // Shouldn't happen given the check above, but be safe
      return
    }

    // Optimistic update
    setOptimisticState(targetState)
    setPending(true)

    try {
      const result = await performAction(device.entityId, action)

      if (!result.ok) {
        // Revert optimistic update
        setOptimisticState(null)
        setError('Action failed')
      }
      // On success, keep optimistic state until patch arrives or timeout
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="p-4 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      <button
        type="button"
        onClick={() => {
          void handleClick()
        }}
        disabled={pending || isStale}
        aria-label={device.label}
        aria-describedby={error !== null ? `${device.entityId}-error` : undefined}
        className={`
          w-full min-h-24 p-4 rounded-lg font-semibold text-lg
          transition-colors duration-150
          disabled:cursor-not-allowed
          ${
            isStale
              ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-500'
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
        <div id={`${device.entityId}-error`} className="text-sm text-red-600 dark:text-red-400 mt-1">
          {error}
        </div>
      )}
    </div>
  )
}
