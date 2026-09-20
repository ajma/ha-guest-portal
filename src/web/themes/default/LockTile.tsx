import type { ReactElement } from 'react'
import { useLockDevice } from '../../hooks/useLockDevice.js'
import type { TileProps } from '../types.js'

export function LockTile({ device, disabled }: TileProps): ReactElement {
  const d = useLockDevice(device, disabled)

  const inactive = disabled || d.pending || d.isStale
  function actionClass(danger: boolean): string {
    if (inactive) return 'bg-[var(--surfaceActive)] text-[var(--textMuted)]'
    return danger
      ? 'bg-[var(--danger)] text-[var(--accentText)]'
      : 'bg-[var(--accent)] text-[var(--accentText)]'
  }

  return (
    <div className="p-[var(--tilePadding)] rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <div className="mb-4">
        <div className="font-bold text-xl text-[var(--text)]">{d.label}</div>
        <div className="text-base text-[var(--textMuted)]">{d.stateText}</div>
      </div>

      {d.unlockConfirmPending ? (
        <div className="space-y-2" aria-live="polite">
          <div className="text-sm font-medium text-[var(--danger)]">Confirm unlock?</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={d.requestUnlock}
              disabled={d.pending || disabled}
              aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
              className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${actionClass(true)}`}
            >
              Confirm Unlock
            </button>
            <button
              type="button"
              onClick={d.cancelUnlock}
              disabled={d.pending || disabled}
              className="flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-semibold disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--surfaceActive)] text-[var(--text)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {d.canLock && (
            <button
              type="button"
              onClick={d.lock}
              disabled={d.pending || disabled}
              aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
              className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-semibold disabled:cursor-not-allowed ${actionClass(false)}`}
            >
              Lock
            </button>
          )}

          {d.canUnlock && (
            <button
              type="button"
              onClick={d.requestUnlock}
              disabled={d.pending || disabled}
              aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
              className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-semibold disabled:cursor-not-allowed ${actionClass(true)}`}
            >
              Unlock
            </button>
          )}
        </div>
      )}

      {d.isStale && (
        <div className="text-sm text-[var(--textMuted)] mt-1">Not connected to Home Assistant</div>
      )}
      {d.error !== null && (
        <div id={`${device.entityId}-error`} className="text-sm text-[var(--danger)] mt-2">
          {d.error}
        </div>
      )}
    </div>
  )
}
