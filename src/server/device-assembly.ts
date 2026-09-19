import type { AllowlistRow } from '../shared/api.js'
import type { Device } from '../shared/api.js'
import type { CachedState } from './ha/states.js'
import { parseDomain } from '../shared/devices.js'

export function assembleDevices(
  allowlistRows: AllowlistRow[],
  states: ReadonlyMap<string, Readonly<CachedState>>,
  stale: boolean,
): Device[] {
  return allowlistRows.map((row) => {
    const state = states.get(row.entityId)
    const domain = parseDomain(row.entityId)

    return {
      entityId: row.entityId,
      label: row.label,
      domain: domain ?? 'unknown',
      allowedActions: row.allowedActions,
      sortOrder: row.sortOrder,
      state: {
        state: state?.state ?? 'unavailable',
        attributes: state?.attributes ?? {},
        stale,
      },
    }
  })
}
