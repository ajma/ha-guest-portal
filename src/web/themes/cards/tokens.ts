import type { ThemeTokens } from '../tokens.js'

// Material 3's palette: the neutral surfaces from the Google Sans / Material
// You family, and Google's own reference hues for the state roles. Light-first
// — the white page with pale grey cards is the look, and the dark mode is its
// counterpart rather than the other way round.
//
// This file is deliberately the only place in the theme where a literal colour
// appears; every component reads these back through CSS custom properties,
// which is what the colour scan in test/unit/theme-cards.test.tsx enforces over
// the .tsx files here.
//
// The state colours differ per mode, and have to. Material publishes a dark
// variant for each hue because the light ones (amber #f9ab00, cyan #12b5cb)
// are far too dense to read on a near-black page.

const STATE_LIGHT = {
  stateInactive: '#5f6368',
  stateLightActive: '#f9ab00',
  stateSwitchActive: '#f9ab00',
  stateFanActive: '#12b5cb',
  stateCoverActive: '#9334e6',
  stateLockLocked: '#1e8e3e',
  stateLockUnlocked: '#d93025',
  stateLockJammed: '#d93025',
  stateTransitioning: '#e8710a',
} as const

const STATE_DARK = {
  stateInactive: '#9aa0a6',
  stateLightActive: '#fdd663',
  stateSwitchActive: '#fdd663',
  stateFanActive: '#78d9ec',
  stateCoverActive: '#d7aefb',
  stateLockLocked: '#81c995',
  stateLockUnlocked: '#f28b82',
  stateLockJammed: '#f28b82',
  stateTransitioning: '#fcad70',
} as const

// Unlike `tiles`, this theme never writes `accentText` onto a state colour, and
// the palette above is why: white on the light-mode amber is 1.9:1 and on the
// cyan 2.5:1 — unreadable — while near-black fails on the purple and the red.
// No single foreground token is legible on all nine solid fills, so the badge
// takes the state colour as a tonal fill over `--surface` and keeps `--text` on
// top, which clears 4.2:1 for every state in both modes. See card.tsx.
const SHARED = {
  tileRadius: '28px',
  tileGap: '16px',
  tilePadding: '20px',
  fontFamily: "'Google Sans', Roboto, system-ui, sans-serif",
  // Flat by design: Material 3 separates a card from the page with a surface
  // tone, not with elevation. The token still has to be supplied — the set is
  // closed — and `none` is a real answer to it.
  shadow: 'none',
} as const

export const light: ThemeTokens = {
  accent: '#0b57d0',
  accentText: '#ffffff',
  appBg: '#ffffff',
  surface: '#f0f4f9',
  surfaceRaised: '#ffffff',
  surfaceActive: '#e3e8ef',
  text: '#1f1f1f',
  textMuted: '#5f6368',
  danger: '#b3261e',
  border: '#dadce0',
  controlNeutral: '#dadce0',
  ...SHARED,
  ...STATE_LIGHT,
}

export const dark: ThemeTokens = {
  // Both of these flip: the light-mode blue is too dark to read on a near-black
  // page, and the pale blue that replaces it needs dark text on top.
  accent: '#a8c7fa',
  accentText: '#062e6f',
  appBg: '#131314',
  surface: '#1e1f20',
  surfaceRaised: '#282a2c',
  surfaceActive: '#333537',
  text: '#e3e3e3',
  textMuted: '#9aa0a6',
  danger: '#f2b8b5',
  border: '#444746',
  controlNeutral: '#444746',
  ...SHARED,
  ...STATE_DARK,
}
