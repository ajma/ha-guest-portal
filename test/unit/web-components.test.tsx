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
})
