import type { ReactElement } from 'react'
import { useCoverDevice } from '../../hooks/useCoverDevice.js'
import type { TileProps } from '../types.js'

export function CoverTile({ device, disabled }: TileProps): ReactElement {
  const d = useCoverDevice(device, disabled)

  const inactive = disabled || d.pending || d.isStale
  const primaryClass = inactive
    ? 'bg-[var(--surfaceActive)] text-[var(--textMuted)]'
    : 'bg-[var(--accent)] text-[var(--accentText)]'
  const secondaryClass = inactive
    ? 'bg-[var(--surfaceActive)] text-[var(--textMuted)]'
    : 'bg-[var(--surfaceActive)] text-[var(--text)]'

  return (
    <div className="p-[var(--tilePadding)] rounded-[var(--tileRadius)] bg-[var(--surface)] border border-[var(--border)]">
      <div className="mb-3">
        <div className="font-semibold text-lg text-[var(--text)]">{d.label}</div>
        <div className="text-base text-[var(--textMuted)]">{d.stateText}</div>
      </div>

      <div className="flex gap-2">
        {d.canOpen && (
          <button
            type="button"
            onClick={d.open}
            disabled={d.pending || disabled}
            aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-medium disabled:cursor-not-allowed ${primaryClass}`}
          >
            Open
          </button>
        )}

        {d.canStop && (
          <button
            type="button"
            onClick={d.stop}
            disabled={d.pending || disabled}
            aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-medium disabled:cursor-not-allowed ${secondaryClass}`}
          >
            Stop
          </button>
        )}

        {d.canClose && (
          <button
            type="button"
            onClick={d.close}
            disabled={d.pending || disabled}
            aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
            className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-medium disabled:cursor-not-allowed ${primaryClass}`}
          >
            Close
          </button>
        )}
      </div>

      {d.isStale && (
        <div className="text-sm text-[var(--textMuted)] mt-1">Not connected to Home Assistant</div>
      )}
      {d.error !== null && (
        <div id={`${device.entityId}-error`} className="text-sm text-[var(--danger)] mt-1">
          {d.error}
        </div>
      )}
    </div>
  )
}
