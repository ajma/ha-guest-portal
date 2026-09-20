import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useLockDevice } from '../../hooks/useLockDevice.js'
import { stateColorToken } from '../stateColor.js'
import type { TileProps } from '../types.js'
import { icon } from './icons.js'
import { skinFor, TileBody, TileButton, TileCard, TileNote, TilePill, TilePills } from './tile.js'

type Primary = { verb: string; run: () => void }

/**
 * The tile is the lock. A locked lock floods green, an unlocked or jammed one
 * red, one mid-turn orange — the tile itself, not a badge on it, so the state
 * of the front door is readable from across the room.
 *
 * Unlocking still takes two taps. That confirmation is this portal's own
 * addition, and it matters more here than in a theme with small buttons: a
 * whole-tile control is easy to hit by accident, and this one opens a door.
 * While it is pending the tile stops being a control altogether and the two
 * explicit choices appear, so there is no way to confirm by repeating the
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
  const flooded = !d.isStale && token !== 'stateInactive'
  const skin = skinFor(token, flooded)
  const glyph = domain !== null && icon(domain, d.isLocked ? 'locked' : 'unlocked')
  const describedBy = d.error !== null ? `${device.entityId}-error` : undefined
  const busy = d.pending || disabled
  const primary = primaryFor(d.isLocked, d)

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

  if (d.unlockConfirmPending) {
    return (
      <TileCard skin={skin}>
        {body}
        <TilePills>
          <TilePill skin={skin} onClick={d.requestUnlock} disabled={busy} describedBy={describedBy}>
            Confirm Unlock
          </TilePill>
          <TilePill skin={skin} onClick={d.cancelUnlock} disabled={busy}>
            Cancel
          </TilePill>
        </TilePills>
        <TileNote danger live>
          Confirm unlock?
        </TileNote>
        {notes}
      </TileCard>
    )
  }

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
      <TileButton
        label={`${primary.verb} ${d.label}`}
        onClick={primary.run}
        disabled={busy}
        describedBy={describedBy}
      >
        {body}
      </TileButton>
      {notes}
    </TileCard>
  )
}
