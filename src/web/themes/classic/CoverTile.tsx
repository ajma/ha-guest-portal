import type { ReactElement } from 'react'
import { parseDomain } from '@shared/devices.js'
import { useCoverDevice } from '../../hooks/useCoverDevice.js'
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
 * Home Assistant's tile card with a cover feature row: the 56px icon-and-text
 * row is inert, and Open/Stop/Close sit in a row of control buttons beneath it.
 * An open cover is purple, a moving one orange, a closed one grey — on the ICON
 * only. The buttons stay neutral, exactly as Home Assistant draws them.
 */
export function CoverTile({ device, disabled }: TileProps): ReactElement {
  const d = useCoverDevice(device, disabled)
  const domain = parseDomain(device.entityId)
  const token = stateColorToken(domain, d.isStale ? 'unavailable' : device.state.state)
  const describedBy = d.error !== null ? `${device.entityId}-error` : undefined
  const busy = d.pending || disabled

  return (
    <TileCard>
      <div className={TILE_ROW_CLASS}>
        <TileIcon token={token} glyph={domain !== null && icon(domain, device.state.state)} />
        <TileInfo primary={d.label} secondary={d.stateText} />
      </div>

      <TileFeatures>
        {d.canOpen && (
          <ControlButton onClick={d.open} disabled={busy} describedBy={describedBy}>
            Open
          </ControlButton>
        )}

        {d.canStop && (
          <ControlButton onClick={d.stop} disabled={busy} describedBy={describedBy}>
            Stop
          </ControlButton>
        )}

        {d.canClose && (
          <ControlButton onClick={d.close} disabled={busy} describedBy={describedBy}>
            Close
          </ControlButton>
        )}
      </TileFeatures>

      {d.isStale && <TileNote>Not connected to Home Assistant</TileNote>}
      {d.error !== null && (
        <TileNote id={`${device.entityId}-error`} danger>
          {d.error}
        </TileNote>
      )}
    </TileCard>
  )
}
