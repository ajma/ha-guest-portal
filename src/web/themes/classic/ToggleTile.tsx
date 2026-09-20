import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useToggleDevice } from '../../hooks/useToggleDevice.js'
import type { TileProps } from '../types.js'
import { icon } from './icons.js'

/**
 * Home Assistant's tile layout: circular icon on the left, name and state
 * stacked in the middle, the switch on the right. Only the icon circle and the
 * switch carry the accent colour — the card itself does not change on state,
 * which is what distinguishes `classic` from the flood-fill themes.
 *
 * The whole row is the button, as it is in Home Assistant's own tile card. The
 * switch on the right is the affordance, not a separate hit target: an empty
 * 44x24 control is the only thing a guest could press, and it leaves the name
 * and state — the text that says what pressing would do — outside the
 * accessible control entirely.
 */
export function ToggleTile({ device, disabled }: TileProps): ReactElement {
  const d = useToggleDevice(device, disabled)
  const domain = parseDomain(device.entityId)

  if (!d.canActivate) {
    return (
      <div className="flex items-center gap-3 p-[var(--tilePadding)] rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
        <span className="flex items-center justify-center shrink-0 w-10 h-10 rounded-full bg-[var(--surfaceActive)] text-[var(--textMuted)]">
          {domain !== null && icon(domain, 'off')}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--text)] truncate">{d.label}</div>
          <div className="text-sm text-[var(--textMuted)]">No actions available</div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-[var(--tilePadding)] rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <button
        type="button"
        onClick={d.activate}
        disabled={d.pending || disabled}
        aria-label={d.label}
        aria-pressed={d.isOn}
        aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
        className="flex items-center gap-3 w-full text-left disabled:cursor-not-allowed"
      >
        <span
          className={`flex items-center justify-center shrink-0 w-10 h-10 rounded-full transition-colors ${
            d.isOn
              ? 'bg-[var(--accent)] text-[var(--accentText)]'
              : 'bg-[var(--surfaceActive)] text-[var(--textMuted)]'
          }`}
        >
          {domain !== null && icon(domain, d.isOn ? 'on' : 'off')}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block font-medium text-[var(--text)] truncate">{d.label}</span>
          <span className="block text-sm text-[var(--textMuted)]">{d.stateText}</span>
        </span>

        <span
          aria-hidden="true"
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
            d.isOn ? 'bg-[var(--accent)]' : 'bg-[var(--surfaceActive)]'
          }`}
        >
          <span
            className={`absolute top-[3px] w-[18px] h-[18px] rounded-full transition-all ${
              d.isOn ? 'left-[23px] bg-[var(--accentText)]' : 'left-[3px] bg-[var(--textMuted)]'
            }`}
          />
        </span>
      </button>

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
