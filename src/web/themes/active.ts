import { DEFAULT_THEME_ID } from '@shared/themes.js'
import { DEFAULT_COMPONENTS } from './default/index.js'
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

/**
 * Put a freshly selected or saved theme id back where the server put the
 * original.
 *
 * The attribute is written by the server once, at page load, and
 * `generated.css` keys every `[data-theme='...']` block off it. Without this,
 * an owner who switches portals or saves a new theme from settings is
 * choosing a value the rest of their own page cannot see: the CSS variables
 * stay on whatever theme the page opened with until a reload.
 *
 * Nothing re-renders as a result of this call: React does not observe DOM
 * attributes, so the caller is also responsible for threading the id through
 * state to swap the component set (`componentsFor(resolveTheme(themeId))`).
 */
export function writeThemeId(themeId: string): void {
  document.documentElement.dataset.theme = themeId
}
