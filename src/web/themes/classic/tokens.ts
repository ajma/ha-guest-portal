import type { ThemeTokens } from '../tokens.js'

// Home Assistant's own palette values. This file is deliberately the only place
// in the theme where a literal colour appears — every component reads these
// back through CSS custom properties, which is what the colour scan in
// test/unit/theme-classic.test.tsx enforces over the .tsx files here.

export const light: ThemeTokens = {
  appBg: '#f2f4f7',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceActive: '#f0f0f0',
  text: '#212121',
  textMuted: '#727272',
  accent: '#03a9f4',
  accentText: '#ffffff',
  danger: '#db4437',
  border: '#e0e0e0',
  tileRadius: '12px',
  tileGap: '8px',
  tilePadding: '16px',
  fontFamily: "Roboto, 'Helvetica Neue', system-ui, sans-serif",
  shadow: '0 2px 2px rgba(0,0,0,0.14)',
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
  border: '#2e2e2e',
  tileRadius: '12px',
  tileGap: '8px',
  tilePadding: '16px',
  fontFamily: "Roboto, 'Helvetica Neue', system-ui, sans-serif",
  shadow: '0 2px 2px rgba(0,0,0,0.5)',
}
