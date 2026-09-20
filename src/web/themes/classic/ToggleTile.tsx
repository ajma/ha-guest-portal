import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useToggleDevice } from '../../hooks/useToggleDevice.js'
import { stateColorToken } from '../stateColor.js'
import type { TileProps } from '../types.js'
import { icon } from './icons.js'
import { TILE_ROW_CLASS, TileCard, TileIcon, TileInfo, TileNote } from './tile.js'

/**
 * Home Assistant's tile card: a circular icon on the left and the name and
 * state stacked beside it. There is no switch graphic — the whole row is the
 * control and the icon's colour is what carries the state. An amber circle
 * means the light is on; grey means it is off.
 *
 * The whole row is the button, as it is in Home Assistant's own tile card: an
 * empty 44x24 switch would be the only thing a guest could press, and it leaves
 * the name and state — the text that says what pressing would do — outside the
 * accessible control entirely.
 */
export function ToggleTile({ device, disabled }: TileProps): ReactElement {
  const d = useToggleDevice(device, disabled)
  const domain = parseDomain(device.entityId)

  // A stale device has no known state, so it takes the inactive grey rather
  // than the colour of whatever it was last seen doing.
  const token = stateColorToken(domain, d.isStale ? 'unavailable' : d.isOn ? 'on' : 'off')
  const glyph = domain !== null && icon(domain, d.isOn ? 'on' : 'off')

  if (!d.canActivate) {
    return (
      <TileCard>
        <div className={TILE_ROW_CLASS}>
          <TileIcon token={stateColorToken(domain, 'unavailable')} glyph={glyph} />
          <TileInfo primary={d.label} secondary="No actions available" />
        </div>
      </TileCard>
    )
  }

  return (
    <TileCard>
      <button
        type="button"
        onClick={d.activate}
        disabled={d.pending || disabled}
        aria-label={d.label}
        aria-pressed={d.isOn}
        aria-describedby={d.error !== null ? `${device.entityId}-error` : undefined}
        className={`group ${TILE_ROW_CLASS} disabled:cursor-not-allowed`}
      >
        <TileIcon token={token} glyph={glyph} />
        <TileInfo primary={d.label} secondary={d.stateText} />
      </button>

      {d.isStale && <TileNote>Not connected to Home Assistant</TileNote>}
      {d.error !== null && (
        <TileNote id={`${device.entityId}-error`} danger>
          {d.error}
        </TileNote>
      )}
    </TileCard>
  )
}
