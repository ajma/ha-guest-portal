import classic from './classic/index.js'
import type { Theme } from './types.js'

// Static registry: every theme ships in the bundle. This map's value type is
// the single swap point for lazy loading — changing it to
// `() => Promise<Theme>` is a localised change, worth making at eight themes
// rather than three.
const THEMES: Record<string, Theme> = {
  classic,
}

export function resolveTheme(id: string): Theme {
  // An unrecognised id degrades to the default rather than white-screening:
  // a settings row may name a theme that has since been removed. The fallback
  // is the imported module rather than THEMES[DEFAULT_THEME_ID], which under
  // `noUncheckedIndexedAccess` would be `Theme | undefined` and need a non-null
  // assertion to satisfy the return type.
  return THEMES[id] ?? classic
}

export function listThemes(): Theme[] {
  return Object.values(THEMES)
}
