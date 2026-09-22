import { readFileSync, readdirSync } from 'node:fs'
import { cleanup, render as renderBare, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@shared/api.js'
import type { SupportedDomain } from '@shared/devices.js'
import * as api from '../../src/web/api.ts'
import { PortalIdProvider } from '../../src/web/portalContext.ts'
import tiles from '../../src/web/themes/tiles/index.ts'
import { TOKEN_NAMES } from '../../src/web/themes/tokens.ts'
import type { Theme } from '../../src/web/themes/types.ts'

// The hooks call performAction. Only one test below presses anything, and the
// press it makes is the one that must NOT reach the network — the unlock
// confirmation intercepts it — so the auto-mock's undefined return is never
// awaited.
vi.mock('../../src/web/api.ts')

// A tile reads the portal it acts on from context, the way the page supplies
// it. Rendering one without a provider is the no-portal render `usePortalId`
// exists to refuse, not a shorthand for it.
function render(ui: ReactElement): ReturnType<typeof renderBare> {
  return renderBare(<PortalIdProvider value="portal-1">{ui}</PortalIdProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
})

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
          ? ['open_cover', 'close_cover', 'stop_cover']
          : ['turn_on', 'turn_off'],
    sortOrder: 0,
    state: { state: domain === 'lock' ? 'locked' : 'off', attributes: {}, stale: false },
    ...overrides,
  }
}

function at(state: string): Device['state'] {
  return { state, attributes: {}, stale: false }
}

/**
 * Every path the resolver drew, joined. Not just the first: these glyphs are
 * built from several strokes, and a lightbulb differs from a lit lightbulb only
 * by the rays.
 */
function iconPaths(domain: SupportedDomain, state: string): string {
  const { container, unmount } = render(tiles.icon(domain, state))
  const d = [...container.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|')
  unmount()
  return d
}

type ComponentSlots = NonNullable<Theme['components']>

/**
 * Resolve one component slot as a defined value. Narrowed by an explicit check
 * rather than a `!` assertion — this codebase runs `noUncheckedIndexedAccess`
 * and carries zero lint warnings, and a missing slot should fail loudly here
 * rather than surface as an unreadable render error.
 */
function slotOf<K extends keyof ComponentSlots>(key: K): NonNullable<ComponentSlots[K]> {
  const component = tiles.components?.[key]
  if (component === undefined) throw new Error(`tiles declares no ${key}`)
  return component
}

/** The tile's own square — the element this theme floods with colour. */
function cardStyle(ui: ReactElement): string {
  const { container, unmount } = render(ui)
  const style = container.querySelector('[data-testid="tile-card"]')?.getAttribute('style') ?? ''
  unmount()
  return style
}

describe('tiles theme', () => {
  it('declares its identity and both modes', () => {
    expect(tiles.id).toBe('tiles')
    expect(tiles.name).toBe('Tiles')
    expect(tiles.tokens.light.accent).toBeTruthy()
    expect(tiles.tokens.dark.accent).toBeTruthy()
  })

  it('supplies every token in both modes', () => {
    // The token set is closed: a theme missing one cannot be rendered by the
    // default component set, which is the property that makes overrides
    // optional. The registry test asserts this across the registry; asserting
    // it here too means a missing token names THIS theme when it fails.
    for (const mode of ['light', 'dark'] as const) {
      for (const name of TOKEN_NAMES) {
        expect(tiles.tokens[mode][name], `${mode}.${name}`).toBeTruthy()
      }
    }
  })

  it('is genuinely dark in dark mode rather than one palette declared twice', () => {
    // Kills a tokens file that spreads one object into both modes: this theme
    // is dark-first, and its dark surfaces are the whole look.
    expect(tiles.tokens.dark.appBg).not.toBe(tiles.tokens.light.appBg)
    expect(tiles.tokens.dark.surface).not.toBe(tiles.tokens.light.surface)
    expect(tiles.tokens.dark.text).not.toBe(tiles.tokens.light.text)
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
      expect(tiles.components?.[slot], slot).toBeDefined()
    }
  })

  it('resolves an icon per supported domain', () => {
    for (const domain of ['light', 'switch', 'fan', 'input_boolean', 'cover', 'lock'] as const) {
      const { container } = render(tiles.icon(domain, 'on'))
      expect(container.querySelector('svg'), domain).toBeTruthy()
      expect(container.querySelector('path')?.getAttribute('d'), domain).toBeTruthy()
      cleanup()
    }
  })

  it('resolves a different icon for each domain', () => {
    // Kills a resolver that ignores `domain` and returns one generic glyph.
    const drawn = (['light', 'switch', 'fan', 'cover', 'lock'] as const).map((d) =>
      iconPaths(d, 'on'),
    )
    expect(new Set(drawn).size).toBe(drawn.length)
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
      const active = iconPaths(domain, on)
      expect(active, domain).toBeTruthy()
      expect(active, domain).not.toBe(iconPaths(domain, off))
    }
  })

  it('makes the whole tile the control', () => {
    // HomeKit-style: one button covering the tile, not a control inside a card.
    // The count alone would pass for a small switch beside the text, so the
    // button must also be full width and must contain the icon and both lines
    // — which is what "tapping anywhere toggles" actually means.
    const ToggleTile = slotOf('ToggleTile')
    const { container } = render(<ToggleTile device={device('light')} disabled={false} />)

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)

    const button = buttons[0]
    expect(button).toBeDefined()
    expect(button?.className).toContain('w-full')
    expect(button?.querySelector('svg'), 'the icon is inside the control').not.toBeNull()
    expect(button?.contains(screen.getByText('Thing'))).toBe(true)
    expect(button?.contains(screen.getByText('Off'))).toBe(true)

    // A square, not a row: the icon sits above the name rather than beside it.
    // Without this the assertion passes for `classic`'s tile, which is also one
    // full-width button wrapping an icon and two lines of text.
    const body = button?.firstElementChild
    expect(body?.className).toContain('flex-col')
    expect(body?.className).toContain('min-h-[96px]')
  })

  it('floods an active tile with its state colour, not with one shared accent', () => {
    // The point of the theme AND of the state roles at once. Flooding
    // everything with --accent would make a locked door and a lit lamp
    // identical; this asserts they are not, and names the token each takes.
    const ToggleTile = slotOf('ToggleTile')
    const LockTile = slotOf('LockTile')
    const CoverTile = slotOf('CoverTile')

    const litLight = cardStyle(
      <ToggleTile device={device('light', { state: at('on') })} disabled={false} />,
    )
    const lockedLock = cardStyle(<LockTile device={device('lock')} disabled={false} />)
    const openCover = cardStyle(
      <CoverTile device={device('cover', { state: at('open') })} disabled={false} />,
    )

    expect(litLight).toContain('var(--stateLightActive)')
    expect(lockedLock).toContain('var(--stateLockLocked)')
    expect(openCover).toContain('var(--stateCoverActive)')
    expect(new Set([litLight, lockedLock, openCover]).size).toBe(3)

    // Kills the stale instruction this replaced: flood with --accent.
    expect(lockedLock).not.toContain('var(--accent)')
  })

  it('leaves an inactive tile on the plain surface', () => {
    // Kills a tile that always floods — an off light would then be as loud as
    // a lit one and the flood would carry no information at all.
    const ToggleTile = slotOf('ToggleTile')
    const CoverTile = slotOf('CoverTile')

    const offLight = cardStyle(<ToggleTile device={device('light')} disabled={false} />)
    expect(offLight).toContain('var(--surface)')
    expect(offLight).not.toContain('var(--state')

    const closedCover = cardStyle(
      <CoverTile device={device('cover', { state: at('closed') })} disabled={false} />,
    )
    expect(closedCover).toContain('var(--surface)')
    expect(closedCover).not.toContain('var(--state')
  })

  it('inverts the tile content to --accentText once it floods', () => {
    // A flood with the text left at --text would be unreadable in dark mode:
    // white on amber. Kills a tile that colours the square but not what is on
    // it, and the contrast with the off tile kills one that always inverts.
    const ToggleTile = slotOf('ToggleTile')

    const { container, unmount } = render(
      <ToggleTile device={device('light', { state: at('on') })} disabled={false} />,
    )
    expect(screen.getByText('Thing').getAttribute('style')).toContain('var(--accentText)')
    expect(container.querySelector('[data-testid="tile-icon"]')?.getAttribute('style')).toContain(
      'var(--accentText)',
    )
    unmount()

    render(<ToggleTile device={device('light')} disabled={false} />)
    const off = screen.getByText('Thing').getAttribute('style') ?? ''
    expect(off).toContain('var(--text)')
    expect(off).not.toContain('var(--accentText)')
  })

  it('does not flood a stale tile with the colour of a state it cannot see', () => {
    // A stale light reports Unknown, so flooding it amber would assert a state
    // the portal does not actually know.
    const ToggleTile = slotOf('ToggleTile')
    const style = cardStyle(
      <ToggleTile
        device={device('light', { state: { state: 'on', attributes: {}, stale: true } })}
        disabled={false}
      />,
    )

    expect(style).toContain('var(--surface)')
    expect(style).not.toContain('var(--stateLightActive)')
  })

  it('offers the cover the one action its state calls for', () => {
    // The tile is the control, so the single action has to follow the state.
    // Kills a fixed label — "Open" on an already-open door — and a tile that
    // drops Stop, which is the only reason a moving cover is tappable at all.
    const CoverTile = slotOf('CoverTile')

    function only(ui: ReactElement): string {
      const { container, unmount } = render(ui)
      const buttons = [...container.querySelectorAll('button')]
      const label = buttons.length === 1 ? (buttons[0]?.getAttribute('aria-label') ?? '') : ''
      expect(buttons, 'a cover tile is still one control').toHaveLength(1)
      unmount()
      return label
    }

    expect(only(<CoverTile device={device('cover', { state: at('closed') })} disabled={false} />)) //
      .toBe('Open Thing')
    expect(only(<CoverTile device={device('cover', { state: at('open') })} disabled={false} />)) //
      .toBe('Close Thing')
    expect(only(<CoverTile device={device('cover', { state: at('opening') })} disabled={false} />)) //
      .toBe('Stop Thing')
  })

  it('floods a moving cover with the transitioning colour', () => {
    // Opening is neither open nor closed, and the tile has to say so.
    const CoverTile = slotOf('CoverTile')
    expect(
      cardStyle(<CoverTile device={device('cover', { state: at('closing') })} disabled={false} />),
    ).toContain('var(--stateTransitioning)')
  })

  it('asks before unlocking rather than opening a door on one tap', async () => {
    // The whole-tile control is easy to hit by accident, so this theme must
    // route the press through the hook's confirmation. Kills a tile wired
    // straight to `unlock`, which would look identical until a guest brushed
    // the screen.
    const LockTile = slotOf('LockTile')
    render(
      <LockTile
        device={{
          entityId: 'lock.front',
          label: 'Front Door',
          domain: 'lock',
          allowedActions: ['lock', 'unlock'],
          sortOrder: 0,
          state: at('locked'),
        }}
        disabled={false}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Unlock Front Door' }))

    expect(api.performAction).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm Unlock' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.getByText('Confirm unlock?')).toBeTruthy()
    // The gesture that started the confirmation must not also finish it.
    expect(screen.queryByRole('button', { name: 'Unlock Front Door' })).toBeNull()
  })

  it('lets the guest back out of the confirmation', async () => {
    const LockTile = slotOf('LockTile')
    render(<LockTile device={device('lock')} disabled={false} />)

    await userEvent.click(screen.getByRole('button', { name: 'Unlock Thing' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(api.performAction).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Unlock Thing' })).toBeTruthy()
    expect(screen.queryByText('Confirm unlock?')).toBeNull()
  })

  it('lays the tiles out two to a row at phone width', () => {
    // Two columns of squares IS the theme. Kills a single-column shell, which
    // is what every other theme here uses and what a copied Shell would give.
    const Shell = slotOf('Shell')
    const { container } = render(
      <Shell title="Guest Portal" onLogout={() => undefined} loggingOut={false}>
        <div data-testid="child">tile</div>
      </Shell>,
    )

    const grid = container.querySelector('.grid')
    expect(grid).not.toBeNull()
    expect(grid?.className).toContain('grid-cols-2')
    expect(grid?.className).not.toContain('grid-cols-1')
    expect(screen.getByTestId('child')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
  })

  it('renders a sign-in form rather than an empty slot', () => {
    const Login = slotOf('Login')
    render(<Login onSuccess={() => undefined} />)

    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy()
  })

  it('keeps the disabled-portal copy verbatim', () => {
    // The reassuring wording and both testids are shared across every theme —
    // a guest arriving at a paused portal must not be told something different
    // because the owner picked a different look.
    const Disabled = slotOf('Disabled')
    render(<Disabled onRetry={() => undefined} />)

    expect(screen.getByTestId('portal-disabled-screen')).toBeTruthy()
    expect(screen.getByText('The guest portal is currently unavailable')).toBeTruthy()
    expect(
      screen.getByText(
        'Your host has turned it off. It will come back on its own once they turn it back on — no need to sign in again.',
      ),
    ).toBeTruthy()
    expect(screen.getByTestId('portal-disabled-retry').textContent).toBe('Check again')
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    // Same guard classic and the default set carry: a component that hardcodes
    // a colour cannot be restyled by tokens, and this theme's palette must live
    // only in tokens.ts. Only .tsx files are scanned, which excludes tokens.ts
    // — it legitimately holds the hex palette and an rgba() shadow.
    const dir = 'src/web/themes/tiles'
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
      // Named colours were the one hole every scan but Task 7's left open.
      // `'white'` is as untokenised as `#fff`, and is what EntityPicker
      // actually shipped.
      expect(src, `${f} uses a named colour`).not.toMatch(/['"](?:white|black)['"]/)
    }
  })
})
