import type { ReactElement, ReactNode } from 'react'
import type { SupportedDomain } from '@shared/devices.js'

/**
 * SF Symbols cannot ship in a web application — the licence covers Apple
 * platforms only — so this set is a lookalike drawn by hand, and no dependency
 * is added for it.
 *
 * The idiom is SF's: a 24px optical box, an even 1.8px stroke, round caps and
 * joins, no fill, and a glyph that reads at 28px. Every domain also draws a
 * different shape for its active and inactive state, so the colour is not the
 * only thing telling a guest what a device is doing — which matters here more
 * than in `classic`, because an active tile floods and a colour-blind guest
 * needs the silhouette.
 */

const BULB = [
  'M12 3.2a5.4 5.4 0 0 1 3.1 9.8c-.5.4-.8.9-.8 1.5v.3H9.7v-.3c0-.6-.3-1.1-.8-1.5A5.4 5.4 0 0 1 12 3.2Z',
  'M9.8 17.2h4.4',
  'M10.7 19.6h2.6',
]

// Only on the lit bulb: the rays are the state cue that survives desaturation.
const BULB_RAYS = ['M12 1.6v.9', 'M5.6 5.6l.7.7', 'M18.4 5.6l-.7.7', 'M3 12h1', 'M21 12h-1']

const SWITCH_TRACK = 'M8.2 7.8h7.6a4.2 4.2 0 0 1 0 8.4H8.2a4.2 4.2 0 0 1 0-8.4Z'
const SWITCH_KNOB_RIGHT = 'M15.8 9.7a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Z'
const SWITCH_KNOB_LEFT = 'M8.2 9.7a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Z'

const FAN_BLADE = 'M12 12c-2-1.1-3-2.9-2.5-4.6.5-1.6 2.4-2.1 3.8-1 1.4 1.1 1.7 3.2.7 5.6Z'
const FAN_HUB = 'M12 10.7a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Z'
// Only on the running fan: two arcs of draught outside the blade circle.
const FAN_MOTION = ['M19.9 7.1a9.2 9.2 0 0 1 1.3 3.6', 'M4.1 16.9a9.2 9.2 0 0 1-1.3-3.6']

const GARAGE_FRAME = ['M3.2 20.4V9.8L12 4.2l8.8 5.6v10.6', 'M2.2 20.4h19.6']
const GARAGE_DOOR_DOWN = ['M6.6 20.4v-6.9h10.8v6.9', 'M6.6 17h10.8']
// Rolled up to the lintel, leaving the opening and the two jambs.
const GARAGE_DOOR_UP = ['M6.6 20.4v-7.5', 'M17.4 20.4v-7.5', 'M6.6 12.9h10.8']

const LOCK_BODY = [
  'M6.6 10.6h10.8a1.6 1.6 0 0 1 1.6 1.6v6.6a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 18.8v-6.6a1.6 1.6 0 0 1 1.6-1.6Z',
  'M12 14.1v2.8',
]
const LOCK_SHACKLE_CLOSED = 'M8.4 10.6V7.6a3.6 3.6 0 0 1 7.2 0v3'
// The right leg is gone: the shackle has sprung out of the body.
const LOCK_SHACKLE_OPEN = 'M8.4 10.6V7.6a3.6 3.6 0 0 1 7.2 0'

function paths(list: readonly string[]): ReactNode {
  return list.map((d) => <path key={d} d={d} />)
}

function toggleGlyph(state: string): ReactNode {
  return paths([SWITCH_TRACK, state === 'on' ? SWITCH_KNOB_RIGHT : SWITCH_KNOB_LEFT])
}

const GLYPHS: Record<SupportedDomain, (state: string) => ReactNode> = {
  light: (s) => paths(s === 'on' ? [...BULB, ...BULB_RAYS] : BULB),
  switch: toggleGlyph,
  input_boolean: toggleGlyph,
  fan: (s) => (
    <>
      {/* One blade, drawn three times about the hub — a pinwheel the same way
          a real fan is one moulding repeated. */}
      <path d={FAN_BLADE} />
      <g transform="rotate(120 12 12)">
        <path d={FAN_BLADE} />
      </g>
      <g transform="rotate(240 12 12)">
        <path d={FAN_BLADE} />
      </g>
      <path d={FAN_HUB} />
      {s === 'on' && paths(FAN_MOTION)}
    </>
  ),
  cover: (s) => paths([...GARAGE_FRAME, ...(s === 'open' ? GARAGE_DOOR_UP : GARAGE_DOOR_DOWN)]),
  lock: (s) => paths([...LOCK_BODY, s === 'locked' ? LOCK_SHACKLE_CLOSED : LOCK_SHACKLE_OPEN]),
}

export function icon(domain: SupportedDomain, state: string): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-7 w-7"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[domain](state)}
    </svg>
  )
}
