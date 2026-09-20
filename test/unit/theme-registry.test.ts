import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../src/shared/themes.ts'
import { listThemes, resolveTheme } from '../../src/web/themes/registry.ts'
import { TOKEN_NAMES } from '../../src/web/themes/tokens.ts'

describe('theme registry', () => {
  // Phase 1 registers only `classic`; `tiles` and `cards` arrive in phases 2
  // and 3. Until then resolveTheme('tiles') falls back to classic, whose id is
  // 'classic', so this assertion cannot hold yet.
  //
  // `it.fails` rather than `it.skip`: when Task 10 registers the third theme
  // this starts passing, and an unexpected pass is itself a failure — which
  // forces whoever finishes Phase 3 to remove the marker. A skip would stay
  // green forever and silently retire the assertion.
  it.fails('resolves every declared id', () => {
    for (const id of THEME_IDS) {
      expect(resolveTheme(id).id).toBe(id)
    }
  })

  it('falls back to classic for an unknown id rather than throwing', () => {
    expect(resolveTheme('bogus').id).toBe('classic')
  })

  // Also `it.fails` for the duration of Phase 1 — see the note above.
  it.fails('registry keys match THEME_IDS exactly', () => {
    expect(
      listThemes()
        .map((t) => t.id)
        .sort(),
    ).toEqual([...THEME_IDS].sort())
  })

  it('every theme declares both modes and an icon resolver', () => {
    // An empty registry would satisfy every for-of below vacuously.
    expect(listThemes().length).toBeGreaterThan(0)

    for (const theme of listThemes()) {
      expect(theme.tokens.light).toBeDefined()
      expect(theme.tokens.dark).toBeDefined()
      expect(typeof theme.icon).toBe('function')
      expect(theme.name.length).toBeGreaterThan(0)
    }
  })

  it('every theme supplies every token in both modes', () => {
    expect(listThemes().length).toBeGreaterThan(0)

    for (const theme of listThemes()) {
      for (const mode of ['light', 'dark'] as const) {
        for (const name of TOKEN_NAMES) {
          expect(theme.tokens[mode][name], `${theme.id}.${mode}.${name}`).toBeTruthy()
        }
      }
    }
  })
})
