import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../../src/web/api.js'
import * as store from '../../src/web/store.js'
import { App } from '../../src/web/App.js'

vi.mock('../../src/web/api.js')

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(store, 'connectDeviceStore').mockReturnValue(() => {})
  })

  afterEach(() => {
    cleanup()
    // App's live-theme effect (App.tsx) writes `data-theme` on every render,
    // including in tests that never seed or assert it. Left alone, a test
    // earlier in the file that lands on a non-classic theme (e.g. "selects
    // the last-selected portal…", which renders p2/tiles) leaks that
    // attribute onto every test that runs after it in this file -- harmless
    // today only because everything downstream happens to want 'classic' too.
    delete document.documentElement.dataset.theme
  })

  it('shows the create-portal screen full-page when an admin has zero portals', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: { portals: [], lastSelectedPortalId: null },
    })

    render(<App />)

    expect(await screen.findByText(/create a portal/i)).toBeTruthy()
  })

  it('leaves an admin with zero portals a way out and the integration token', async () => {
    // A self-hosted admin lands here on first login, and this is where they
    // find the token that pairs the Home Assistant integration. The header
    // itself carries no logout button for an admin (see the next test) --
    // the gear is the only route, into the settings panel below, and this
    // pins that the whole path still ends in a real logout call.
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: { portals: [], lastSelectedPortalId: null },
    })
    vi.mocked(api.getDeploymentSettings).mockResolvedValue({
      ok: true,
      data: { integrationToken: 'tok-abc', deploymentId: 'dep-1' },
    })
    vi.mocked(api.logout).mockResolvedValue(undefined)

    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText(/create a portal/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /^settings$/i }))
    await user.click(await screen.findByRole('button', { name: /show token/i }))
    expect((await screen.findByTestId('integration-token')).textContent).toBe('tok-abc')

    // Log out from inside the still-open panel, not after Close: once Close
    // is clicked there is no logout control left on this screen at all
    // (that is exactly what the next test pins), so clicking Close first
    // would leave nothing for `/log out/i` to find.
    await user.click(await screen.findByRole('button', { name: /log out/i }))
    await waitFor(() => expect(api.logout).toHaveBeenCalled())
  })

  // Kills: App.tsx passing onLogout to the zero-portal Shell unconditionally,
  // and the CSS-only fake fix (hiding the header button instead of not
  // rendering it) -- `hidden: true` and the markup check both see through
  // that, where a bare `queryByRole` would not.
  it('shows no header logout on the zero-portal admin screen, but keeps the gear', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: { portals: [], lastSelectedPortalId: null },
    })

    render(<App />)

    expect(await screen.findByText(/create a portal/i)).toBeTruthy()

    // Settings still present: proves the header logout button was
    // specifically removed, not that the whole header failed to render.
    expect(screen.getByRole('button', { name: /^settings$/i })).toBeTruthy()

    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /log out/i, hidden: true })).toBeNull()
    expect(document.body.textContent).not.toContain('Log out')
  })

  it('selects the last-selected portal for an admin with existing portals', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [
          { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true },
          { id: 'p2', title: 'Mary', theme: 'tiles', enabled: true },
        ],
        lastSelectedPortalId: 'p2',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })

    render(<App />)

    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p2'),
    )
  })

  it("renders a guest's own portal with no dropdown", async () => {
    vi.mocked(api.getSession).mockResolvedValue({
      role: 'guest',
      portalId: 'p1',
      portalTitle: "Timothy's Portal",
      portalTheme: 'classic',
      portalEnabled: true,
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: "Timothy's Portal" })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: /portal/i })).toBeNull()
  })

  it("shows the disabled screen when the guest's own portal is off", async () => {
    vi.mocked(api.getSession).mockResolvedValue({
      role: 'guest',
      portalId: 'p1',
      portalTitle: 'Timothy',
      portalTheme: 'classic',
      portalEnabled: false,
    })

    render(<App />)

    expect(await screen.findByTestId('portal-disabled-screen')).toBeTruthy()
  })

  it('updates the dropdown immediately when the owner renames the selected portal, with no reload', async () => {
    // Task 24's review found this exact behavior -- the header/dropdown
    // reflecting a rename live -- had a test removed (it pinned Portal.tsx's
    // own now-deleted title-state mechanism) with no replacement anywhere.
    // This is that replacement, exercised at the level the behavior now
    // actually lives: App.tsx's handlePortalUpdated threading a fresh
    // `portals` array down through PortalDropdown, not inside Portal.tsx.
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [
          { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true },
          { id: 'p2', title: 'Mary', theme: 'tiles', enabled: true },
        ],
        lastSelectedPortalId: 'p1',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
    vi.mocked(api.getPortal).mockResolvedValue({
      ok: true,
      data: { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'orig-pass' },
    })
    vi.mocked(api.updatePortal).mockResolvedValue({
      ok: true,
      data: { id: 'p1', title: 'Tim', theme: 'classic', enabled: true, password: 'orig-pass' },
    })

    const user = userEvent.setup()
    render(<App />)

    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
    )

    await user.click(screen.getByRole('button', { name: /portal settings/i }))
    const titleField = await screen.findByLabelText(/portal name/i)
    await user.clear(titleField)
    await user.type(titleField, 'Tim')
    await user.tab()

    await waitFor(() => expect(screen.getByRole('option', { name: 'Tim' })).toBeTruthy())
    // The stale option must be gone, not just the new one present -- a naive
    // append-without-replace bug in handlePortalUpdated's .map() would leave
    // both.
    expect(screen.queryByRole('option', { name: 'Timothy' })).toBeNull()
  })

  describe('live theme updates', () => {
    // Every existing theme test navigates a fresh page -- the theme id is
    // read once, synchronously, off `data-theme` at mount. Seeding the
    // attribute here stands in for the server's one-time write (Task brief:
    // theme-live-update), so these tests exercise the case that write cannot
    // cover: a value that has to move *after* the page already opened with a
    // different one.
    beforeEach(() => {
      document.documentElement.dataset.theme = 'classic'
    })

    afterEach(() => {
      delete document.documentElement.dataset.theme
    })

    it('re-themes the page when the owner switches to a different-themed portal', async () => {
      vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
      vi.mocked(api.getPortals).mockResolvedValue({
        ok: true,
        data: {
          portals: [
            { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true },
            { id: 'p2', title: 'Mary', theme: 'cards', enabled: true },
          ],
          lastSelectedPortalId: 'p1',
        },
      })
      vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
      vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
      // Without this the selection PUT that handleSelectPortal fires rejects
      // (the auto-mock has no configured resolution), which is an unrelated
      // unhandled rejection this test has no interest in.
      vi.mocked(api.putLastSelectedPortal).mockResolvedValue({ ok: true, data: undefined })

      const user = userEvent.setup()
      render(<App />)

      await waitFor(() =>
        expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
      )
      expect(screen.queryByTestId('card-grid')).toBeNull()

      await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), 'Mary')

      await waitFor(() =>
        expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p2'),
      )
      // Both assertions matter, and they fail for different reasons: a fix
      // that writes the attribute but still renders off `componentsFor`'s old
      // call site swaps the CSS variables without swapping the Shell, and a
      // fix that swaps the Shell through state alone leaves the CSS keyed off
      // an attribute nothing ever wrote.
      expect(document.documentElement.dataset.theme).toBe('cards')
      expect(screen.queryByTestId('card-grid')).toBeTruthy()
    })

    it('re-themes the page when the owner saves a new theme in settings', async () => {
      vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
      vi.mocked(api.getPortals).mockResolvedValue({
        ok: true,
        data: {
          portals: [{ id: 'p1', title: 'Timothy', theme: 'classic', enabled: true }],
          lastSelectedPortalId: 'p1',
        },
      })
      vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
      vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
      vi.mocked(api.getPortal).mockResolvedValue({
        ok: true,
        data: { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'orig-pass' },
      })
      vi.mocked(api.updatePortal).mockResolvedValue({
        ok: true,
        data: { id: 'p1', title: 'Timothy', theme: 'cards', enabled: true, password: 'orig-pass' },
      })

      const user = userEvent.setup()
      render(<App />)

      await waitFor(() =>
        expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
      )
      expect(screen.queryByTestId('card-grid')).toBeNull()

      await user.click(screen.getByRole('button', { name: /portal settings/i }))
      await user.click(await screen.findByRole('radio', { name: 'Cards' }))

      await waitFor(() => expect(api.updatePortal).toHaveBeenCalledWith('p1', { theme: 'cards' }))

      // Same pair, same reasoning as the dropdown test above -- this path goes
      // through handlePortalUpdated instead of handleSelectPortal, and both
      // halves of the fix have to hold regardless of which one changed the
      // selected portal's theme.
      expect(document.documentElement.dataset.theme).toBe('cards')
      expect(screen.queryByTestId('card-grid')).toBeTruthy()
    })

    it('re-themes the page when a guest logs in, with no reload', async () => {
      // The seeded 'classic' attribute stands in for the neutral default an
      // anonymous visitor's document is served with (themeAndTitleFor with no
      // session, src/server/app.ts:57) -- the server cannot know a portal's
      // theme before someone authenticates as its guest. The session below
      // deliberately answers with a *different* theme ('cards'): if the two
      // agreed, a mutation that kept reading the DOM instead of
      // `state.session.portalTheme` would pass this test by accident. There
      // is no `location.reload` anywhere in `src/web/` -- login is always
      // in-page, so this is the shape the reported bug takes on first login,
      // every single time.
      vi.mocked(api.getSession).mockResolvedValue(null)
      vi.mocked(api.login).mockResolvedValue({
        ok: true,
        data: {
          role: 'guest',
          portalId: 'p1',
          portalTitle: 'Timothy',
          portalTheme: 'cards',
          portalEnabled: true,
        },
      })

      const user = userEvent.setup()
      render(<App />)

      const passwordField = await screen.findByLabelText(/password/i)
      expect(screen.queryByTestId('card-grid')).toBeNull()

      await user.type(passwordField, 'guest-pass')
      await user.click(screen.getByRole('button', { name: /log in/i }))

      await waitFor(() => expect(screen.getByTestId('guest-screen')).toBeTruthy())

      // Same pair as the admin cases above, same reasoning: the attribute
      // catches a fix that forgets the CSS half, `card-grid` catches one that
      // forgets the component swap.
      expect(document.documentElement.dataset.theme).toBe('cards')
      expect(screen.queryByTestId('card-grid')).toBeTruthy()
    })
  })

  describe('live tab title updates', () => {
    // `document.title` is process-global mutable state, exactly like
    // `data-theme` above. Seeded to something deliberately wrong here so a
    // test cannot pass by the title simply never having been touched.
    beforeEach(() => {
      document.title = 'stale-title-should-be-overwritten'
    })

    afterEach(() => {
      document.title = ''
    })

    it('updates the tab when the owner renames the selected portal in settings', async () => {
      vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
      vi.mocked(api.getPortals).mockResolvedValue({
        ok: true,
        data: {
          portals: [{ id: 'p1', title: 'Timothy', theme: 'classic', enabled: true }],
          lastSelectedPortalId: 'p1',
        },
      })
      vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
      vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
      vi.mocked(api.getPortal).mockResolvedValue({
        ok: true,
        data: { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'orig-pass' },
      })
      vi.mocked(api.updatePortal).mockResolvedValue({
        ok: true,
        data: { id: 'p1', title: 'Cabin Retreat', theme: 'classic', enabled: true, password: 'orig-pass' },
      })

      const user = userEvent.setup()
      render(<App />)

      await waitFor(() =>
        expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
      )

      await user.click(screen.getByRole('button', { name: /portal settings/i }))
      const titleField = await screen.findByLabelText(/portal name/i)
      await user.clear(titleField)
      await user.type(titleField, 'Cabin Retreat')
      await user.tab()

      await waitFor(() => expect(api.updatePortal).toHaveBeenCalledWith('p1', { title: 'Cabin Retreat' }))

      expect(document.title).toBe('Cabin Retreat')
    })

    it('updates the tab when the owner switches to a different portal in the dropdown', async () => {
      vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
      vi.mocked(api.getPortals).mockResolvedValue({
        ok: true,
        data: {
          portals: [
            { id: 'p1', title: 'Beach House', theme: 'classic', enabled: true },
            { id: 'p2', title: 'Cabin', theme: 'classic', enabled: true },
          ],
          lastSelectedPortalId: 'p1',
        },
      })
      vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
      vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
      vi.mocked(api.putLastSelectedPortal).mockResolvedValue({ ok: true, data: undefined })

      const user = userEvent.setup()
      render(<App />)

      await waitFor(() =>
        expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
      )

      await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), 'Cabin')

      await waitFor(() =>
        expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p2'),
      )
      expect(document.title).toBe('Cabin')
    })

    it('gives a guest their portal name in the tab after logging in, with no reload', async () => {
      // Mirrors the theme login test above: the pre-login document genuinely
      // has no title override (themeAndTitleFor with no session returns
      // `title: null`, src/server/app.ts:57), so the tab reads whatever
      // `index.html` shipped until login runs, in-page, with no reload.
      vi.mocked(api.getSession).mockResolvedValue(null)
      vi.mocked(api.login).mockResolvedValue({
        ok: true,
        data: {
          role: 'guest',
          portalId: 'p1',
          portalTitle: 'Beach House',
          portalTheme: 'classic',
          portalEnabled: true,
        },
      })

      const user = userEvent.setup()
      render(<App />)

      const passwordField = await screen.findByLabelText(/password/i)

      await user.type(passwordField, 'guest-pass')
      await user.click(screen.getByRole('button', { name: /log in/i }))

      await waitFor(() => expect(screen.getByTestId('guest-screen')).toBeTruthy())

      expect(document.title).toBe('Beach House')
    })
  })

  it('adds the new portal to the dropdown and selects it after using + Add portal', async () => {
    // Portal.tsx's add-portal overlay used to call both onPortalCreated and
    // onCancelAddPortal back to back, each building its next state from the
    // same stale `state` closure -- the second call clobbered the first,
    // leaving the newly created portal absent from the dropdown and the
    // previously selected portal still showing. This pins the fix: creating
    // a portal must be reflected in both the option list and the selection.
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [{ id: 'p1', title: 'Timothy', theme: 'classic', enabled: true }],
        lastSelectedPortalId: 'p1',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
    vi.mocked(api.createPortal).mockResolvedValue({
      ok: true,
      data: { id: 'p2', title: 'Mary', theme: 'classic', enabled: true, password: 'mary-pass' },
    })

    const user = userEvent.setup()
    render(<App />)

    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
    )

    await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), '+ Add portal')
    await user.type(await screen.findByLabelText(/portal name/i), 'Mary')
    await user.type(screen.getByLabelText(/^password$/i), 'mary-pass')
    await user.click(screen.getByRole('button', { name: /^create portal$/i }))

    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p2'),
    )
    expect(screen.getByRole('option', { name: 'Timothy' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Mary' })).toBeTruthy()
    // The overlay must actually close -- a leftover create-portal form after
    // a successful creation is the other half of the original bug's symptom.
    expect(screen.queryByRole('heading', { name: /create a portal/i })).toBeNull()
  })

  it('keeps the add-portal overlay open when a slow portal save lands', async () => {
    // Every admin transition used to spread the render-time `state`, and
    // handlePortalUpdated is reached after an awaited PUT. An owner who ticks
    // the accordion's Enabled box on a slow link and then starts creating a
    // portal had the overlay torn down under them, typed input and all, the
    // moment the PUT resolved.
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [{ id: 'p1', title: 'Timothy', theme: 'classic', enabled: true }],
        lastSelectedPortalId: 'p1',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
    vi.mocked(api.getPortal).mockResolvedValue({
      ok: true,
      data: { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'orig-pass' },
    })
    let resolvePut!: (value: Awaited<ReturnType<typeof api.updatePortal>>) => void
    vi.mocked(api.updatePortal).mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve
      }),
    )

    const user = userEvent.setup()
    render(<App />)

    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
    )

    await user.click(screen.getByRole('button', { name: /portal settings/i }))
    await user.click(await screen.findByLabelText(/guests can log in/i))

    await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), '+ Add portal')
    const overlay = within(await screen.findByTestId('add-portal-overlay'))
    await user.type(overlay.getByLabelText(/portal name/i), 'Mary')

    await act(async () => {
      resolvePut({
        ok: true,
        data: { id: 'p1', title: 'Timothy', theme: 'classic', enabled: false, password: 'orig-pass' },
      })
    })

    const stillOpen = within(screen.getByTestId('add-portal-overlay'))
    expect(stillOpen.getByRole('heading', { name: /create a portal/i })).toBeTruthy()
    expect((stillOpen.getByLabelText(/portal name/i) as HTMLInputElement).value).toBe('Mary')
  })

  it('keeps the newly selected portal when a slow save for the previous one lands', async () => {
    // The same stale closure, seen from the dropdown: rename Timothy, switch
    // to Mary while the PUT is in flight, and the response used to restore
    // `selectedPortalId: 'timothy'` and snap the whole page back.
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [
          { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true },
          { id: 'p2', title: 'Mary', theme: 'classic', enabled: true },
        ],
        lastSelectedPortalId: 'p1',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
    vi.mocked(api.getPortal).mockResolvedValue({
      ok: true,
      data: { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'orig-pass' },
    })
    let resolvePut!: (value: Awaited<ReturnType<typeof api.updatePortal>>) => void
    vi.mocked(api.updatePortal).mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve
      }),
    )

    const user = userEvent.setup()
    render(<App />)

    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
    )

    await user.click(screen.getByRole('button', { name: /portal settings/i }))
    await user.click(await screen.findByLabelText(/guests can log in/i))

    await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), 'p2')

    await act(async () => {
      resolvePut({
        ok: true,
        data: { id: 'p1', title: 'Timothy', theme: 'classic', enabled: false, password: 'orig-pass' },
      })
    })

    expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p2')
  })

  it('persists the selection when the owner picks another portal', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [
          { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true },
          { id: 'p2', title: 'Mary', theme: 'classic', enabled: true },
        ],
        lastSelectedPortalId: 'p1',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })

    const user = userEvent.setup()
    render(<App />)

    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /portal/i }) as HTMLSelectElement).value).toBe('p1'),
    )

    await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), 'p2')

    // Without this the choice survives only until the next page load, which is
    // invisible on screen and so went uncaught.
    await waitFor(() => expect(api.putLastSelectedPortal).toHaveBeenCalledWith('p2'))
  })

  it('ignores a persisted selection for a portal that no longer exists', async () => {
    // Deleting the portal that was last selected leaves the stored id dangling.
    // Trusting it renders a portal page for an id the server knows nothing
    // about; the first portal in the list is the answer.
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [{ id: 'p1', title: 'Timothy', theme: 'classic', enabled: true }],
        lastSelectedPortalId: 'deleted-portal',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })

    render(<App />)

    // The stream is what the page is actually pointed at — a `<select>` with no
    // matching option falls back to its first one, so the dropdown alone cannot
    // tell a dangling id from a corrected one.
    await waitFor(() => expect(store.connectDeviceStore).toHaveBeenCalledWith('p1'))
    expect(store.connectDeviceStore).not.toHaveBeenCalledWith('deleted-portal')
  })

  it('leaves a logged-out owner on the login screen when a delete lands after a 401', async () => {
    // The delete is awaited, so `onPortalDeleted` runs from the closure of a
    // render where the app was still `admin`. A 401 inside that window has
    // already put the owner on the login screen, and reloading the portal list
    // from there walks them back into a portal the server will not serve.
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [{ id: 'p1', title: 'Timothy', theme: 'classic', enabled: true }],
        lastSelectedPortalId: 'p1',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })
    vi.mocked(api.getPortal).mockResolvedValue({
      ok: true,
      data: { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'orig-pass' },
    })

    let resolveDelete!: (result: Awaited<ReturnType<typeof api.deletePortal>>) => void
    const deletion = new Promise<Awaited<ReturnType<typeof api.deletePortal>>>((r) => {
      resolveDelete = r
    })
    vi.mocked(api.deletePortal).mockReturnValue(deletion)

    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: /portal settings/i }))
    await user.click(await screen.findByRole('button', { name: /^delete portal$/i }))
    await user.click(await screen.findByRole('button', { name: /confirm delete/i }))
    await waitFor(() => expect(api.deletePortal).toHaveBeenCalledWith('p1'))

    const onUnauthorized = vi.mocked(api.setUnauthorizedCallback).mock.calls[0]?.[0]
    expect(onUnauthorized).toBeTruthy()
    const portalFetches = vi.mocked(api.getPortals).mock.calls.length

    act(() => {
      onUnauthorized?.()
    })
    expect(await screen.findByRole('button', { name: /log in/i })).toBeTruthy()

    await act(async () => {
      resolveDelete({ ok: true, data: undefined })
      await deletion
    })

    expect(vi.mocked(api.getPortals).mock.calls.length).toBe(portalFetches)
    expect(screen.getByRole('button', { name: /log in/i })).toBeTruthy()
  })

  it('shows the unreachable screen when the portal list cannot be fetched', async () => {
    // `loadAdminPortals` is detached with `void` from outside checkSession's
    // catch, so a rejecting fetch or an unparseable body used to leave the
    // admin on a bare "Loading..." with no retry — the state a guest is
    // correctly spared.
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockRejectedValue(new Error('offline'))

    render(<App />)

    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy()
  })

  it('flips a connected guest to the disabled screen on a live SSE frame, with no extra session fetch', async () => {
    // App.tsx's own bug, found and fixed during this task: the disabled-screen
    // gate must read the live device-store value (what the server's 'portal'
    // SSE frame updates in place per Task 14's `onEnabledChange` wiring), not
    // a copy of `portalEnabled` carried on session state that only refreshes
    // on the next poll or reconnect. This proves the live path actually
    // works, not just the polling fallback the other tests above exercise.
    vi.mocked(api.getSession).mockResolvedValue({
      role: 'guest',
      portalId: 'p1',
      portalTitle: 'Timothy',
      portalTheme: 'classic',
      portalEnabled: true,
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Timothy' })).toBeTruthy()
    expect(screen.queryByTestId('portal-disabled-screen')).toBeNull()

    const callsBefore = vi.mocked(api.getSession).mock.calls.length

    store.applyFrame({ type: 'portal', enabled: false })

    expect(await screen.findByTestId('portal-disabled-screen')).toBeTruthy()
    // No fallback session fetch was needed for the switch: the live frame did
    // it on its own.
    expect(vi.mocked(api.getSession).mock.calls.length).toBe(callsBefore)
  })
})
