import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
