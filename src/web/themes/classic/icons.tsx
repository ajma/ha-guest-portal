import {
  mdiFan,
  mdiFanOff,
  mdiGarage,
  mdiGarageOpen,
  mdiLightbulb,
  mdiLightbulbOutline,
  mdiLock,
  mdiLockOpenVariant,
  mdiToggleSwitch,
  mdiToggleSwitchOff,
} from '@mdi/js'
import type { ReactElement } from 'react'
import type { SupportedDomain } from '@shared/devices.js'

// Every domain resolves on state, so a resolver that ignored its `state`
// argument would be caught for any domain rather than only for lights. `fan`
// deviates from the plan's `() => mdiFan` for that reason, and because Home
// Assistant's own frontend shows an off fan as mdi:fan-off.
const PATHS: Record<SupportedDomain, (state: string) => string> = {
  light: (s) => (s === 'on' ? mdiLightbulb : mdiLightbulbOutline),
  switch: (s) => (s === 'on' ? mdiToggleSwitch : mdiToggleSwitchOff),
  fan: (s) => (s === 'on' ? mdiFan : mdiFanOff),
  input_boolean: (s) => (s === 'on' ? mdiToggleSwitch : mdiToggleSwitchOff),
  cover: (s) => (s === 'open' ? mdiGarageOpen : mdiGarage),
  lock: (s) => (s === 'locked' ? mdiLock : mdiLockOpenVariant),
}

export function icon(domain: SupportedDomain, state: string): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current" aria-hidden="true">
      <path d={PATHS[domain](state)} />
    </svg>
  )
}
