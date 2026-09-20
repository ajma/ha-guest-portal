import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useCoverDevice } from '../../hooks/useCoverDevice.js'
import type { TileProps } from '../types.js'
import { icon } from './icons.js'

export function CoverTile({ device, disabled }: TileProps): ReactElement {
  const d = useCoverDevice(device, disabled)
  const domain = parseDomain(device.entityId)
  const inactive = disabled || d.pending || d.isStale

  // The control column is a segmented group of explicit buttons rather than a
  // whole-tile tap target — classic never makes the card itself interactive.
  const controlClass = inactive
    ? 'bg-[var(--surfaceActive)] text-[var(--textMuted)]'
    : 'bg-[var(--surfaceActive)] text-[var(--text)]'

  return (
    <div className="p-[var(--tilePadding)] rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <div className="flex items-center gap-3">
        <span className="flex items-center justify-center shrink-0 w-10 h-10 rounded-full bg-[var(--surfaceActive)] text-[var(--textMuted)]">
          {domain !== null && icon(domain, device.state.state)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--text)] truncate">{d.label}</div>
          <div className="text-sm text-[var(--textMuted)]">{d.stateText}</div>
        </div>

        <div className="flex shrink-0 gap-1">
          {d.canOpen && (
            <button
              type="button"
              onClick={d.open}
              disabled={d.pending || disabled}
              aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
              className={`py-2 px-3 text-sm font-medium rounded-[var(--tileRadius)] disabled:cursor-not-allowed ${controlClass}`}
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
              className={`py-2 px-3 text-sm font-medium rounded-[var(--tileRadius)] disabled:cursor-not-allowed ${controlClass}`}
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
              className={`py-2 px-3 text-sm font-medium rounded-[var(--tileRadius)] disabled:cursor-not-allowed ${controlClass}`}
            >
              Close
            </button>
          )}
        </div>
      </div>

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
