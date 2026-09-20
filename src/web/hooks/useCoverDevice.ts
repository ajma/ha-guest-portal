import { useState } from 'react'
import type { Device } from '@shared/api.js'
import { performAction } from '../api.js'

export type CoverDevice = {
  isStale: boolean
  pending: boolean
  error: string | null
  label: string
  stateText: string
  canOpen: boolean
  canClose: boolean
  canStop: boolean
  open: () => void
  close: () => void
  stop: () => void
}

type CoverAction = 'open_cover' | 'close_cover' | 'stop_cover'

export function useCoverDevice(device: Device, disabled: boolean): CoverDevice {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const isStale = device.state.stale
  const currentState = device.state.state

  // Determine which actions are allowed
  const canOpen = device.allowedActions.includes('open_cover')
  const canClose = device.allowedActions.includes('close_cover')
  const canStop = device.allowedActions.includes('stop_cover')

  async function handleAction(action: CoverAction): Promise<void> {
    if (pending || disabled) return

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

  return {
    isStale,
    pending,
    error,
    label: device.label,
    stateText: getStateText(),
    canOpen,
    canClose,
    canStop,
    open: () => {
      void handleAction('open_cover')
    },
    close: () => {
      void handleAction('close_cover')
    },
    stop: () => {
      void handleAction('stop_cover')
    },
  }
}
