import { DEFAULT_THEME_ID } from '@shared/themes.js'
import { DEFAULT_COMPONENTS } from './default/index.js'
import { resolveTheme } from './registry.js'
import type { Theme } from './types.js'

/**
 * The server writes the active theme onto <html> so the CSS variables apply
 * during parse. Reading it is synchronous — there is no fetch and no flash.
 *
 * The returned id is raw: an attribute naming a theme that no longer exists is
 * returned verbatim and degraded by `resolveTheme`, which owns that decision.
 * The only fallback here is for the attribute being absent altogether, which
 * happens under `vitest` and in any HTML the server did not rewrite.
 */
export function readThemeId(): string {
  return document.documentElement.dataset.theme ?? DEFAULT_THEME_ID
}

/**
 * Overlay a theme's component overrides onto the default set. `components` is
 * optional and partial by design: a tokens-only theme supplies none and gets
 * the whole default set, and a theme overriding one slot keeps the defaults for
 * the other five. That is the property that makes adding a theme cheap.
 */
export function componentsFor(theme: Theme): typeof DEFAULT_COMPONENTS {
  return { ...DEFAULT_COMPONENTS, ...(theme.components ?? {}) }
}

export function activeTheme(): Theme {
  return resolveTheme(readThemeId())
}
