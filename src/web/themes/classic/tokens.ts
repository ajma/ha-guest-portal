import type { ThemeTokens } from '../tokens.js'

// Home Assistant's own palette values, taken from
// src/resources/theme/{core,typography}.globals.ts and
// src/resources/theme/color/color.globals.ts in home-assistant/frontend.
//
// This file is deliberately the only place in the theme where a literal colour
// appears — every component reads these back through CSS custom properties,
// which is what the colour scan in test/unit/theme-classic.test.tsx enforces
// over the .tsx files here.
//
// The state colours are identical in both modes. That is not an oversight:
// Home Assistant's state palette is mode-independent, and an amber light reads
// as amber on both surfaces. They are still declared twice because the token
// set is closed and every mode supplies every token.

const STATE_COLORS = {
  stateInactive: '#9e9e9e',
  stateLightActive: '#ffc107',
  stateSwitchActive: '#ffc107',
  stateFanActive: '#00bcd4',
  stateCoverActive: '#926bc7',
  stateLockLocked: '#4caf50',
  stateLockUnlocked: '#f44336',
  stateLockJammed: '#f44336',
  stateTransitioning: '#ff9800',
} as const

export const light: ThemeTokens = {
  appBg: '#fafafa',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceActive: '#f0f0f0',
  text: '#212121',
  textMuted: '#727272',
  accent: '#03a9f4',
  accentText: '#ffffff',
  danger: '#db4437',
  // --divider-color, which is also ha-card's default border colour.
  border: 'rgba(0,0,0,0.12)',
  // --disabled-color, which is ha-control-button's default background.
  controlNeutral: '#bdbdbd',
  tileRadius: '12px',
  tileGap: '8px',
  tilePadding: '16px',
  fontFamily: 'Roboto, Noto, sans-serif',
  // ha-card is flat: --ha-card-box-shadow defaults to none and the 1px divider
  // border carries the edge instead.
  shadow: 'none',
  ...STATE_COLORS,
}

export const dark: ThemeTokens = {
  appBg: '#111111',
  surface: '#1c1c1c',
  surfaceRaised: '#282828',
  surfaceActive: '#333333',
  text: '#e1e1e1',
  textMuted: '#9b9b9b',
  accent: '#03a9f4',
  accentText: '#ffffff',
  danger: '#db4437',
  border: 'rgba(225,225,225,0.12)',
  // --disabled-color's dark-mode value: the neutral is one of the few roles HA
  // does flip with the colour scheme, because it has to read against the card.
  controlNeutral: '#464646',
  tileRadius: '12px',
  tileGap: '8px',
  tilePadding: '16px',
  fontFamily: 'Roboto, Noto, sans-serif',
  shadow: 'none',
  ...STATE_COLORS,
}
