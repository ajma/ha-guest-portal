import type { ReactElement } from 'react'
import type { SupportedDomain } from '@shared/devices.js'
import { type GlyphName, GLYPHS } from './glyphs.js'

/**
 * Material Symbols Rounded, the icon family this theme's visual language comes
 * from. The path data lives in `glyphs.ts`, vendored from
 * `@material-symbols/svg-400` — see that file for why it is copied rather than
 * imported from the package's .svg files.
 *
 * Every domain resolves on state as well as domain: a resolver that ignored its
 * `state` argument would be caught for any of them, not only for lights. Active
 * states take the filled variant and inactive ones the outline, so the glyph
 * carries the state even before the colour does — which matters on a badge a
 * colour-blind guest has to read.
 */
const FOR_DOMAIN: Record<SupportedDomain, { active: GlyphName; inactive: GlyphName; on: string }> =
  {
    light: { active: 'lightbulb-fill', inactive: 'lightbulb', on: 'on' },
    switch: { active: 'toggle_on-fill', inactive: 'toggle_off', on: 'on' },
    input_boolean: { active: 'toggle_on-fill', inactive: 'toggle_off', on: 'on' },
    fan: { active: 'mode_fan-fill', inactive: 'mode_fan_off', on: 'on' },
    cover: { active: 'garage_door_open-fill', inactive: 'garage_door-fill', on: 'open' },
    lock: { active: 'lock-fill', inactive: 'lock_open_right-fill', on: 'locked' },
  }

export function icon(domain: SupportedDomain, state: string): ReactElement {
  const glyph = FOR_DOMAIN[domain]

  return (
    // Material Symbols are drawn on a 960-unit grid with the origin on the
    // text baseline, which is why the viewBox is not the usual 0 0 24 24.
    <svg viewBox="0 -960 960 960" className="h-7 w-7 fill-current" aria-hidden="true">
      <path d={GLYPHS[state === glyph.on ? glyph.active : glyph.inactive]} />
    </svg>
  )
}
