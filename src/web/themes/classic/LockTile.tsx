import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useLockDevice } from '../../hooks/useLockDevice.js'
import { stateColorToken } from '../stateColor.js'
import type { TileProps } from '../types.js'
import { icon } from './icons.js'
import {
  ControlButton,
  TILE_ROW_CLASS,
  TileCard,
  TileFeatures,
  TileIcon,
  TileInfo,
  TileNote,
} from './tile.js'

/**
 * Home Assistant's tile card with a lock feature row. A locked lock is green,
 * an unlocked or jammed one red, one mid-turn orange — on the ICON. The feature
 * buttons are neutral: Home Assistant does not paint Lock green and Unlock red,
 * and the consequence of the tap is carried by the label and, below, by the
 * confirmation note.
 *
 * The unlock confirmation is this portal's own addition, not Home Assistant's —
 * a guest portal does not open a door on one stray tap. It keeps the control
 * button shape, and the danger colour lives in the note beneath it.
 */
export function LockTile({ device, disabled }: TileProps): ReactElement {
  const d = useLockDevice(device, disabled)
  const domain = parseDomain(device.entityId)
  const token = stateColorToken(domain, d.isStale ? 'unavailable' : device.state.state)
  const describedBy = d.error !== null ? `${device.entityId}-error` : undefined
  const busy = d.pending || disabled

  return (
    <TileCard>
      <div className={TILE_ROW_CLASS}>
        <TileIcon
          token={token}
          glyph={domain !== null && icon(domain, d.isLocked ? 'locked' : 'unlocked')}
        />
        <TileInfo primary={d.label} secondary={d.stateText} />
      </div>

      {d.unlockConfirmPending ? (
        <TileFeatures>
          <ControlButton onClick={d.requestUnlock} disabled={busy} describedBy={describedBy}>
            Confirm Unlock
          </ControlButton>
          <ControlButton onClick={d.cancelUnlock} disabled={busy}>
            Cancel
          </ControlButton>
        </TileFeatures>
      ) : (
        <TileFeatures>
          {d.canLock && (
            <ControlButton onClick={d.lock} disabled={busy} describedBy={describedBy}>
              Lock
            </ControlButton>
          )}

          {d.canUnlock && (
            <ControlButton onClick={d.requestUnlock} disabled={busy} describedBy={describedBy}>
              Unlock
            </ControlButton>
          )}
        </TileFeatures>
      )}

      {d.unlockConfirmPending && (
        <TileNote danger live>
          Confirm unlock?
        </TileNote>
      )}
      {d.isStale && <TileNote>Not connected to Home Assistant</TileNote>}
      {d.error !== null && (
        <TileNote id={`${device.entityId}-error`} danger>
          {d.error}
        </TileNote>
      )}
    </TileCard>
  )
}
