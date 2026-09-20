// The set of themes the guest portal can render. This list is the contract
// between the two halves: the server validates against it and the web
// registry is typed from it. The server cannot import from src/web without
// pulling the client bundle into the server build, so it lives here.
export const THEME_IDS = ['tiles', 'cards', 'classic'] as const

export type ThemeId = (typeof THEME_IDS)[number]

export const DEFAULT_THEME_ID: ThemeId = 'classic'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}
