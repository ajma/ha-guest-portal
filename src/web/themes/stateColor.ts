import type { TokenName } from './tokens.js'

/**
 * The subset of the closed token set that names a state colour. Derived from
 * `TokenName` rather than listed again, so adding a `state*` token to the set
 * widens this automatically and a typo here is a type error rather than a
 * silently missing custom property at runtime.
 */
export type StateColorToken = Extract<TokenName, `state${string}`>

/**
 * States that are neither on nor off but on their way. Home Assistant paints
 * all of them the same transitional orange regardless of domain, which is why
 * this is checked before the per-domain mapping below.
 */
const TRANSITIONING = new Set(['opening', 'closing', 'locking', 'unlocking'])

/**
 * Resolve the token that colours a tile, the way Home Assistant's own tile card
 * does: by domain AND state, not from a single global accent.
 *
 * `domain` is a plain string because callers get it from two different places —
 * `parseDomain(entityId)`, which may be null, and `device.domain`, which is
 * unvalidated. Anything unrecognised resolves to the inactive grey, which is
 * also what an unavailable or unknown entity gets.
 */
export function stateColorToken(domain: string | null, state: string): StateColorToken {
  if (TRANSITIONING.has(state)) return 'stateTransitioning'

  switch (domain) {
    case 'light':
      return state === 'on' ? 'stateLightActive' : 'stateInactive'
    case 'switch':
    case 'input_boolean':
      return state === 'on' ? 'stateSwitchActive' : 'stateInactive'
    case 'fan':
      return state === 'on' ? 'stateFanActive' : 'stateInactive'
    case 'cover':
      return state === 'open' ? 'stateCoverActive' : 'stateInactive'
    case 'lock':
      if (state === 'locked') return 'stateLockLocked'
      if (state === 'jammed') return 'stateLockJammed'
      // `open` is a real lock state (an openable lock that has been opened) and
      // is as unlocked as `unlocked` is.
      if (state === 'unlocked' || state === 'open') return 'stateLockUnlocked'
      return 'stateInactive'
    default:
      return 'stateInactive'
  }
}

/**
 * The CSS reference for a state token. Tiles cannot use a Tailwind class here:
 * the token name is chosen at runtime, and Tailwind only emits classes it can
 * find as literal strings at build time. An inline `var()` is the way a dynamic
 * token reaches the DOM while the colour itself stays in `tokens.ts`.
 */
export function stateColorVar(token: StateColorToken): string {
  return `var(--${token})`
}

/**
 * The same colour at Home Assistant's 20% fill strength, used for the icon
 * circle's backing layer and for feature buttons. `color-mix` keeps the colour
 * itself in the custom property — nothing here hardcodes a channel value.
 */
export function stateColorFill(token: StateColorToken): string {
  return `color-mix(in srgb, var(--${token}) 20%, transparent)`
}

/**
 * The fill behind a FEATURE button, which is deliberately not a state colour.
 *
 * Home Assistant's `card-feature-styles.ts` hands `ha-control-button` only a
 * radius and `--control-button-focus-color`; it never sets
 * `--control-button-background-color`, so the background stays the component
 * default of `--disabled-color` at 20%. Open/Stop/Close and Lock/Unlock are
 * therefore the same neutral grey whatever the entity is doing — the state
 * colour lives on the icon circle, and reaches a button only as its focus ring.
 *
 * It sits beside `stateColorFill` so the contrast is visible from the module
 * that owns the state palette: this is the one fill that must not consult it.
 */
export const CONTROL_NEUTRAL_FILL = 'color-mix(in srgb, var(--controlNeutral) 20%, transparent)'
