import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as api from '../../src/web/api.js'
import * as store from '../../src/web/store.js'

vi.mock('../../src/web/api.js')

describe('Login component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows distinct message for wrong password', async () => {
    const { Login } = await import('../../src/web/themes/default/Login.js')

    vi.mocked(api.login).mockResolvedValue({ ok: false, status: 401 })

    const onSuccess = vi.fn()
    render(<Login onSuccess={onSuccess} />)

    const input = screen.getByLabelText(/password/i)
    const button = screen.getByRole('button', { name: /log in/i })

    await userEvent.type(input, 'wrong')
    await userEvent.click(button)

    await waitFor(() => {
      expect(screen.queryByText(/invalid password/i)).not.toBeNull()
    })

    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('shows distinct message for rate limiting', async () => {
    const { Login } = await import('../../src/web/themes/default/Login.js')

    vi.mocked(api.login).mockResolvedValue({ ok: false, status: 429, retryAfter: 60 })

    const onSuccess = vi.fn()
    render(<Login onSuccess={onSuccess} />)

    const input = screen.getByLabelText(/password/i)
    const button = screen.getByRole('button', { name: /log in/i })

    await userEvent.type(input, 'password')
    await userEvent.click(button)

    await waitFor(() => {
      expect(screen.queryByText(/too many attempts/i)).not.toBeNull()
      expect(screen.queryByText(/60/)).not.toBeNull()
    })

    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('calls onSuccess with the whole session on successful login', async () => {
    const { Login } = await import('../../src/web/themes/default/Login.js')

    vi.mocked(api.login).mockResolvedValue({ ok: true, data: { role: 'admin' } })

    const onSuccess = vi.fn()
    render(<Login onSuccess={onSuccess} />)

    const input = screen.getByLabelText(/password/i)
    const button = screen.getByRole('button', { name: /log in/i })

    await userEvent.type(input, 'correct')
    await userEvent.click(button)

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith({ role: 'admin' })
    })
  })
})

describe('App component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.setUnauthorizedCallback).mockImplementation(() => {})
    vi.spyOn(store, 'connectDeviceStore').mockReturnValue(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    // App's live-theme effect writes `data-theme` on every render even when a
    // test never touches theming, so it leaks into whichever test runs next
    // in this file unless it is cleared here.
    delete document.documentElement.dataset.theme
  })

  it('renders Login when no session', async () => {
    const { App } = await import('../../src/web/App.js')

    vi.mocked(api.getSession).mockResolvedValue(null)

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByLabelText(/password/i)).not.toBeNull()
    })
  })

  it('renders guest screen with guest session', async () => {
    const { App } = await import('../../src/web/App.js')

    vi.mocked(api.getSession).mockResolvedValue({
      role: 'guest',
      portalId: 'p1',
      portalTitle: 'Guest Portal',
      portalTheme: 'classic',
      portalEnabled: true,
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByTestId('guest-screen')).not.toBeNull()
    })
  })

  it('renders the portal with an admin session', async () => {
    // There is one page for both roles: App routes on the session role alone,
    // never on the URL. The owner's extra controls are inside the portal and
    // belong to `portal-page.test.tsx`; what is pinned here is that an admin
    // reaches the same screen a guest does.
    const { App } = await import('../../src/web/App.js')

    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: { portals: [{ id: 'p1', title: 'Guest Portal', theme: 'classic', enabled: true }], lastSelectedPortalId: 'p1' },
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByTestId('guest-screen')).not.toBeNull()
    })
  })

  describe('session expiry handling', () => {
    it('returns to login when the api layer reports unauthorized', async () => {
      // api.ts owns the real 401-detection mechanics (see web-api.test.ts);
      // what belongs here is only that App wires the callback it registers
      // into a switch back to the login screen. Invoking the callback
      // directly, the same way a real 401 response would, keeps this test
      // from re-proving api.ts's own unit coverage.
      const { App } = await import('../../src/web/App.js')

      vi.mocked(api.getSession).mockResolvedValue({
        role: 'guest',
        portalId: 'p1',
        portalTitle: 'Guest Portal',
        portalTheme: 'classic',
        portalEnabled: true,
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      const registered = vi.mocked(api.setUnauthorizedCallback).mock.calls[0]?.[0]
      expect(registered).toBeTypeOf('function')
      registered?.()

      await waitFor(() => {
        expect(screen.queryByLabelText(/password/i)).not.toBeNull()
      })
    })

    it('returns to login when session disappears during stream connection', async () => {
      // Mock the store to control connected state
      let mockConnected = true
      const mockGetSnapshot = (): ReturnType<typeof store.useDeviceStore> => ({
        devices: [],
        stale: false,
        connected: mockConnected,
        portalEnabled: true,
      })

      vi.spyOn(store, 'useDeviceStore').mockImplementation(mockGetSnapshot)
      vi.spyOn(store, 'getSnapshot').mockImplementation(mockGetSnapshot)

      const { App } = await import('../../src/web/App.js')

      vi.mocked(api.getSession).mockResolvedValue({
        role: 'guest',
        portalId: 'p1',
        portalTitle: 'Guest Portal',
        portalTheme: 'classic',
        portalEnabled: true,
      })

      const { rerender } = render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Simulate connection drop, and the recheck that follows finding the
      // session gone.
      mockConnected = false
      vi.mocked(api.getSession).mockResolvedValue(null)

      rerender(<App />)

      await waitFor(() => {
        expect(screen.queryByLabelText(/password/i)).not.toBeNull()
      })
    })

    it('does not log out on transient stream error with valid session', async () => {
      let mockConnected = true
      const mockGetSnapshot = (): ReturnType<typeof store.useDeviceStore> => ({
        devices: [],
        stale: false,
        connected: mockConnected,
        portalEnabled: true,
      })

      vi.spyOn(store, 'useDeviceStore').mockImplementation(mockGetSnapshot)
      vi.spyOn(store, 'getSnapshot').mockImplementation(mockGetSnapshot)

      const { App } = await import('../../src/web/App.js')

      vi.mocked(api.getSession).mockResolvedValue({
        role: 'guest',
        portalId: 'p1',
        portalTitle: 'Guest Portal',
        portalTheme: 'classic',
        portalEnabled: true,
      })

      const { rerender } = render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Simulate a transient connection drop; the session the recheck finds
      // is still valid.
      mockConnected = false

      rerender(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      expect(screen.queryByLabelText(/password/i)).toBeNull()
    })
  })

  describe('portal disabled polling', () => {
    // The admin+portalEnabled combination this describe block used to also
    // cover ("admin with portalEnabled=false sees the portal, not the
    // disabled screen", "timer does not start for admin with
    // portalEnabled=false") is unrepresentable now: the admin branch of
    // `SessionResponse` carries no `portalEnabled` field at all, and the
    // disabled screen / poll timer are both gated on `state.kind === 'guest'`
    // in App.tsx — a distinct branch of the state machine an admin session
    // can never enter. TypeScript's exhaustiveness over the discriminated
    // union enforces this structurally, so the runtime guard those tests
    // pinned no longer exists as a case that could regress independently.
    // Removed rather than faked, matching Task 24's precedent for tests that
    // pin a since-removed mechanism.

    it('timer does not start for guest with portalEnabled=true', async () => {
      const { App } = await import('../../src/web/App.js')

      const setIntervalSpy = vi.spyOn(global, 'setInterval')

      vi.mocked(api.getSession).mockResolvedValue({
        role: 'guest',
        portalId: 'p1',
        portalTitle: 'Guest Portal',
        portalTheme: 'classic',
        portalEnabled: true,
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      const pollIntervals = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 15_000)
      expect(pollIntervals).toHaveLength(0)

      setIntervalSpy.mockRestore()
    })

    it('timer stops when portalEnabled flips from false to true', async () => {
      // This test proves the effect cleanup clears the interval when portalEnabled becomes true.
      // If the cleanup were missing, getSession would continue to be called every 15s
      // and this test would fail.
      const { App } = await import('../../src/web/App.js')

      vi.useFakeTimers({ shouldAdvanceTime: true })

      const getSessionSpy = vi.mocked(api.getSession)
      getSessionSpy.mockResolvedValue({
        role: 'guest',
        portalId: 'p1',
        portalTitle: 'Guest Portal',
        portalTheme: 'classic',
        portalEnabled: false,
      })

      render(<App />)

      await vi.runOnlyPendingTimersAsync()

      await waitFor(() => {
        expect(screen.queryByTestId('portal-disabled-screen')).not.toBeNull()
      })

      // The next poll finds the portal back on.
      getSessionSpy.mockClear()
      getSessionSpy.mockResolvedValue({
        role: 'guest',
        portalId: 'p1',
        portalTitle: 'Guest Portal',
        portalTheme: 'classic',
        portalEnabled: true,
      })

      await vi.advanceTimersByTimeAsync(15_000)

      expect(getSessionSpy).toHaveBeenCalledTimes(1)
      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      getSessionSpy.mockClear()

      // Advance time by another 20 seconds - should NOT trigger another poll
      await vi.advanceTimersByTimeAsync(20_000)

      expect(getSessionSpy).not.toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('guest screen recovers unaided when portal is re-enabled', async () => {
      // This test proves the 15s polling interval actually restores the guest surface
      // when the owner re-enables the portal. Without the interval callback working,
      // this test would fail.
      const { App } = await import('../../src/web/App.js')

      vi.useFakeTimers({ shouldAdvanceTime: true })

      vi.mocked(api.getSession).mockResolvedValue({
        role: 'guest',
        portalId: 'p1',
        portalTitle: 'Guest Portal',
        portalTheme: 'classic',
        portalEnabled: false,
      })

      render(<App />)

      await vi.runOnlyPendingTimersAsync()

      await waitFor(() => {
        expect(screen.queryByTestId('portal-disabled-screen')).not.toBeNull()
      })

      // The owner flips the portal back on; the next poll finds it.
      vi.mocked(api.getSession).mockResolvedValue({
        role: 'guest',
        portalId: 'p1',
        portalTitle: 'Guest Portal',
        portalTheme: 'classic',
        portalEnabled: true,
      })

      // Advance time by 15 seconds to trigger the poll that finds it back on.
      await vi.advanceTimersByTimeAsync(15_000)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })
      expect(screen.queryByTestId('portal-disabled-screen')).toBeNull()

      vi.useRealTimers()
    })
  })
})
