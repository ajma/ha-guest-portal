import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useToggleDevice } from '../../hooks/useToggleDevice.js'
import { stateColorToken } from '../stateColor.js'
import type { TileProps } from '../types.js'
import { icon } from './icons.js'
import { skinFor, TileBody, TileButton, TileCard, TileNote } from './tile.js'

/**
 * The whole tile is the switch. There is no control inside a card: tapping
 * anywhere on the square toggles the device, and the square itself floods with
 * the device's state colour when it is on.
 *
 * `isOn` comes from the hook, so the flood follows the optimistic update and
 * the tile turns amber the instant it is pressed rather than when the patch
 * lands.
 */
export function ToggleTile({ device, disabled }: TileProps): ReactElement {
  const d = useToggleDevice(device, disabled)
  const domain = parseDomain(device.entityId)

  // A stale device has no known state, so it neither floods nor claims a
  // colour — the portal does not know whether that lamp is lit.
  const token = stateColorToken(domain, d.isStale ? 'unavailable' : d.isOn ? 'on' : 'off')
  const flooded = d.isOn && !d.isStale
  const skin = skinFor(token, flooded)
  const glyph = domain !== null && icon(domain, d.isOn ? 'on' : 'off')

  if (!d.canActivate) {
    const inert = skinFor(stateColorToken(domain, 'unavailable'), false)
    return (
      <TileCard skin={inert}>
        <TileBody skin={inert} glyph={glyph} primary={d.label} secondary="No actions available" />
      </TileCard>
    )
  }

  return (
    <TileCard skin={skin}>
      <TileButton
        label={d.label}
        pressed={d.isOn}
        onClick={d.activate}
        disabled={d.pending || disabled}
        describedBy={d.error !== null ? `${device.entityId}-error` : undefined}
      >
        <TileBody skin={skin} glyph={glyph} primary={d.label} secondary={d.stateText} />
      </TileButton>

      {d.isStale && <TileNote>Not connected to Home Assistant</TileNote>}
      {d.error !== null && (
        <TileNote id={`${device.entityId}-error`} danger>
          {d.error}
        </TileNote>
      )}
    </TileCard>
  )
}
