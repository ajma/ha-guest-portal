import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../src/shared/themes.ts'
import { listThemes, resolveTheme } from '../../src/web/themes/registry.ts'
import { TOKEN_NAMES } from '../../src/web/themes/tokens.ts'

describe('theme registry', () => {
  // Every declared id now resolves to the theme that claims it. This was
  // marked expected-fail through phases 1 and 2, when the missing ids fell back to
  // classic; it is the assertion that a registry ignoring its argument — the
  // one mutant that survived Task 7 by construction — can no longer pass.
  it('resolves every declared id', () => {
    for (const id of THEME_IDS) {
      expect(resolveTheme(id).id).toBe(id)
    }
  })

  it('falls back to classic for an unknown id rather than throwing', () => {
    expect(resolveTheme('bogus').id).toBe('classic')
  })

  // Also expected-fail until the third theme arrived — see the note above. Now it
  // is the guard that a theme declared in the shared contract is actually
  // registered, and that nothing is registered under an id the server would
  // refuse to store.
  it('registry keys match THEME_IDS exactly', () => {
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

  it('the generated CSS is up to date with the TypeScript tokens', () => {
    // src/web/themes/generated.css is what the browser actually reads, and it
    // applies before any JavaScript runs. Editing a token in TypeScript and
    // forgetting to regenerate would leave the two silently disagreeing, with
    // the stylesheet winning — so the check is a test, not a discipline.
    //
    // `tsx`, not `node --experimental-strip-types`: type stripping does not
    // remap the `.js` import specifiers used inside src/ back to .ts/.tsx, so
    // the generator's import of themes/classic/index.js cannot resolve, and the
    // JSX it pulls in transitively would not compile either. Invoked by path
    // rather than by bare name so this does not depend on node_modules/.bin
    // being on PATH.
    expect(() =>
      execFileSync('node_modules/.bin/tsx', ['scripts/generate-theme-css.ts', '--check'], {
        stdio: 'pipe',
      }),
    ).not.toThrow()
  }, 30_000)

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
