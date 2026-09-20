import { readFileSync, readdirSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@shared/api.js'
import type { SupportedDomain } from '@shared/devices.js'
import classic from '../../src/web/themes/classic/index.ts'
import type { Theme } from '../../src/web/themes/types.ts'

// The hooks call performAction; the auto-mock stubs it to return undefined,
// which would throw if any test path actually invoked it. No test below clicks
// a control — verified by the absence of any `.click(` in this file.
vi.mock('../../src/web/api.ts')

afterEach(() => {
  cleanup()
})

function device(domain: string, overrides: Partial<Device> = {}): Device {
  return {
    entityId: `${domain}.thing`,
    label: 'Thing',
    domain,
    allowedActions:
      domain === 'lock'
        ? ['lock', 'unlock']
        : domain === 'cover'
          ? ['open_cover', 'close_cover']
          : ['turn_on', 'turn_off'],
    sortOrder: 0,
    state: { state: domain === 'lock' ? 'locked' : 'off', attributes: {}, stale: false },
    ...overrides,
  }
}

/** Render the resolver's output and read back the single SVG path it emitted. */
function iconPath(domain: SupportedDomain, state: string): string | null {
  const { container, unmount } = render(classic.icon(domain, state))
  const path = container.querySelector('path')?.getAttribute('d') ?? null
  unmount()
  return path
}

type ComponentSlots = NonNullable<Theme['components']>

/**
 * Resolve one component slot as a defined value. Narrowed by an explicit check
 * rather than a `!` assertion — this codebase runs `noUncheckedIndexedAccess`
 * and carries zero lint warnings, and a missing slot should fail loudly here
 * rather than surface as an unreadable render error.
 */
function slotOf<K extends keyof ComponentSlots>(key: K): NonNullable<ComponentSlots[K]> {
  const component = classic.components?.[key]
  if (component === undefined) throw new Error(`classic declares no ${key}`)
  return component
}

describe('classic theme', () => {
  it('declares its identity and both modes', () => {
    expect(classic.id).toBe('classic')
    expect(classic.name).toBe('Classic')
    expect(classic.tokens.light.accent).toBeTruthy()
    expect(classic.tokens.dark.accent).toBeTruthy()
  })

  it('resolves an icon per supported domain', () => {
    for (const domain of ['light', 'switch', 'fan', 'input_boolean', 'cover', 'lock'] as const) {
      const { container } = render(classic.icon(domain, 'on'))
      expect(container.querySelector('svg'), domain).toBeTruthy()
      expect(container.querySelector('path')?.getAttribute('d'), domain).toBeTruthy()
      cleanup()
    }
  })

  it('resolves a different icon for each domain', () => {
    // Kills a resolver that ignores `domain` and returns one generic glyph.
    const paths = (['light', 'switch', 'fan', 'cover', 'lock'] as const).map((d) =>
      iconPath(d, 'on'),
    )
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('resolves a different icon for each state of a domain', () => {
    // Merely asserting an <svg> exists passes for a resolver that ignores both
    // of its arguments. Contrasting two states of the same domain kills that.
    const pairs = [
      { domain: 'light', on: 'on', off: 'off' },
      { domain: 'switch', on: 'on', off: 'off' },
      { domain: 'fan', on: 'on', off: 'off' },
      { domain: 'input_boolean', on: 'on', off: 'off' },
      { domain: 'cover', on: 'open', off: 'closed' },
      { domain: 'lock', on: 'locked', off: 'unlocked' },
    ] as const

    for (const { domain, on, off } of pairs) {
      const active = iconPath(domain, on)
      const inactive = iconPath(domain, off)
      expect(active, domain).toBeTruthy()
      expect(active, domain).not.toBe(inactive)
    }
  })

  it('overrides every component slot', () => {
    for (const slot of [
      'Shell',
      'ToggleTile',
      'CoverTile',
      'LockTile',
      'Login',
      'Disabled',
    ] as const) {
      expect(classic.components?.[slot], slot).toBeDefined()
    }
  })

  it('renders a toggle tile with its control and state', () => {
    const ToggleTile = slotOf('ToggleTile')
    render(<ToggleTile device={device('light')} disabled={false} />)

    // Kills a mutant that renders the label but drops the interactive control.
    expect(screen.getByRole('button', { name: 'Thing' })).toBeTruthy()
    // Kills a mutant that drops or corrupts the hook-derived state text.
    expect(screen.getByText('Off')).toBeTruthy()
  })

  it('renders a cover tile with its controls and state', () => {
    const CoverTile = slotOf('CoverTile')
    render(
      <CoverTile
        device={device('cover', { state: { state: 'closed', attributes: {}, stale: false } })}
        disabled={false}
      />,
    )

    expect(screen.getByText('Thing')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(screen.getByText('Closed')).toBeTruthy()
  })

  it('renders a lock tile with the device label, its controls and its state', () => {
    const LockTile = slotOf('LockTile')
    render(
      <LockTile
        device={{
          entityId: 'lock.front',
          label: 'Front Door',
          domain: 'lock',
          allowedActions: ['lock', 'unlock'],
          sortOrder: 0,
          state: { state: 'locked', attributes: {}, stale: false },
        }}
        disabled={false}
      />,
    )

    expect(screen.getByText('Front Door')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Lock' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()
    expect(screen.getByText('Locked')).toBeTruthy()
  })

  it('fills the icon circle with the state colour at 20% and the glyph at full strength', () => {
    // Home Assistant's ha-tile-icon: a layer of the state colour at opacity
    // 0.2 behind a glyph in the same colour, undimmed. Kills the previous
    // design — a solid --accent circle with an --accentText glyph — and any
    // mutant that drops the fade and paints the pill solid.
    const ToggleTile = slotOf('ToggleTile')
    const { container } = render(
      <ToggleTile
        device={device('light', { state: { state: 'on', attributes: {}, stale: false } })}
        disabled={false}
      />,
    )

    const layer = container.querySelector('[data-testid="tile-icon-bg"]')
    expect(layer).not.toBeNull()
    expect(layer?.getAttribute('style')).toContain('var(--stateLightActive)')
    expect(layer?.className).toContain('opacity-[0.2]')

    const glyph = container.querySelector('svg')?.parentElement
    expect(glyph?.getAttribute('style')).toContain('var(--stateLightActive)')
    // The glyph must not sit inside the faded layer, or it inherits the 20%.
    expect(layer?.contains(glyph ?? null)).toBe(false)
  })

  it('colours the icon by domain and state rather than from one accent', () => {
    // Kills a tile that hardcodes a single token: every pair below would be
    // identical, and an off light would look the same as an on one.
    const ToggleTile = slotOf('ToggleTile')
    const LockTile = slotOf('LockTile')
    const CoverTile = slotOf('CoverTile')

    function glyphStyle(ui: ReactElement): string {
      const { container, unmount } = render(ui)
      const style = container.querySelector('svg')?.parentElement?.getAttribute('style') ?? ''
      unmount()
      return style
    }

    const on = { state: 'on', attributes: {}, stale: false }
    const off = { state: 'off', attributes: {}, stale: false }

    expect(glyphStyle(<ToggleTile device={device('light', { state: on })} disabled={false} />)) //
      .toContain('var(--stateLightActive)')
    expect(glyphStyle(<ToggleTile device={device('light', { state: off })} disabled={false} />)) //
      .toContain('var(--stateInactive)')
    expect(glyphStyle(<ToggleTile device={device('fan', { state: on })} disabled={false} />)) //
      .toContain('var(--stateFanActive)')
    expect(
      glyphStyle(
        <CoverTile
          device={device('cover', { state: { state: 'open', attributes: {}, stale: false } })}
          disabled={false}
        />,
      ),
    ).toContain('var(--stateCoverActive)')
    expect(glyphStyle(<LockTile device={device('lock')} disabled={false} />)) //
      .toContain('var(--stateLockLocked)')
  })

  it('greys the icon of a stale device instead of showing its last colour', () => {
    // A stale light reports Unknown, so painting it amber would assert a state
    // the portal does not actually know.
    const ToggleTile = slotOf('ToggleTile')
    const { container } = render(
      <ToggleTile
        device={device('light', { state: { state: 'on', attributes: {}, stale: true } })}
        disabled={false}
      />,
    )

    expect(container.querySelector('svg')?.parentElement?.getAttribute('style')).toContain(
      'var(--stateInactive)',
    )
  })

  it('carries no switch graphic — the row is icon and text only', () => {
    // Home Assistant's tile card has no switch: the whole tile is the control
    // and the icon colour carries the state. Kills a re-added decorative
    // control, which is the single most visible departure from HA's tile.
    const ToggleTile = slotOf('ToggleTile')
    render(<ToggleTile device={device('light')} disabled={false} />)

    const row = screen.getByRole('button', { name: 'Thing' })
    expect(row.children).toHaveLength(2)
  })

  it('puts the cover controls in a row beneath the info row, filled neutral', () => {
    // Home Assistant's features slot sits BELOW the icon-and-text row, never
    // inline to its right, and each control keeps ha-control-button's default
    // background — the neutral --disabled-color at 20%, not the state colour.
    // card-feature-styles.ts hands the state colour to the focus ring only.
    const CoverTile = slotOf('CoverTile')
    render(
      <CoverTile
        device={device('cover', { state: { state: 'open', attributes: {}, stale: false } })}
        disabled={false}
      />,
    )

    const open = screen.getByRole('button', { name: 'Open' })
    const infoRow = screen.getByText('Thing').parentElement?.parentElement
    expect(infoRow).not.toBeNull()
    // Kills the previous layout, where the controls were children of the row.
    expect(infoRow?.contains(open)).toBe(false)

    const fill = open.querySelector('[data-testid="control-button-bg"]')
    expect(fill?.getAttribute('style')).toContain('var(--controlNeutral)')
    // Kills the state-tinted implementation this replaced: an open cover is
    // purple on its icon, and the control must not pick that up.
    expect(fill?.getAttribute('style')).not.toContain('var(--stateCoverActive)')
    expect(fill?.className).toContain('opacity-[0.2]')
  })

  it('gives the feature buttons the same neutral fill whatever the state is', () => {
    // The discriminating half of the rule. Asserting "neutral" alone passes for
    // a stub that hardcodes one colour everywhere AND for an implementation
    // that still varies but happens to be neutral in the sampled state; this
    // contrasts two states of the same domain and two different domains.
    //
    // The icon circles MUST still differ across the same pair, or the tile
    // would have lost its state cue altogether rather than moved it.
    const LockTile = slotOf('LockTile')
    const CoverTile = slotOf('CoverTile')

    function fillsOf(ui: ReactElement, names: readonly string[]): string[] {
      const { unmount } = render(ui)
      const fills = names.map((name) => {
        const button = screen.getByRole('button', { name })
        return (
          button.querySelector('[data-testid="control-button-bg"]')?.getAttribute('style') ?? ''
        )
      })
      unmount()
      return fills
    }

    function iconFillOf(ui: ReactElement): string {
      const { container, unmount } = render(ui)
      const style =
        container.querySelector('[data-testid="tile-icon-bg"]')?.getAttribute('style') ?? ''
      unmount()
      return style
    }

    const lockedLock = <LockTile device={device('lock')} disabled={false} />
    const unlockedLock = (
      <LockTile
        device={device('lock', { state: { state: 'unlocked', attributes: {}, stale: false } })}
        disabled={false}
      />
    )
    const openCover = (
      <CoverTile
        device={device('cover', { state: { state: 'open', attributes: {}, stale: false } })}
        disabled={false}
      />
    )

    const locked = fillsOf(lockedLock, ['Lock', 'Unlock'])
    const unlocked = fillsOf(unlockedLock, ['Lock', 'Unlock'])
    const cover = fillsOf(openCover, ['Open', 'Close'])

    // Every feature button on every tile carries the one neutral fill.
    for (const fill of [...locked, ...unlocked, ...cover]) {
      expect(fill).toContain('var(--controlNeutral)')
    }
    // Kills the old per-action tinting: Lock was green and Unlock red.
    expect(new Set([...locked, ...unlocked, ...cover]).size).toBe(1)

    // ...while the state cue itself survives, on the icon where HA puts it.
    expect(iconFillOf(lockedLock)).toContain('var(--stateLockLocked)')
    expect(iconFillOf(unlockedLock)).toContain('var(--stateLockUnlocked)')
    expect(iconFillOf(lockedLock)).not.toBe(iconFillOf(unlockedLock))
  })

  it('sizes a feature button the way Home Assistant does', () => {
    // --feature-height is --ha-space-9 (36px, `h-9`) and the radius is
    // --ha-border-radius-md (8px). Kills the 40px button this replaced, and a
    // fill layer that is opaque rather than HA's 20%.
    const CoverTile = slotOf('CoverTile')
    render(
      <CoverTile
        device={device('cover', { state: { state: 'closed', attributes: {}, stale: false } })}
        disabled={false}
      />,
    )

    const open = screen.getByRole('button', { name: 'Open' })
    expect(open.className).toContain('h-9')
    expect(open.className).not.toContain('h-10')
    expect(open.className).toContain('rounded-[8px]')
    expect(open.className).toContain('font-medium')
    expect(open.className).toContain('text-[var(--text)]')
    expect(
      open.querySelector('[data-testid="control-button-bg"]')?.className,
      'the fill must stay at 20% or the label loses contrast',
    ).toContain('opacity-[0.2]')

    // --control-button-group-spacing: 12px between buttons, i.e. `gap-3`.
    const row = open.parentElement
    expect(row?.className).toContain('gap-3')
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    // Same guard the default set carries: a component that hardcodes a colour
    // cannot be restyled by tokens, and classic's own palette must live only in
    // tokens.ts. Only .tsx files are scanned, which excludes tokens.ts — it
    // legitimately holds the hex palette and an rgba() shadow.
    const dir = 'src/web/themes/classic'
    const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'))
    // A scan over zero files would pass vacuously forever and prove nothing.
    expect(files.length).toBeGreaterThan(0)

    for (const f of files) {
      const src = readFileSync(`${dir}/${f}`, 'utf-8')
      expect(src, `${f} uses a Tailwind palette colour`).not.toMatch(
        /\b(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate|zinc)-\d{2,3}\b/,
      )
      expect(src, `${f} uses a hex colour literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, `${f} uses a raw CSS colour function`).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
    }
  })
})
