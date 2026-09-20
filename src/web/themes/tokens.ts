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
  // The neutral behind a feature button. Home Assistant's ha-control-button
  // defaults to `--disabled-color` at 20% and its card-feature styles
  // deliberately do NOT override it, so Open/Stop/Close and Lock/Unlock are the
  // same grey on every domain and in every state — the state colour reaches a
  // feature button only as its focus ring. This is a distinct role from
  // `surfaceActive`: that one is a raised surface, this one is a fill that is
  // meant to be laid down translucent.
  'controlNeutral',
  'tileRadius',
  'tileGap',
  'tilePadding',
  'fontFamily',
  'shadow',
  // State colours. Home Assistant colours a tile by (domain, state) rather than
  // from one global accent — an active light is amber, an active fan is cyan, a
  // locked lock is green. `src/web/themes/stateColor.ts` owns the mapping; these
  // are the roles it can resolve to, and every theme must name a colour for each
  // or it cannot express state at all.
  'stateInactive',
  'stateLightActive',
  'stateSwitchActive',
  'stateFanActive',
  'stateCoverActive',
  'stateLockLocked',
  'stateLockUnlocked',
  'stateLockJammed',
  'stateTransitioning',
] as const

export type TokenName = (typeof TOKEN_NAMES)[number]
export type ThemeTokens = Record<TokenName, string>

/** Emit a token set as CSS custom property declarations. */
export function tokensToCss(tokens: ThemeTokens): string {
  return TOKEN_NAMES.map((name) => `  --${name}: ${tokens[name]};`).join('\n')
}
