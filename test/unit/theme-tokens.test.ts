import { describe, expect, it } from 'vitest'
import { TOKEN_NAMES, type ThemeTokens, tokensToCss } from '../../src/web/themes/tokens.ts'

// One distinct value per token name so a bug that mixes up names/values, drops
// a token, or emits an empty declaration is visible in the output.
const sampleTokens: ThemeTokens = {
  appBg: 'appBg-value',
  surface: 'surface-value',
  surfaceRaised: 'surfaceRaised-value',
  surfaceActive: 'surfaceActive-value',
  text: 'text-value',
  textMuted: 'textMuted-value',
  accent: 'accent-value',
  accentText: 'accentText-value',
  danger: 'danger-value',
  border: 'border-value',
  controlNeutral: 'controlNeutral-value',
  tileRadius: 'tileRadius-value',
  tileGap: 'tileGap-value',
  tilePadding: 'tilePadding-value',
  fontFamily: 'fontFamily-value',
  shadow: 'shadow-value',
  stateInactive: 'stateInactive-value',
  stateLightActive: 'stateLightActive-value',
  stateSwitchActive: 'stateSwitchActive-value',
  stateFanActive: 'stateFanActive-value',
  stateCoverActive: 'stateCoverActive-value',
  stateLockLocked: 'stateLockLocked-value',
  stateLockUnlocked: 'stateLockUnlocked-value',
  stateLockJammed: 'stateLockJammed-value',
  stateTransitioning: 'stateTransitioning-value',
}

// Hand-written, not derived from TOKEN_NAMES or tokensToCss, so it cannot pass
// merely by mirroring whatever the implementation happens to do.
const expectedCss = [
  '  --appBg: appBg-value;',
  '  --surface: surface-value;',
  '  --surfaceRaised: surfaceRaised-value;',
  '  --surfaceActive: surfaceActive-value;',
  '  --text: text-value;',
  '  --textMuted: textMuted-value;',
  '  --accent: accent-value;',
  '  --accentText: accentText-value;',
  '  --danger: danger-value;',
  '  --border: border-value;',
  '  --controlNeutral: controlNeutral-value;',
  '  --tileRadius: tileRadius-value;',
  '  --tileGap: tileGap-value;',
  '  --tilePadding: tilePadding-value;',
  '  --fontFamily: fontFamily-value;',
  '  --shadow: shadow-value;',
  '  --stateInactive: stateInactive-value;',
  '  --stateLightActive: stateLightActive-value;',
  '  --stateSwitchActive: stateSwitchActive-value;',
  '  --stateFanActive: stateFanActive-value;',
  '  --stateCoverActive: stateCoverActive-value;',
  '  --stateLockLocked: stateLockLocked-value;',
  '  --stateLockUnlocked: stateLockUnlocked-value;',
  '  --stateLockJammed: stateLockJammed-value;',
  '  --stateTransitioning: stateTransitioning-value;',
].join('\n')

describe('TOKEN_NAMES', () => {
  it('has no duplicate entries', () => {
    // Kills a mutant that accidentally lists a token twice (and therefore, by
    // construction, silently omits another one since the closed set is fixed
    // in size everywhere else in the plan).
    expect(new Set(TOKEN_NAMES).size).toBe(TOKEN_NAMES.length)
  })
})

describe('tokensToCss', () => {
  it('emits exactly one declaration per token, in order, with values interpolated', () => {
    // Kills: dropping/reordering a token, wrong `--name: value;` syntax, wrong
    // join character, and a version that emits the token name instead of its
    // value (or vice versa) — the exact string only matches a correct impl.
    expect(tokensToCss(sampleTokens)).toBe(expectedCss)
  })

  it('includes a declaration for every name in TOKEN_NAMES, and only those', () => {
    const css = tokensToCss(sampleTokens)
    const lines = css.split('\n')
    // Kills a version that silently drops (or adds) a token: the line count
    // must match the closed set exactly.
    expect(lines).toHaveLength(TOKEN_NAMES.length)
    for (const name of TOKEN_NAMES) {
      expect(
        lines.some((line) => line.includes(`--${name}:`)),
        `missing declaration for ${name}`,
      ).toBe(true)
    }
  })

  it('interpolates the actual token value rather than emitting an empty declaration', () => {
    const css = tokensToCss(sampleTokens)
    // Kills a mutant like `--${name}: ;` that emits the property name but
    // forgets (or mistypes) the interpolation of tokens[name].
    expect(css).not.toMatch(/--[a-zA-Z]+:\s*;/)
    expect(css).toContain('--appBg: appBg-value;')
    expect(css).toContain('--shadow: shadow-value;')
  })
})
