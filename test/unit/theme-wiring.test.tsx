import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@shared/api.ts'
import { DEFAULT_THEME_ID } from '@shared/themes.ts'
import { Portal } from '../../src/web/routes/Portal.tsx'
import * as store from '../../src/web/store.ts'
import { activeTheme, componentsFor, readThemeId } from '../../src/web/themes/active.ts'
import classic from '../../src/web/themes/classic/index.ts'
import { DEFAULT_COMPONENTS } from '../../src/web/themes/default/index.ts'
import { resolveTheme } from '../../src/web/themes/registry.ts'
import type { Theme } from '../../src/web/themes/types.ts'

// The hooks call performAction; the auto-mock stubs it. No test below clicks a
// control — verified by the absence of any `.click(` in this file.
vi.mock('../../src/web/api.ts')

const SLOTS = [
  'Shell',
  'ToggleTile',
  'CoverTile',
  'LockTile',
  'Login',
  'Disabled',
  'Unreachable',
] as const

// A constant rather than `role="guest"`: Biome's useValidAriaRole reads a
// literal `role` attribute on any JSX element as an ARIA role, component or not.
const GUEST = 'guest'

/** `classic` with its overrides stripped — the shape of a tokens-only theme. */
function bareTheme(): Theme {
  return { id: classic.id, name: classic.name, tokens: classic.tokens, icon: classic.icon }
}

describe('readThemeId', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  it('reads the id the server injected', () => {
    document.documentElement.dataset.theme = 'classic'
    expect(readThemeId()).toBe('classic')
  })

  it('falls back to the default when the attribute is absent', () => {
    expect(readThemeId()).toBe(DEFAULT_THEME_ID)
  })

  it('returns an unregistered id verbatim, leaving the degrade to resolveTheme', () => {
    // Two layers, two responsibilities. readThemeId only reports what the DOM
    // says; only the registry knows which ids exist. Asserting the raw string
    // here is what distinguishes the two — a readThemeId that validated against
    // the registry and returned 'classic' would fail this line while every
    // other assertion in the file still passed.
    document.documentElement.dataset.theme = 'midnight'

    expect(readThemeId()).toBe('midnight')
    expect(resolveTheme('midnight').id).toBe(DEFAULT_THEME_ID)
    expect(activeTheme().id).toBe(DEFAULT_THEME_ID)
  })

  it('selects the theme the attribute names when it is registered', () => {
    document.documentElement.dataset.theme = 'classic'
    expect(activeTheme()).toBe(classic)
  })
})

describe('componentsFor', () => {
  it('gives a theme with no overrides the whole default set', () => {
    const merged = componentsFor(bareTheme())

    // Identity, not shape: a merge that rebuilt equivalent wrappers would still
    // be a bug, and `toEqual` on a bag of components is close to vacuous.
    for (const slot of SLOTS) {
      expect(merged[slot], slot).toBe(DEFAULT_COMPONENTS[slot])
    }
    expect(Object.keys(merged).sort()).toEqual([...SLOTS].sort())
  })

  it('lets one override win while every other slot stays the default', () => {
    const Custom = (): null => null
    const partial: Theme = { ...bareTheme(), components: { LockTile: Custom } }

    const merged = componentsFor(partial)

    expect(merged.LockTile).toBe(Custom)
    // The half of the property that a `return theme.components` bug would pass:
    // every untouched slot must still be the default object, not undefined.
    for (const slot of SLOTS) {
      if (slot === 'LockTile') continue
      expect(merged[slot], slot).toBe(DEFAULT_COMPONENTS[slot])
    }
  })

  it('takes every slot a theme overrides from that theme', () => {
    const merged = componentsFor(classic)
    const overridden = Object.keys(classic.components ?? {}) as (typeof SLOTS)[number][]

    // Iterating the theme's own keys rather than SLOTS is what lets a slot be
    // optional: `Unreachable` is not in `classic`, and requiring it there would
    // mean every future slot costs every theme a file.
    expect(overridden.length).toBeGreaterThan(0)
    for (const slot of overridden) {
      expect(merged[slot], slot).toBe(classic.components?.[slot])
      expect(merged[slot], slot).not.toBe(DEFAULT_COMPONENTS[slot])
    }

    // The other half: a slot the theme leaves out still resolves, to the
    // default. Without this, `componentsFor` could drop it entirely and the
    // loop above would not notice.
    for (const slot of SLOTS) {
      if (overridden.includes(slot)) continue
      expect(merged[slot], slot).toBe(DEFAULT_COMPONENTS[slot])
    }
  })
})

describe('the guest route', () => {
  beforeEach(() => {
    store.resetStore()
    vi.spyOn(store, 'connectDeviceStore').mockReturnValue(() => {})
  })

  afterEach(() => {
    cleanup()
    store.resetStore()
    vi.restoreAllMocks()
  })

  it('renders tiles from the active theme rather than the default set', () => {
    const device: Device = {
      entityId: 'light.hall',
      label: 'Hall Light',
      domain: 'light',
      allowedActions: ['turn_on', 'turn_off'],
      sortOrder: 0,
      state: { state: 'off', attributes: {}, stale: false },
    }
    store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
    store.setConnected(true)

    render(<Portal role={GUEST} onLogout={async () => {}} />)

    // `classic` is what resolves with no data-theme attribute, and its tiles
    // render an MDI glyph where the default set renders no icon at all. A page
    // that still imported its tiles directly would fail this.
    expect(componentsFor(activeTheme()).ToggleTile).toBe(classic.components?.ToggleTile)
    expect(screen.getByRole('button', { name: 'Hall Light' }).querySelector('svg')).not.toBeNull()
  })
})
