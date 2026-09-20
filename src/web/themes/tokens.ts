// The token set is CLOSED. Every theme supplies every token; no theme invents
// its own. A theme needing a value outside this list is a signal to extend the
// list for all themes — otherwise the default component set cannot render an
// arbitrary theme, which is the property that makes component overrides optional.
export const TOKEN_NAMES = [
  'appBg',
  'surface',
  'surfaceRaised',
  'surfaceActive',
  'text',
  'textMuted',
  'accent',
  'accentText',
  'danger',
  'border',
  'tileRadius',
  'tileGap',
  'tilePadding',
  'fontFamily',
  'shadow',
] as const

export type TokenName = (typeof TOKEN_NAMES)[number]
export type ThemeTokens = Record<TokenName, string>

/** Emit a token set as CSS custom property declarations. */
export function tokensToCss(tokens: ThemeTokens): string {
  return TOKEN_NAMES.map((name) => `  --${name}: ${tokens[name]};`).join('\n')
}
