import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useCoverDevice } from '../../hooks/useCoverDevice.js'
import { stateColorToken } from '../stateColor.js'
import type { TileProps } from '../types.js'
import { icon } from './icons.js'
import { skinFor, TileBody, TileButton, TileCard, TileNote } from './tile.js'

type Primary = { verb: string; run: () => void }

/**
 * One tile, one action — which one depends on what the cover is doing.
 *
 * A row of Open/Stop/Close buttons would be a control panel sitting inside a
 * card, and this theme's whole claim is that the tile is the control. Nothing
 * is lost by collapsing them: Stop is only meaningful while the cover is
 * moving, and that is exactly when it is offered. A cover that allows only one
 * of open and close still gets it, whatever the state.
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
  // An open cover floods purple and a moving one orange; a closed one is just
  // a surface. `stateInactive` is the theme's definition of "nothing to shout
  // about", so it is also the test for whether to flood.
  const flooded = !d.isStale && token !== 'stateInactive'
  const skin = skinFor(token, flooded)
  const glyph = domain !== null && icon(domain, state)
  const primary = primaryFor(state, d)

  const body = <TileBody skin={skin} glyph={glyph} primary={d.label} secondary={d.stateText} />
  const notes = (
    <>
      {d.isStale && <TileNote>Not connected to Home Assistant</TileNote>}
      {d.error !== null && (
        <TileNote id={`${device.entityId}-error`} danger>
          {d.error}
        </TileNote>
      )}
    </>
  )

  if (primary === null) {
    return (
      <TileCard skin={skin}>
        {body}
        {notes}
      </TileCard>
    )
  }

  return (
    <TileCard skin={skin}>
      {/*
        The verb is in the accessible name, not only in the tile's colour: the
        visible text says what the cover IS, and a button has to say what
        pressing it would DO.
      */}
      <TileButton
        label={`${primary.verb} ${d.label}`}
        onClick={primary.run}
        disabled={d.pending || disabled}
        describedBy={d.error !== null ? `${device.entityId}-error` : undefined}
      >
        {body}
      </TileButton>
      {notes}
    </TileCard>
  )
}
