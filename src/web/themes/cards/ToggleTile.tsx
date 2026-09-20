import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useToggleDevice } from '../../hooks/useToggleDevice.js'
import { stateColorToken } from '../stateColor.js'
import type { TileProps } from '../types.js'
import { BadgeButton, BadgeMark, badgeFor, Card, CardNote, CardText } from './card.js'
import { icon } from './icons.js'

/**
 * The badge is the switch. Tapping the disc toggles the device; the name and
 * state below it are read-only, so a card can be scanned without being a tap
 * target the whole way across.
 *
 * `isOn` comes from the hook, so the tint follows the optimistic update and the
 * badge lights the instant it is pressed rather than when the patch lands.
 */
export function ToggleTile({ device, disabled }: TileProps): ReactElement {
  const d = useToggleDevice(device, disabled)
  const domain = parseDomain(device.entityId)

  // A stale device has no known state, so its badge stays neutral — the portal
  // does not know whether that lamp is lit and must not imply that it does.
  const token = stateColorToken(domain, d.isStale ? 'unavailable' : d.isOn ? 'on' : 'off')
  const skin = badgeFor(token, d.isOn && !d.isStale)
  const glyph = domain !== null && icon(domain, d.isOn ? 'on' : 'off')

  if (!d.canActivate) {
    return (
      <Card>
        <BadgeMark skin={badgeFor(token, false)}>{glyph}</BadgeMark>
        <CardText primary={d.label} secondary="No actions available" />
      </Card>
    )
  }

  return (
    <Card>
      <BadgeButton
        skin={skin}
        label={d.label}
        pressed={d.isOn}
        onClick={d.activate}
        disabled={d.pending || disabled}
        describedBy={d.error !== null ? `${device.entityId}-error` : undefined}
      >
        {glyph}
      </BadgeButton>
      <CardText primary={d.label} secondary={d.stateText} />

      {d.isStale && <CardNote>Not connected to Home Assistant</CardNote>}
      {d.error !== null && (
        <CardNote id={`${device.entityId}-error`} danger>
          {d.error}
        </CardNote>
      )}
    </Card>
  )
}
