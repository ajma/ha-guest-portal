import type { ReactElement } from 'react'
import { useToggleDevice } from '../../hooks/useToggleDevice.js'
import type { TileProps } from '../types.js'

export function ToggleTile({ device, disabled }: TileProps): ReactElement {
  const d = useToggleDevice(device, disabled)

  if (!d.canActivate) {
    return (
      <div className="p-[var(--tilePadding)] rounded-[var(--tileRadius)] bg-[var(--surface)] text-[var(--text)]">
        <div className="font-semibold">{d.label}</div>
        <div className="text-sm text-[var(--textMuted)] mt-1">No actions available</div>
      </div>
    )
  }

  return (
    <div className="rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <button
        type="button"
        onClick={d.activate}
        disabled={d.pending || disabled}
        aria-label={d.label}
        aria-pressed={d.isOn}
        aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
        className={`w-full p-[var(--tilePadding)] rounded-[var(--tileRadius)] text-left transition-colors disabled:cursor-not-allowed ${
          d.isOn
            ? 'bg-[var(--accent)] text-[var(--accentText)]'
            : 'bg-[var(--surface)] text-[var(--text)]'
        }`}
      >
        <div className="font-semibold">{d.label}</div>
        <div className="text-sm opacity-80 mt-1">{d.stateText}</div>
      </button>
      {d.isStale && (
        <div className="text-sm text-[var(--textMuted)] px-[var(--tilePadding)] pb-2">
          Not connected to Home Assistant
        </div>
      )}
      {d.error !== null && (
        <div
          id={`${device.entityId}-error`}
          className="text-sm text-[var(--danger)] px-[var(--tilePadding)] pb-2"
        >
          {d.error}
        </div>
      )}
    </div>
  )
}
