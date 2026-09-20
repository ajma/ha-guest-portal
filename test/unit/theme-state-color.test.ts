import { describe, expect, it } from 'vitest'
import { dark, light } from '../../src/web/themes/classic/tokens.ts'
import {
  type StateColorToken,
  stateColorFill,
  stateColorToken,
  stateColorVar,
} from '../../src/web/themes/stateColor.ts'
import { TOKEN_NAMES } from '../../src/web/themes/tokens.ts'

// Home Assistant's own state palette, from
// src/resources/theme/color/color.globals.ts. Written out here rather than read
// from classic/tokens.ts so this file is an independent statement of what the
// colours must be — a tokens.ts that drifts to a different amber fails here.
const AMBER = '#ffc107'
const CYAN = '#00bcd4'
const PURPLE = '#926bc7'
const GREEN = '#4caf50'
const RED = '#f44336'
const ORANGE = '#ff9800'
const GREY = '#9e9e9e'

/** The colour classic actually paints for a (domain, state) pair. */
function colorOf(domain: string | null, state: string): string {
  return light[stateColorToken(domain, state)]
}

describe('stateColorToken', () => {
  it('maps each active domain to its own role', () => {
    expect(stateColorToken('light', 'on')).toBe('stateLightActive')
    expect(stateColorToken('switch', 'on')).toBe('stateSwitchActive')
    expect(stateColorToken('input_boolean', 'on')).toBe('stateSwitchActive')
    expect(stateColorToken('fan', 'on')).toBe('stateFanActive')
    expect(stateColorToken('cover', 'open')).toBe('stateCoverActive')
    expect(stateColorToken('lock', 'locked')).toBe('stateLockLocked')
    expect(stateColorToken('lock', 'unlocked')).toBe('stateLockUnlocked')
    expect(stateColorToken('lock', 'jammed')).toBe('stateLockJammed')
  })

  it('maps every inactive state to the inactive role', () => {
    // Kills a resolver that keys only on the domain and ignores the state —
    // it would return stateLightActive for an off light.
    expect(stateColorToken('light', 'off')).toBe('stateInactive')
    expect(stateColorToken('switch', 'off')).toBe('stateInactive')
    expect(stateColorToken('fan', 'off')).toBe('stateInactive')
    expect(stateColorToken('cover', 'closed')).toBe('stateInactive')
    expect(stateColorToken('light', 'unavailable')).toBe('stateInactive')
    expect(stateColorToken('lock', 'unavailable')).toBe('stateInactive')
  })

  it('maps every mid-flight state to the transitioning role, whatever the domain', () => {
    for (const [domain, state] of [
      ['cover', 'opening'],
      ['cover', 'closing'],
      ['lock', 'locking'],
      ['lock', 'unlocking'],
    ] as const) {
      expect(stateColorToken(domain, state), `${domain}/${state}`).toBe('stateTransitioning')
    }
  })

  it('degrades an unknown or absent domain to the inactive role', () => {
    expect(stateColorToken(null, 'on')).toBe('stateInactive')
    expect(stateColorToken('media_player', 'playing')).toBe('stateInactive')
  })

  it('treats an opened openable lock as unlocked, not as an open cover', () => {
    // `open` means two different things in two domains and a resolver that
    // checked the state before the domain would colour an open lock purple.
    expect(stateColorToken('lock', 'open')).toBe('stateLockUnlocked')
    expect(stateColorToken('cover', 'open')).toBe('stateCoverActive')
  })

  it('returns only names that exist in the closed token set', () => {
    // A role no theme declares resolves to an undefined custom property, which
    // paints as transparent rather than failing — so it has to be caught here.
    const names: readonly string[] = TOKEN_NAMES
    for (const state of [
      'on',
      'off',
      'open',
      'closed',
      'locked',
      'unlocked',
      'jammed',
      'opening',
    ]) {
      for (const domain of [null, 'light', 'switch', 'fan', 'input_boolean', 'cover', 'lock']) {
        const token = stateColorToken(domain, state)
        expect(names, `${domain ?? 'null'}/${state}`).toContain(token)
      }
    }
  })
})

describe('the colours classic resolves through it', () => {
  it('paints each state the colour Home Assistant paints it', () => {
    expect(colorOf('light', 'on'), 'an active light is amber').toBe(AMBER)
    expect(colorOf('light', 'off'), 'an inactive light is grey').toBe(GREY)
    expect(colorOf('switch', 'on'), 'an active switch is amber').toBe(AMBER)
    expect(colorOf('fan', 'on'), 'an active fan is cyan').toBe(CYAN)
    expect(colorOf('cover', 'open'), 'an open cover is purple').toBe(PURPLE)
    expect(colorOf('cover', 'closed'), 'a closed cover is grey').toBe(GREY)
    expect(colorOf('lock', 'locked'), 'a locked lock is green').toBe(GREEN)
    expect(colorOf('lock', 'unlocked'), 'an unlocked lock is red').toBe(RED)
    expect(colorOf('lock', 'jammed'), 'a jammed lock is red').toBe(RED)
    expect(colorOf('cover', 'opening'), 'a moving cover is orange').toBe(ORANGE)
    expect(colorOf('lock', 'unlocking'), 'a turning lock is orange').toBe(ORANGE)
  })

  it('gives the distinct roles distinct colours', () => {
    // Kills the whole class of one-colour-for-everything mutants, including a
    // tokens.ts that declares nine names all pointing at the same hex.
    const distinct = [
      colorOf('light', 'off'),
      colorOf('light', 'on'),
      colorOf('fan', 'on'),
      colorOf('cover', 'open'),
      colorOf('lock', 'locked'),
      colorOf('lock', 'unlocked'),
      colorOf('cover', 'opening'),
    ]
    expect(new Set(distinct).size).toBe(distinct.length)
  })

  it('uses the same state palette in dark mode', () => {
    // Home Assistant's state colours do not change with the colour scheme; an
    // amber light is amber on both surfaces.
    for (const name of TOKEN_NAMES) {
      if (!name.startsWith('state')) continue
      expect(dark[name], name).toBe(light[name])
    }
  })
})

describe('stateColorVar and stateColorFill', () => {
  const token: StateColorToken = 'stateLightActive'

  it('reference the custom property rather than resolving a colour', () => {
    // The whole point of the token indirection: a component must never hold a
    // channel value, or a theme cannot restyle it.
    expect(stateColorVar(token)).toBe('var(--stateLightActive)')
    expect(stateColorVar(token)).not.toMatch(/#[0-9a-f]{3,8}/i)
  })

  it('fill is the same colour at 20%, with the colour still in the property', () => {
    // Kills a fill that drops to a hardcoded translucent grey, one that forgets
    // the 20% and paints solid, and one that mixes the wrong token.
    expect(stateColorFill(token)).toBe(
      'color-mix(in srgb, var(--stateLightActive) 20%, transparent)',
    )
    expect(stateColorFill('stateLockLocked')).toContain('var(--stateLockLocked)')
    expect(stateColorFill(token)).toContain('20%')
  })
})
