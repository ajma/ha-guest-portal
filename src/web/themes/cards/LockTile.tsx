import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useLockDevice } from '../../hooks/useLockDevice.js'
import { stateColorToken } from '../stateColor.js'
import type { TileProps } from '../types.js'
import {
  BadgeButton,
  BadgeMark,
  badgeFor,
  Card,
  CardAction,
  CardActions,
  CardNote,
  CardText,
} from './card.js'
import { icon } from './icons.js'

type Primary = { verb: string; run: () => void }

/**
 * A locked lock tints the badge green, an unlocked or jammed one red, one
 * mid-turn orange — so the state of the front door is readable from the same
 * glance that reads the rest of the grid.
 *
 * Unlocking still takes two taps. That confirmation is this portal's own
 * addition rather than the theme's, and it must survive every theme: while it
 * is pending the badge stops being a control and the two explicit choices
 * appear beneath the text, so there is no way to confirm by repeating the
 * gesture that started it.
 */
function primaryFor(isLocked: boolean, d: ReturnType<typeof useLockDevice>): Primary | null {
  if (isLocked) {
    if (d.canUnlock) return { verb: 'Unlock', run: d.requestUnlock }
    if (d.canLock) return { verb: 'Lock', run: d.lock }
    return null
  }
  if (d.canLock) return { verb: 'Lock', run: d.lock }
  if (d.canUnlock) return { verb: 'Unlock', run: d.requestUnlock }
  return null
}

export function LockTile({ device, disabled }: TileProps): ReactElement {
  const d = useLockDevice(device, disabled)
  const domain = parseDomain(device.entityId)

  const token = stateColorToken(domain, d.isStale ? 'unavailable' : device.state.state)
  const skin = badgeFor(token, !d.isStale && token !== 'stateInactive')
  const glyph = domain !== null && icon(domain, d.isLocked ? 'locked' : 'unlocked')
  const describedBy = d.error !== null ? `${device.entityId}-error` : undefined
  const busy = d.pending || disabled
  const primary = primaryFor(d.isLocked, d)

  const notes = (
    <>
      {d.isStale && <CardNote>Not connected to Home Assistant</CardNote>}
      {d.error !== null && (
        <CardNote id={`${device.entityId}-error`} danger>
          {d.error}
        </CardNote>
      )}
    </>
  )

  if (d.unlockConfirmPending) {
    return (
      <Card>
        <BadgeMark skin={skin}>{glyph}</BadgeMark>
        <CardText primary={d.label} secondary={d.stateText} />
        <CardActions>
          <CardAction primary onClick={d.requestUnlock} disabled={busy} describedBy={describedBy}>
            Confirm Unlock
          </CardAction>
          <CardAction onClick={d.cancelUnlock} disabled={busy}>
            Cancel
          </CardAction>
        </CardActions>
        <CardNote danger live>
          Confirm unlock?
        </CardNote>
        {notes}
      </Card>
    )
  }

  if (primary === null) {
    return (
      <Card>
        <BadgeMark skin={skin}>{glyph}</BadgeMark>
        <CardText primary={d.label} secondary={d.stateText} />
        {notes}
      </Card>
    )
  }

  return (
    <Card>
      <BadgeButton
        skin={skin}
        label={`${primary.verb} ${d.label}`}
        onClick={primary.run}
        disabled={busy}
        describedBy={describedBy}
      >
        {glyph}
      </BadgeButton>
      <CardText primary={d.label} secondary={d.stateText} />
      {notes}
    </Card>
  )
}
