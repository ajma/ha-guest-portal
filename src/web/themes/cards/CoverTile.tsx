import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useCoverDevice } from '../../hooks/useCoverDevice.js'
import { stateColorToken } from '../stateColor.js'
import type { TileProps } from '../types.js'
import { BadgeButton, BadgeMark, badgeFor, Card, CardNote, CardText } from './card.js'
import { icon } from './icons.js'

type Primary = { verb: string; run: () => void }

/**
 * One badge, one action — which one depends on what the cover is doing.
 *
 * A row of Open/Stop/Close buttons is what `classic` draws, and it is the right
 * answer there. Here the badge is the control and the body is inert, so the
 * three collapse into the one the state calls for. Nothing is lost: Stop is
 * only meaningful while the cover is moving, and that is exactly when it is
 * offered. A cover that allows only one of open and close still gets it,
 * whatever the state.
 */
function primaryFor(state: string, d: ReturnType<typeof useCoverDevice>): Primary | null {
  const moving = state === 'opening' || state === 'closing'
  if (moving && d.canStop) return { verb: 'Stop', run: d.stop }

  const openish = state === 'open' || state === 'opening'
  if (openish && d.canClose) return { verb: 'Close', run: d.close }
  if (!openish && d.canOpen) return { verb: 'Open', run: d.open }

  // Whatever is left — a cover permitted to close but already closed, say.
  if (d.canOpen) return { verb: 'Open', run: d.open }
  if (d.canClose) return { verb: 'Close', run: d.close }
  if (d.canStop) return { verb: 'Stop', run: d.stop }
  return null
}

export function CoverTile({ device, disabled }: TileProps): ReactElement {
  const d = useCoverDevice(device, disabled)
  const domain = parseDomain(device.entityId)
  const state = device.state.state

  const token = stateColorToken(domain, d.isStale ? 'unavailable' : state)
  // An open cover tints purple and a moving one orange; a closed one is just a
  // neutral disc. `stateInactive` is this theme's definition of "nothing to
  // report", so it is also the test for whether to tint at all.
  const skin = badgeFor(token, !d.isStale && token !== 'stateInactive')
  const glyph = domain !== null && icon(domain, state)
  const primary = primaryFor(state, d)

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
      {/*
        The verb is in the accessible name, not only in the badge's colour: the
        visible text says what the cover IS, and a button has to say what
        pressing it would DO.
      */}
      <BadgeButton
        skin={skin}
        label={`${primary.verb} ${d.label}`}
        onClick={primary.run}
        disabled={d.pending || disabled}
        describedBy={d.error !== null ? `${device.entityId}-error` : undefined}
      >
        {glyph}
      </BadgeButton>
      <CardText primary={d.label} secondary={d.stateText} />
      {notes}
    </Card>
  )
}
