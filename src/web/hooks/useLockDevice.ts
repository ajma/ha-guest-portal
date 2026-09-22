import { useEffect, useState } from 'react'
import type { Device } from '@shared/api.js'
import { performAction } from '../api.js'
import { usePortalId } from '../portalContext.js'

export type LockDevice = {
  isLocked: boolean
  isStale: boolean
  pending: boolean
  error: string | null
  label: string
  stateText: string
  canLock: boolean
  canUnlock: boolean
  unlockConfirmPending: boolean
  lock: () => void
  requestUnlock: () => void
  cancelUnlock: () => void
}

type LockAction = 'lock' | 'unlock'

const UNLOCK_CONFIRM_TIMEOUT_MS = 5000

export function useLockDevice(device: Device, disabled: boolean): LockDevice {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [unlockConfirmPending, setUnlockConfirmPending] = useState(false)
  const portalId = usePortalId()

  const isStale = device.state.stale
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
    if (pending || disabled) return

    setError(null)
    setPending(true)

    try {
      const result = await performAction(device.entityId, action, portalId)

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

  // Render state text
  function getStateText(): string {
    if (isStale) return 'Unknown'
    if (pending) return 'Updating...'
    if (currentState === 'locked') return 'Locked'
    if (currentState === 'unlocked') return 'Unlocked'
    if (currentState === 'unlocking') return 'Unlocking'
    if (currentState === 'locking') return 'Locking'
    if (currentState === 'jammed') return 'Jammed'
    if (currentState === 'open') return 'Open'
    if (currentState === 'opening') return 'Opening'
    return currentState
  }

  return {
    isLocked: currentState === 'locked',
    isStale,
    pending,
    error,
    label: device.label,
    stateText: getStateText(),
    canLock,
    canUnlock,
    unlockConfirmPending,
    lock: handleLockClick,
    requestUnlock: handleUnlockClick,
    cancelUnlock: handleCancelUnlock,
  }
}
