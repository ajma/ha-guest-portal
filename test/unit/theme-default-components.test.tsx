import { readFileSync, readdirSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@shared/api.js'
import { DEFAULT_COMPONENTS } from '../../src/web/themes/default/index.ts'

// The hooks call performAction; the auto-mock stubs it to return undefined,
// which would throw if any test path actually invoked it. None of the tests
// below click a control, so performAction is never called — verified by the
// absence of any `.click(` in this file.
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

describe('default component set', () => {
  it('has a component for every slot', () => {
    for (const slot of ['Shell', 'ToggleTile', 'CoverTile', 'LockTile', 'Login', 'Disabled'] as const) {
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
    }
  })
})
