import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

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

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      }),
    )

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

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ role: 'admin', portalEnabled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

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

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByLabelText(/password/i)).not.toBeNull()
    })
  })

  it('renders guest screen with guest session', async () => {
    const { App } = await import('../../src/web/App.js')

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ role: 'guest', portalEnabled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByTestId('guest-screen')).not.toBeNull()
    })
  })

  it('renders admin screen only for admin role at /admin', async () => {
    const { App } = await import('../../src/web/App.js')

    // Mock session check
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ role: 'admin', portalEnabled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    // Mock getCatalog
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ entities: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    // Mock getAllowlist
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ devices: [], orphaned: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    // Mock getAdminPortal (called by PortalToggle)
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: true, integrationToken: 'test', portalId: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

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

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ role: 'guest', portalEnabled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

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
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'guest', portalEnabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Simulate a 401 response (triggers unauthorized callback)
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

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
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'guest', portalEnabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const { rerender } = render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Simulate connection drop
      mockConnected = false

      // Session check now fails
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

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
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'guest', portalEnabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const { rerender } = render(<App />)

      await waitFor(() => {
        expect(screen.queryByTestId('guest-screen')).not.toBeNull()
      })

      // Simulate transient connection drop
      mockConnected = false

      // Session check still succeeds
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'guest', portalEnabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

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

      // Mock session check returning admin with portalEnabled=false
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'admin', portalEnabled: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      // Mock getCatalog
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ entities: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      // Mock getAllowlist
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ devices: [], orphaned: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      // Mock getAdminPortal (called by PortalToggle)
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: false, integrationToken: 'test', portalId: 'test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

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

      // Mock session check returning admin with portalEnabled=false
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'admin', portalEnabled: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      // Mock getCatalog
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ entities: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      // Mock getAllowlist
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ devices: [], orphaned: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      // Mock getAdminPortal (called by PortalToggle)
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: false, integrationToken: 'test', portalId: 'test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

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

      // Mock session check returning guest with portalEnabled=true
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'guest', portalEnabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

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

      // Initial session check: guest with portalEnabled=false
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'guest', portalEnabled: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      // Mock response for the first poll (after 15s)
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'guest', portalEnabled: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

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
  })
})
