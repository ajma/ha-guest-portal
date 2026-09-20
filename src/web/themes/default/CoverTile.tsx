import type { ReactElement } from 'react'
import { CONTROL_NEUTRAL_FILL } from '../stateColor.js'
import { useCoverDevice } from '../../hooks/useCoverDevice.js'
import type { TileProps } from '../types.js'

export function CoverTile({ device, disabled }: TileProps): ReactElement {
  const d = useCoverDevice(device, disabled)

  const inactive = disabled || d.pending || d.isStale
  // Open/Stop/Close are feature buttons, and Home Assistant leaves those
  // neutral: the cover's purple/orange/grey belongs to the icon, not to the
  // controls. All three therefore share one fill and differ only by label.
  const actionClass = inactive
    ? 'bg-[var(--surfaceActive)] text-[var(--textMuted)]'
    : 'text-[var(--text)]'
  const actionStyle = inactive ? undefined : { backgroundColor: CONTROL_NEUTRAL_FILL }

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
            className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-medium disabled:cursor-not-allowed ${actionClass}`}
            style={actionStyle}
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
            className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-medium disabled:cursor-not-allowed ${actionClass}`}
            style={actionStyle}
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
            className={`flex-1 py-3 px-4 rounded-[var(--tileRadius)] font-medium disabled:cursor-not-allowed ${actionClass}`}
            style={actionStyle}
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
