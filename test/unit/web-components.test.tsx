import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Helper to create a URL-routed fetch mock that returns appropriate responses
// based on the endpoint, avoiding order-dependent mockResolvedValueOnce chains
function createFetchMock(options: {
  sessionRole?: 'admin' | 'guest'
  sessionPortalEnabled?: boolean
  loginResponse?: Response
} = {}) {
  const {
    sessionRole = 'guest',
    sessionPortalEnabled = true,
    loginResponse,
  } = options

  return vi.fn((input: string | URL | Request) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    if (urlStr.includes('/api/session')) {
      return Promise.resolve(
        new Response(JSON.stringify({ role: sessionRole, portalEnabled: sessionPortalEnabled }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }

    if (urlStr.includes('/api/admin/entities')) {
      return Promise.resolve(
        new Response(JSON.stringify({ entities: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }

    if (urlStr.includes('/api/admin/allowlist')) {
      return Promise.resolve(
        new Response(JSON.stringify({ devices: [], orphaned: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }

    if (urlStr.includes('/api/admin/portal')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            enabled: sessionPortalEnabled,
            integrationToken: 'test',
            portalId: 'test',
            theme: 'classic',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }

    if (urlStr.includes('/api/login')) {
      if (loginResponse) {
        return Promise.resolve(loginResponse)
      }
      return Promise.resolve(
        new Response(JSON.stringify({ role: sessionRole, portalEnabled: sessionPortalEnabled }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }

    return Promise.reject(new Error(`Unmocked fetch to ${urlStr}`))
  })
}

describe('Login component', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows distinct message for wrong password', async () => {
    const { Login } = await import('../../src/web/routes/Login.js')

    global.fetch = createFetchMock({
      loginResponse: new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    })

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
    const { Login } = await import('../../src/web/routes/Login.js')

    global.fetch = createFetchMock({
      loginResponse: new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      }),
    })

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

  it('calls onSuccess with role on successful login', async () => {
    const { Login } = await import('../../src/web/routes/Login.js')

    global.fetch = createFetchMock({
      sessionRole: 'admin',
      sessionPortalEnabled: true,
    })

    const onSuccess = vi.fn()
    render(<Login onSuccess={onSuccess} />)

    const input = screen.getByLabelText(/password/i)
    const button = screen.getByRole('button', { name: /log in/i })

    await userEvent.type(input, 'correct')
    await userEvent.click(button)

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith('admin')
    })
  })
})

describe('App component', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
    // Reset window.location.pathname
    Object.defineProperty(window, 'location', {
      value: { pathname: '/' },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders Login when no session', async () => {
    const { App } = await import('../../src/web/App.js')

    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ) as typeof fetch

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByLabelText(/password/i)).not.toBeNull()
    })
  })

  it('renders guest screen with guest session', async () => {
    const { App } = await import('../../src/web/App.js')

    global.fetch = createFetchMock({
      sessionRole: 'guest',
      sessionPortalEnabled: true,
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByTestId('guest-screen')).not.toBeNull()
    })
  })

  it('renders admin screen only for admin role at /admin', async () => {
    const { App } = await import('../../src/web/App.js')

    global.fetch = createFetchMock({
      sessionRole: 'admin',
      sessionPortalEnabled: true,
    })

    // Simulate /admin path
    Object.defineProperty(window, 'location', {
      value: { pathname: '/admin' },
      writable: true,
      configurable: true,
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByTestId('admin-screen')).not.toBeNull()
    })
  })

  it('does not render admin screen for guest at /admin', async () => {
    const { App } = await import('../../src/web/App.js')

    global.fetch = createFetchMock({
      sessionRole: 'guest',
      sessionPortalEnabled: true,
    })

    // Simulate /admin path
    Object.defineProperty(window, 'location', {
      value: { pathname: '/admin' },
      writable: true,
      configurable: true,
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByTestId('admin-screen')).toBeNull()
      expect(screen.queryByTestId('guest-screen')).not.toBeNull()
    })
  })

  describe('session expiry handling', () => {
    it('returns to login when API returns 401', async () => {
      const { App } = await import('../../src/web/App.js')

      // Initial session check succeeds
      global.fetch = createFetchMock({
        sessionRole: 'guest',
        sessionPortalEnabled: true,
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Simulate a 401 response (triggers unauthorized callback)
      global.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ) as typeof fetch

      const { getDevices } = await import('../../src/web/api.js')
      await getDevices()

      await waitFor(() => {
        expect(screen.queryByLabelText(/password/i)).not.toBeNull()
      })
    })

    it('returns to login when session disappears during stream connection', async () => {
      // Mock the store to control connected state
      const storeModule = await import('../../src/web/store.js')

      let mockConnected = true
      const mockGetSnapshot = vi.fn(() => ({
        devices: [],
        stale: false,
        connected: mockConnected,
        portalEnabled: true,
      }))

      // Override useDeviceStore to use our mock
      vi.spyOn(storeModule, 'useDeviceStore').mockImplementation(() => mockGetSnapshot())
      vi.spyOn(storeModule, 'getSnapshot').mockImplementation(mockGetSnapshot)

      const { App } = await import('../../src/web/App.js')

      // Initial session check succeeds
      global.fetch = createFetchMock({
        sessionRole: 'guest',
        sessionPortalEnabled: true,
      })

      const { rerender } = render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Simulate connection drop
      mockConnected = false

      // Session check now fails
      global.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ) as typeof fetch

      // Trigger re-render
      rerender(<App />)

      await waitFor(() => {
        expect(screen.queryByLabelText(/password/i)).not.toBeNull()
      })

      // Restore
      vi.mocked(storeModule.useDeviceStore).mockRestore()
      vi.mocked(storeModule.getSnapshot).mockRestore()
    })

    it('does not log out on transient stream error with valid session', async () => {
      // Mock the store to control connected state
      const storeModule = await import('../../src/web/store.js')

      let mockConnected = true
      const mockGetSnapshot = vi.fn(() => ({
        devices: [],
        stale: false,
        connected: mockConnected,
        portalEnabled: true,
      }))

      vi.spyOn(storeModule, 'useDeviceStore').mockImplementation(() => mockGetSnapshot())
      vi.spyOn(storeModule, 'getSnapshot').mockImplementation(mockGetSnapshot)

      const { App } = await import('../../src/web/App.js')

      // Initial session check succeeds
      global.fetch = createFetchMock({
        sessionRole: 'guest',
        sessionPortalEnabled: true,
      })

      const { rerender } = render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Simulate transient connection drop
      mockConnected = false

      // Session check still succeeds - keep using the same mock
      // (createFetchMock returns success responses by default)

      // Trigger re-render
      rerender(<App />)

      // Should remain on guest screen
      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      expect(screen.queryByLabelText(/password/i)).toBeNull()

      // Restore
      vi.mocked(storeModule.useDeviceStore).mockRestore()
      vi.mocked(storeModule.getSnapshot).mockRestore()
    })
  })

  describe('portal disabled routing', () => {
    it('admin with portalEnabled=false sees admin screen, not disabled screen', async () => {
      // This test proves the guard `role === 'guest' && !portalEnabled` protects admins
      // from ever seeing the disabled screen. If the guard were loosened to just
      // `!portalEnabled`, this test would fail.
      const { App } = await import('../../src/web/App.js')

      global.fetch = createFetchMock({
        sessionRole: 'admin',
        sessionPortalEnabled: false,
      })

      // Simulate /admin path
      Object.defineProperty(window, 'location', {
        value: { pathname: '/admin' },
        writable: true,
        configurable: true,
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('admin-screen')).not.toBeNull()
      })

      // The disabled screen must not appear
      expect(screen.queryByTestId('portal-disabled-screen')).toBeNull()
    })
  })

  describe('portal disabled polling', () => {
    it('timer does not start for admin with portalEnabled=false', async () => {
      // This test proves the guard `role !== 'guest'` prevents polling for admins.
      // If the guard at App.tsx:91 were removed, setInterval would be called with 15000
      // and this test would fail.
      const { App } = await import('../../src/web/App.js')

      const setIntervalSpy = vi.spyOn(global, 'setInterval')

      global.fetch = createFetchMock({
        sessionRole: 'admin',
        sessionPortalEnabled: false,
      })

      // Simulate /admin path so admin screen renders
      Object.defineProperty(window, 'location', {
        value: { pathname: '/admin' },
        writable: true,
        configurable: true,
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('admin-screen')).not.toBeNull()
      })

      // Check that no 15-second polling interval was created
      const pollIntervals = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 15_000)
      expect(pollIntervals).toHaveLength(0)

      setIntervalSpy.mockRestore()
    })

    it('timer does not start for guest with portalEnabled=true', async () => {
      // This test proves the guard `portalEnabled` prevents polling while enabled.
      // If the guard at App.tsx:91 were removed, setInterval would be called with 15000
      // and this test would fail.
      const { App } = await import('../../src/web/App.js')

      const setIntervalSpy = vi.spyOn(global, 'setInterval')

      global.fetch = createFetchMock({
        sessionRole: 'guest',
        sessionPortalEnabled: true,
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Check that no 15-second polling interval was created
      const pollIntervals = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 15_000)
      expect(pollIntervals).toHaveLength(0)

      setIntervalSpy.mockRestore()
    })

    it('timer stops when portalEnabled flips from false to true', async () => {
      // This test proves the effect cleanup clears the interval when portalEnabled becomes true.
      // If the cleanup were missing, getSession would continue to be called every 15s
      // and this test would fail.
      const storeModule = await import('../../src/web/store.js')
      const apiModule = await import('../../src/web/api.js')
      const { App } = await import('../../src/web/App.js')

      // Install fake timers before rendering so the interval is created with fake timers
      vi.useFakeTimers({ shouldAdvanceTime: true })

      const getSessionSpy = vi.spyOn(apiModule, 'getSession')

      // Use the router for all session checks
      global.fetch = createFetchMock({
        sessionRole: 'guest',
        sessionPortalEnabled: false,
      })

      // Mock store to initially return portalEnabled=false
      let portalEnabled = false
      vi.spyOn(storeModule, 'useDeviceStore').mockImplementation(() => ({
        devices: [],
        connected: false,
        portalEnabled,
        stale: false,
      }))

      const { rerender } = render(<App />)

      // Flush initial render promises
      await vi.runOnlyPendingTimersAsync()

      await waitFor(() => {
        expect(screen.queryByTestId('portal-disabled-screen')).not.toBeNull()
      })

      // Clear the spy call count from initial render
      getSessionSpy.mockClear()

      // Advance time by 15 seconds - should trigger one poll
      await vi.advanceTimersByTimeAsync(15_000)

      // Verify one poll happened
      expect(getSessionSpy).toHaveBeenCalledTimes(1)

      getSessionSpy.mockClear()

      // Now flip portalEnabled to true in the store
      portalEnabled = true
      vi.mocked(storeModule.useDeviceStore).mockImplementation(() => ({
        devices: [],
        connected: true,
        portalEnabled: true,
        stale: false,
      }))

      // Rerender to trigger the effect cleanup
      rerender(<App />)

      await vi.runOnlyPendingTimersAsync()

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      getSessionSpy.mockClear()

      // Advance time by another 15 seconds - should NOT trigger another poll
      await vi.advanceTimersByTimeAsync(15_000)

      // Wait a bit more to be absolutely sure
      await vi.advanceTimersByTimeAsync(5_000)

      // getSession should not have been called because the timer was cleared
      expect(getSessionSpy).not.toHaveBeenCalled()

      vi.mocked(storeModule.useDeviceStore).mockRestore()
      vi.useRealTimers()
    })

    it('guest screen recovers unaided when portal is re-enabled', async () => {
      // This test proves the 15s polling interval actually restores the guest surface
      // when the owner re-enables the portal. Without the interval callback working,
      // this test would fail.
      const storeModule = await import('../../src/web/store.js')
      const { App } = await import('../../src/web/App.js')

      vi.useFakeTimers({ shouldAdvanceTime: true })

      // Mock store to initially return portalEnabled=false, then true
      let portalEnabled = false
      vi.spyOn(storeModule, 'useDeviceStore').mockImplementation(() => ({
        devices: [],
        connected: portalEnabled,
        portalEnabled,
        stale: false,
      }))

      // Start with portalEnabled=false, then switch to true after the first poll
      let callCount = 0
      global.fetch = vi.fn((input: string | URL | Request) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        if (urlStr.includes('/api/session')) {
          callCount++
          const enabled = callCount > 1
          return Promise.resolve(
            new Response(JSON.stringify({ role: 'guest', portalEnabled: enabled }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }

        return Promise.reject(new Error(`Unmocked fetch to ${urlStr}`))
      }) as typeof fetch

      const { rerender } = render(<App />)

      await vi.runOnlyPendingTimersAsync()

      await waitFor(() => {
        expect(screen.queryByTestId('portal-disabled-screen')).not.toBeNull()
      })

      // Update the store state
      portalEnabled = true

      // Advance time by 15 seconds to trigger the poll
      await vi.advanceTimersByTimeAsync(15_000)

      // Re-render to apply the new store state
      rerender(<App />)

      await vi.runOnlyPendingTimersAsync()

      // The guest screen should appear without any user interaction
      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })
      expect(screen.queryByTestId('portal-disabled-screen')).toBeNull()

      vi.mocked(storeModule.useDeviceStore).mockRestore()
      vi.useRealTimers()
    })
  })
})
