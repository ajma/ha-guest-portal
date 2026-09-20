import { useEffect, useRef, useState } from 'react'
import type { Device } from '@shared/api.js'
import { performAction } from '../api.js'

export type ToggleDevice = {
  isOn: boolean
  isStale: boolean
  pending: boolean
  error: string | null
  label: string
  stateText: string
  canActivate: boolean
  activate: () => void
}

export function useToggleDevice(device: Device, disabled: boolean): ToggleDevice {
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
  const isStale = device.state.stale

  // Determine which action to use based on allowedActions
  const canTurnOn = device.allowedActions.includes('turn_on')
  const canTurnOff = device.allowedActions.includes('turn_off')
  const canToggle = device.allowedActions.includes('toggle')

  async function handleClick(): Promise<void> {
    if (pending || disabled) return

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

  // Derived presentation values
  const stateText = isStale ? 'Unknown' : pending ? 'Updating...' : isOn ? 'On' : 'Off'
  const canActivate = canTurnOn || canTurnOff || canToggle

  return {
    isOn,
    isStale,
    pending,
    error,
    label: device.label,
    stateText,
    canActivate,
    activate: handleClick,
  }
}
