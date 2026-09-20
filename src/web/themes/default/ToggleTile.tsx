import type { ReactElement } from 'react'
import { stateColorFill, stateColorToken } from '../stateColor.js'
import { useToggleDevice } from '../../hooks/useToggleDevice.js'
import type { TileProps } from '../types.js'

export function ToggleTile({ device, disabled }: TileProps): ReactElement {
  const d = useToggleDevice(device, disabled)

  // Home Assistant colours by (domain, state), so an active light is amber and
  // an active fan cyan. A tokens-only theme has no component of its own to say
  // that in, which is why the default set resolves it here.
  const token = stateColorToken(device.domain, d.isStale ? 'unavailable' : d.isOn ? 'on' : 'off')

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
        className="w-full p-[var(--tilePadding)] rounded-[var(--tileRadius)] text-left text-[var(--text)] transition-colors disabled:cursor-not-allowed"
        style={{ backgroundColor: d.isOn ? stateColorFill(token) : 'var(--surface)' }}
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
