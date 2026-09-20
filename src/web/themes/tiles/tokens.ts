import type { ThemeTokens } from '../tokens.js'

// iOS's system palette — the system greys for the surfaces and the system
// colours for the states. Dark-first: the dark mode is the true black one the
// look is built around, and the light mode is its counterpart, not the other
// way round.
//
// This file is deliberately the only place in the theme where a literal colour
// appears; every component reads these back through CSS custom properties,
// which is what the colour scan in test/unit/theme-tiles.test.tsx enforces over
// the .tsx files here.
//
// Unlike `classic`, the state colours DO differ between the two modes: iOS
// publishes a separate dark variant for most of its system colours, and the
// light ones are too dense against a black tile.

const STATE_LIGHT = {
  stateInactive: '#8e8e93',
  stateLightActive: '#ffb340',
  stateSwitchActive: '#ffb340',
  stateFanActive: '#32ade6',
  stateCoverActive: '#af52de',
  stateLockLocked: '#34c759',
  stateLockUnlocked: '#ff3b30',
  stateLockJammed: '#ff3b30',
  stateTransitioning: '#ff9500',
} as const

const STATE_DARK = {
  stateInactive: '#8e8e93',
  stateLightActive: '#ffb340',
  stateSwitchActive: '#ffb340',
  stateFanActive: '#64d2ff',
  stateCoverActive: '#bf5af2',
  stateLockLocked: '#30d158',
  stateLockUnlocked: '#ff453a',
  stateLockJammed: '#ff453a',
  stateTransitioning: '#ff9f0a',
} as const

// Every one of those is a mid-tone, which is what lets an active tile flood
// with the state colour and still carry `accentText` (#000000) on top: the
// worst case is the light-mode cover purple at 5.1:1 against black, and the
// rest run from 5.9:1 (red) to well past 10:1 (amber). A dark flood colour
// would have needed `accentText` to flip per state, which the closed token set
// cannot express — so the palette is chosen to make that unnecessary.
const SHARED = {
  accent: '#ffb340',
  accentText: '#000000',
  textMuted: '#8e8e93',
  tileRadius: '20px',
  tileGap: '12px',
  tilePadding: '16px',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
} as const

export const light: ThemeTokens = {
  appBg: '#f2f2f7',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceActive: '#e5e5ea',
  text: '#000000',
  danger: '#ff3b30',
  border: '#d1d1d6',
  // systemGray4, the fill iOS puts behind a secondary control.
  controlNeutral: '#d1d1d6',
  shadow: '0 1px 3px rgba(0,0,0,0.08)',
  ...SHARED,
  ...STATE_LIGHT,
}

export const dark: ThemeTokens = {
  appBg: '#000000',
  surface: '#1c1c1e',
  surfaceRaised: '#2c2c2e',
  surfaceActive: '#3a3a3c',
  text: '#ffffff',
  danger: '#ff453a',
  border: '#38383a',
  controlNeutral: '#48484a',
  // On a true-black background a drop shadow is invisible; the surface step
  // from #000000 to #1c1c1e is what separates a tile from the page.
  shadow: 'none',
  ...SHARED,
  ...STATE_DARK,
}
