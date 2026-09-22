import { readFileSync, readdirSync } from 'node:fs'
import { cleanup, render as renderBare, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@shared/api.js'
import type { ReactElement } from 'react'
import { PortalIdProvider } from '../../src/web/portalContext.ts'
import { DEFAULT_COMPONENTS } from '../../src/web/themes/default/index.ts'

// The hooks call performAction; the auto-mock stubs it to return undefined,
// which would throw if any test path actually invoked it. None of the tests
// below click a control, so performAction is never called — verified by the
// absence of any `.click(` in this file.
vi.mock('../../src/web/api.ts')

// A tile reads the portal it acts on from context, the way the page supplies
// it. Rendering one without a provider is the no-portal render `usePortalId`
// exists to refuse, not a shorthand for it.
function render(ui: ReactElement): ReturnType<typeof renderBare> {
  return renderBare(<PortalIdProvider value="portal-1">{ui}</PortalIdProvider>)
}

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

describe('default component set', () => {
  it('has a component for every slot', () => {
    for (const slot of [
      'Shell',
      'ToggleTile',
      'CoverTile',
      'LockTile',
      'Login',
      'Disabled',
      'Unreachable',
    ] as const) {
      expect(DEFAULT_COMPONENTS[slot], slot).toBeDefined()
    }
  })

  it('renders a toggle tile', () => {
    const { ToggleTile } = DEFAULT_COMPONENTS
    render(<ToggleTile device={device('light')} disabled={false} />)
    // Kills a mutant that drops the interactive control (e.g. renders a <div> label only).
    expect(screen.getByRole('button', { name: 'Thing' })).toBeTruthy()
    // Kills a mutant that drops or corrupts the hook-derived state text.
    expect(screen.getByText('Off')).toBeTruthy()
  })

  it('renders a cover tile', () => {
    const { CoverTile } = DEFAULT_COMPONENTS
    render(
      <CoverTile
        device={device('cover', { state: { state: 'closed', attributes: {}, stale: false } })}
        disabled={false}
      />,
    )
    expect(screen.getByText('Thing')).toBeTruthy()
    // Kills a mutant that drops the Open/Close controls.
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    // Kills a mutant that drops or corrupts the hook-derived state text.
    expect(screen.getByText('Closed')).toBeTruthy()
  })

  it('renders a lock tile', () => {
    const { LockTile } = DEFAULT_COMPONENTS
    render(<LockTile device={device('lock')} disabled={false} />)
    expect(screen.getByText('Thing')).toBeTruthy()
    // Kills a mutant that drops the Lock/Unlock controls.
    expect(screen.getByRole('button', { name: 'Lock' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()
    // Kills a mutant that drops or corrupts the hook-derived state text.
    expect(screen.getByText('Locked')).toBeTruthy()
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    // Guards the property that makes overrides optional: if a default
    // component hardcodes a colour, a tokens-only theme cannot restyle it.
    const dir = 'src/web/themes/default'
    const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'))
    // A scan over zero files would pass vacuously forever and prove nothing —
    // fail loudly if the directory is missing or empty instead.
    expect(files.length).toBeGreaterThan(0)

    for (const f of files) {
      const src = readFileSync(`${dir}/${f}`, 'utf-8')
      expect(src, `${f} uses a Tailwind palette colour`).not.toMatch(
        /\b(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate|zinc)-\d{2,3}\b/,
      )
      // This codebase genuinely uses raw hex elsewhere (PortalToggle.tsx, EntityPicker.tsx),
      // so hex is a live idiom here and must be caught in the theme-default files too.
      expect(src, `${f} uses a hex colour literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, `${f} uses a raw CSS colour function`).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
      // Named colours were the one hole every scan but Task 7's left open.
      // `'white'` is as untokenised as `#fff`, and is what EntityPicker
      // actually shipped.
      expect(src, `${f} uses a named colour`).not.toMatch(/['"](?:white|black)['"]/)
    }
  })
})
