import { readFileSync, readdirSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
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
