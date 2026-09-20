import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useLockDevice } from '../../hooks/useLockDevice.js'
import type { TileProps } from '../types.js'
import { icon } from './icons.js'

export function LockTile({ device, disabled }: TileProps): ReactElement {
  const d = useLockDevice(device, disabled)
  const domain = parseDomain(device.entityId)
  const inactive = disabled || d.pending || d.isStale

  function actionClass(danger: boolean): string {
    if (inactive) return 'bg-[var(--surfaceActive)] text-[var(--textMuted)]'
    return danger
      ? 'bg-[var(--danger)] text-[var(--accentText)]'
      : 'bg-[var(--accent)] text-[var(--accentText)]'
  }

  return (
    <div className="p-[var(--tilePadding)] rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <div className="flex items-center gap-3">
        <span className="flex items-center justify-center shrink-0 w-10 h-10 rounded-full bg-[var(--surfaceActive)] text-[var(--textMuted)]">
          {domain !== null && icon(domain, d.isLocked ? 'locked' : 'unlocked')}
        </span>

        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--text)] truncate">{d.label}</div>
          <div className="text-sm text-[var(--textMuted)]">{d.stateText}</div>
        </div>

        {d.unlockConfirmPending ? (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={d.requestUnlock}
              disabled={d.pending || disabled}
              aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
              className={`py-2 px-3 text-sm font-semibold rounded-[var(--tileRadius)] disabled:opacity-50 disabled:cursor-not-allowed ${actionClass(true)}`}
            >
              Confirm Unlock
            </button>
            <button
              type="button"
              onClick={d.cancelUnlock}
              disabled={d.pending || disabled}
              className="py-2 px-3 text-sm font-semibold rounded-[var(--tileRadius)] bg-[var(--surfaceActive)] text-[var(--text)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 gap-1">
            {d.canLock && (
              <button
                type="button"
                onClick={d.lock}
                disabled={d.pending || disabled}
                aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
                className={`py-2 px-3 text-sm font-semibold rounded-[var(--tileRadius)] disabled:cursor-not-allowed ${actionClass(false)}`}
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
                className={`py-2 px-3 text-sm font-semibold rounded-[var(--tileRadius)] disabled:cursor-not-allowed ${actionClass(true)}`}
              >
                Unlock
              </button>
            )}
          </div>
        )}
      </div>

      {d.unlockConfirmPending && (
        <div aria-live="polite" className="text-sm font-medium text-[var(--danger)] mt-2">
          Confirm unlock?
        </div>
      )}
      {d.isStale && (
        <div className="text-sm text-[var(--textMuted)] mt-2">Not connected to Home Assistant</div>
      )}
      {d.error !== null && (
        <div id={`${device.entityId}-error`} className="text-sm text-[var(--danger)] mt-2">
          {d.error}
        </div>
      )}
    </div>
  )
}
