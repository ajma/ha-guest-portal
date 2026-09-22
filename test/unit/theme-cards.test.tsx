import { readFileSync, readdirSync } from 'node:fs'
import { cleanup, render as renderBare, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@shared/api.js'
import type { SupportedDomain } from '@shared/devices.js'
import * as api from '../../src/web/api.ts'
import { GLYPHS } from '../../src/web/themes/cards/glyphs.ts'
import { PortalIdProvider } from '../../src/web/portalContext.ts'
import cards from '../../src/web/themes/cards/index.ts'
import { TOKEN_NAMES } from '../../src/web/themes/tokens.ts'
import type { Theme } from '../../src/web/themes/types.ts'

// The hooks call performAction. Only the lock tests press anything, and the
// press they make is the one that must NOT reach the network — the unlock
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
 * Every path the resolver drew, joined. Not just the first: a Material Symbol
 * is one path today but the resolver parses whatever the file contains, and a
 * two-path glyph must not be compared on its first stroke alone.
 */
function iconPaths(domain: SupportedDomain, state: string): string {
  const { container, unmount } = render(cards.icon(domain, state))
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
  const component = cards.components?.[key]
  if (component === undefined) throw new Error(`cards declares no ${key}`)
  return component
}

/** The circular badge — the only control on a card, and the thing that carries colour. */
function badgeStyle(ui: ReactElement): string {
  const { container, unmount } = render(ui)
  const style = container.querySelector('[data-testid="tile-badge"]')?.getAttribute('style') ?? ''
  unmount()
  return style
}

describe('cards theme', () => {
  it('declares its identity and both modes', () => {
    expect(cards.id).toBe('cards')
    expect(cards.name).toBe('Cards')
    expect(cards.tokens.light.accent).toBeTruthy()
    expect(cards.tokens.dark.accent).toBeTruthy()
  })

  it('supplies every token in both modes', () => {
    // The token set is closed: a theme missing one cannot be rendered by the
    // default component set, which is the property that makes overrides
    // optional. The registry test asserts this across the registry; asserting
    // it here too means a missing token names THIS theme when it fails.
    for (const mode of ['light', 'dark'] as const) {
      for (const name of TOKEN_NAMES) {
        expect(cards.tokens[mode][name], `${mode}.${name}`).toBeTruthy()
      }
    }
  })

  it('declares two genuinely different palettes rather than one spread twice', () => {
    // Kills a tokens file that spreads one object into both modes. This theme
    // is light-first, so its light surfaces are the look — but a dark-mode
    // guest must still get a dark page rather than a white flash.
    expect(cards.tokens.dark.appBg).not.toBe(cards.tokens.light.appBg)
    expect(cards.tokens.dark.surface).not.toBe(cards.tokens.light.surface)
    expect(cards.tokens.dark.text).not.toBe(cards.tokens.light.text)
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
      expect(cards.components?.[slot], slot).toBeDefined()
    }
  })

  it('resolves an icon per supported domain', () => {
    for (const domain of ['light', 'switch', 'fan', 'input_boolean', 'cover', 'lock'] as const) {
      const { container } = render(cards.icon(domain, 'on'))
      expect(container.querySelector('svg'), domain).toBeTruthy()
      expect(container.querySelector('path')?.getAttribute('d'), domain).toBeTruthy()
      cleanup()
    }
  })

  it('resolves a different icon for each domain', () => {
    // Kills a resolver that ignores `domain` and returns one generic glyph —
    // and, because these glyphs are parsed out of imported SVG files, it also
    // kills an import list that names the same file twice.
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

  it('puts the control on the icon badge, leaving the card body inert', () => {
    // The defining move of this theme. A single button that happens to exist
    // would also pass a whole-card control, so this pins down all three parts
    // of the claim: the badge is a button, it is not full width, and the name
    // and state sit OUTSIDE it — the card body is not tappable.
    const ToggleTile = slotOf('ToggleTile')
    const { container } = render(<ToggleTile device={device('light')} disabled={false} />)

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)

    const button = buttons[0]
    expect(button).toBeDefined()
    expect(button?.className).not.toMatch(/\bw-full\b/)
    expect(button?.getAttribute('data-testid')).toBe('tile-badge')
    expect(button?.querySelector('svg'), 'the glyph is inside the control').not.toBeNull()
    expect(button?.contains(screen.getByText('Thing')), 'the name is outside the control').toBe(
      false,
    )
    expect(button?.contains(screen.getByText('Off')), 'the state is outside the control').toBe(
      false,
    )
  })

  it('stacks the name and state beneath a round badge rather than beside it', () => {
    // Kills a card copied from `classic`, whose tile is a row of icon + text.
    // This theme's card is a centred column, and the badge is a large circle.
    const ToggleTile = slotOf('ToggleTile')
    const { container } = render(<ToggleTile device={device('light')} disabled={false} />)

    const card = container.querySelector('[data-testid="tile-card"]')
    expect(card?.className).toContain('flex-col')
    expect(card?.className).toContain('items-center')

    const badge = container.querySelector('[data-testid="tile-badge"]')
    expect(badge?.className).toContain('rounded-full')
    expect(badge?.className).toContain('h-14')
  })

  it('fills the badge with the resolved state colour, not with one shared accent', () => {
    // The point of the state roles: flooding every active badge with --accent
    // would make a locked door and a lit lamp identical. This asserts they are
    // not, and names the token each one takes.
    const ToggleTile = slotOf('ToggleTile')
    const LockTile = slotOf('LockTile')
    const CoverTile = slotOf('CoverTile')

    const litLight = badgeStyle(
      <ToggleTile device={device('light', { state: at('on') })} disabled={false} />,
    )
    const lockedLock = badgeStyle(<LockTile device={device('lock')} disabled={false} />)
    const openCover = badgeStyle(
      <CoverTile device={device('cover', { state: at('open') })} disabled={false} />,
    )

    expect(litLight).toContain('var(--stateLightActive)')
    expect(lockedLock).toContain('var(--stateLockLocked)')
    expect(openCover).toContain('var(--stateCoverActive)')
    expect(new Set([litLight, lockedLock, openCover]).size).toBe(3)

    // Kills the stale instruction this replaced: fill the badge with --accent.
    expect(lockedLock).not.toContain('var(--accent)')
  })

  it('leaves an inactive badge on the plain surface', () => {
    // Kills a badge that always tints — an off light would then be as loud as
    // a lit one and the colour would carry no information at all.
    const ToggleTile = slotOf('ToggleTile')
    const CoverTile = slotOf('CoverTile')

    const offLight = badgeStyle(<ToggleTile device={device('light')} disabled={false} />)
    expect(offLight).toContain('var(--surfaceActive)')
    expect(offLight).not.toContain('var(--state')

    const closedCover = badgeStyle(
      <CoverTile device={device('cover', { state: at('closed') })} disabled={false} />,
    )
    expect(closedCover).toContain('var(--surfaceActive)')
    expect(closedCover).not.toContain('var(--state')
  })

  it('does not colour a stale badge with a state it cannot see', () => {
    // A stale light reports Unknown, so tinting it amber would assert a state
    // the portal does not actually know.
    const ToggleTile = slotOf('ToggleTile')
    const style = badgeStyle(
      <ToggleTile
        device={device('light', { state: { state: 'on', attributes: {}, stale: true } })}
        disabled={false}
      />,
    )

    expect(style).toContain('var(--surfaceActive)')
    expect(style).not.toContain('var(--stateLightActive)')
  })

  it('keeps the badge glyph legible instead of writing --accentText onto the fill', () => {
    // Recorded as a decision, not an accident. With this theme's Material
    // palette, --accentText (#ffffff in light mode) lands at 1.9:1 on the amber
    // of a lit light and 2.5:1 on the cyan of a running fan, so the plan's
    // "fill with the accent and invert the content" would ship unreadable
    // glyphs. The badge takes the state colour as a tint over --surface and the
    // glyph stays --text, which is legible in both modes for every state.
    const ToggleTile = slotOf('ToggleTile')
    const style = badgeStyle(
      <ToggleTile device={device('light', { state: at('on') })} disabled={false} />,
    )

    expect(style).toContain('var(--text)')
    expect(style).not.toContain('var(--accentText)')
  })

  it('offers the cover the one action its state calls for', () => {
    // The badge is the only control, so the single action has to follow the
    // state. Kills a fixed label — "Open" on an already-open door — and a card
    // that drops Stop, which is the only reason a moving cover is tappable.
    const CoverTile = slotOf('CoverTile')

    function only(ui: ReactElement): string {
      const { container, unmount } = render(ui)
      const buttons = [...container.querySelectorAll('button')]
      const label = buttons.length === 1 ? (buttons[0]?.getAttribute('aria-label') ?? '') : ''
      expect(buttons, 'a cover card is still one control').toHaveLength(1)
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

  it('tints a moving cover with the transitioning colour', () => {
    // Opening is neither open nor closed, and the card has to say so.
    const CoverTile = slotOf('CoverTile')
    expect(
      badgeStyle(<CoverTile device={device('cover', { state: at('closing') })} disabled={false} />),
    ).toContain('var(--stateTransitioning)')
  })

  it('asks before unlocking rather than opening a door on one tap', async () => {
    // Kills a card wired straight to `unlock`, which would look identical until
    // a guest pressed it once.
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

  it('lays the cards out on a flowing grid rather than a fixed column count', () => {
    // Kills a Shell copied from another theme: `classic` pins one column at
    // phone width and `tiles` pins exactly two. This one fills the row with
    // whatever fits, which is what lets a card stay wide enough to centre its
    // contents on a phone and still use a desktop window.
    const Shell = slotOf('Shell')
    const { container } = render(
      <Shell title="Guest Portal" onLogout={() => undefined} loggingOut={false}>
        <div data-testid="child">card</div>
      </Shell>,
    )

    const grid = container.querySelector('[data-testid="card-grid"]')
    expect(grid).not.toBeNull()
    expect(grid?.className).toContain('auto-fill')
    expect(grid?.className).not.toMatch(/\bgrid-cols-\d\b/)
    expect(screen.getByTestId('guest-screen')).toBeTruthy()
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

  it('draws the glyphs @material-symbols/svg-400 actually ships', () => {
    // src/web/themes/cards/glyphs.ts vendors the path data as JavaScript,
    // because the CSS generator loads every theme under plain Node and cannot
    // import a .svg. Vendored data rots, so this reads the package's own files
    // back and compares. It kills a typo in a copied path, a glyph copied twice
    // under two names, and a package upgrade that silently redraws an icon
    // while the checked-in copy keeps drawing the old one.
    const dir = 'node_modules/@material-symbols/svg-400/rounded'
    const names = Object.keys(GLYPHS)
    expect(names.length).toBeGreaterThan(0)

    for (const name of names) {
      const svg = readFileSync(`${dir}/${name}.svg`, 'utf-8')
      const paths = [...svg.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1])
      expect(paths, `${name}.svg is no longer a single path`).toHaveLength(1)
      expect(GLYPHS[name as keyof typeof GLYPHS], name).toBe(paths[0])
    }
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    // Same guard classic and tiles carry: a component that hardcodes a colour
    // cannot be restyled by tokens, and this theme's palette must live only in
    // tokens.ts. Only .tsx files are scanned, which excludes tokens.ts — it
    // legitimately holds the hex palette.
    const dir = 'src/web/themes/cards'
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
