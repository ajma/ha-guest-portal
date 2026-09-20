import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../src/web/api.ts'
import { App } from '../../src/web/App.tsx'
import { Unreachable } from '../../src/web/themes/default/Unreachable.tsx'

vi.mock('../../src/web/api.ts')

describe('unreachable portal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.setUnauthorizedCallback).mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the unreachable screen when the session request rejects', async () => {
    // A rejection is a *network* failure: no connection, DNS, refused. Before
    // this existed the rejection escaped `void checkSession()` and the app sat
    // on Loading... forever.
    vi.mocked(api.getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    render(<App />)

    expect(await screen.findByTestId('portal-unreachable-screen')).toBeTruthy()
    expect(screen.getByText(/can't reach the guest portal/i)).toBeTruthy()
    expect(screen.getByText(/home wi-?fi/i)).toBeTruthy()
  })

  it('shows the login form when the portal answers with no session', async () => {
    // The discriminating pair: answered-but-unauthenticated must NOT look like
    // unreachable. A mutant treating both the same fails exactly here.
    vi.mocked(api.getSession).mockResolvedValue(null)

    render(<App />)

    expect(await screen.findByLabelText(/password/i)).toBeTruthy()
    expect(screen.queryByTestId('portal-unreachable-screen')).toBeNull()
    expect(screen.queryByText(/can't reach the guest portal/i)).toBeNull()
  })

  it('never leaves the app on the loading state after a rejection', async () => {
    vi.mocked(api.getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })
  })

  it('retries and recovers', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getSession).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    render(<App />)
    await screen.findByTestId('portal-unreachable-screen')

    vi.mocked(api.getSession).mockResolvedValue(null)
    await user.click(screen.getByRole('button', { name: /retry/i }))

    expect(await screen.findByLabelText(/password/i)).toBeTruthy()
  })

  it('goes back to loading while the retry is in flight', async () => {
    // Retry must clear the failed state before it re-asks, or a guest who is
    // still off-network taps Retry and gets no feedback at all: the same screen
    // stays put and nothing says the app heard them. Pins the `setRole('loading')`
    // that a mutant dropping it would otherwise leave unobserved.
    const user = userEvent.setup()
    vi.mocked(api.getSession).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    render(<App />)
    await screen.findByTestId('portal-unreachable-screen')

    let settle: (value: { role: 'guest'; portalEnabled: boolean } | null) => void = () => {}
    vi.mocked(api.getSession).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      }),
    )

    await user.click(screen.getByRole('button', { name: /retry/i }))

    // Still in flight: the stale failure is gone and the app says it is working.
    expect(screen.queryByTestId('portal-unreachable-screen')).toBeNull()
    expect(screen.getByText(/loading/i)).toBeTruthy()

    settle(null)
    expect(await screen.findByLabelText(/password/i)).toBeTruthy()
  })

  it('leaves a signed-in guest where they are when the reconnect check rejects', async () => {
    // The mount check is not the only caller of getSession: the stream-drop
    // recheck and the portal-enabled poll can reject the same way. Those must
    // NOT jump to the unreachable screen — the tiles already disable themselves
    // when the stream drops and the stream reconnects unattended, so a blip
    // would otherwise demand a tap. They must still be caught: an uncaught one
    // here fails this test as an unhandled rejection.
    const store = await import('../../src/web/store.js')
    let connected = true
    const snapshot = (): ReturnType<typeof store.useDeviceStore> => ({
      devices: [],
      stale: false,
      connected,
      portalEnabled: false,
    })
    vi.spyOn(store, 'useDeviceStore').mockImplementation(snapshot)
    vi.spyOn(store, 'getSnapshot').mockImplementation(snapshot)

    vi.mocked(api.getSession).mockResolvedValue({ role: 'guest', portalEnabled: false })

    const { rerender } = render(<App />)
    await screen.findByTestId('portal-disabled-screen')

    // The stream drops and the recheck it triggers cannot reach the portal.
    connected = false
    vi.mocked(api.getSession).mockRejectedValue(new TypeError('Failed to fetch'))
    rerender(<App />)

    await waitFor(() => {
      expect(vi.mocked(api.getSession).mock.calls.length).toBeGreaterThan(1)
    })
    expect(screen.getByTestId('portal-disabled-screen')).toBeTruthy()
    expect(screen.queryByTestId('portal-unreachable-screen')).toBeNull()
    expect(screen.queryByLabelText(/password/i)).toBeNull()
  })

  it('keeps polling behind the disabled screen when a poll rejects', async () => {
    // The 15-second poll is the third caller of getSession. A rejected tick
    // must leave the disabled screen alone and let the next tick try again —
    // and must not put a rejection in the console every 15 seconds forever.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = await import('../../src/web/store.js')
    const snapshot = (): ReturnType<typeof store.useDeviceStore> => ({
      devices: [],
      stale: false,
      connected: true,
      portalEnabled: false,
    })
    vi.spyOn(store, 'useDeviceStore').mockImplementation(snapshot)
    vi.spyOn(store, 'getSnapshot').mockImplementation(snapshot)

    vi.mocked(api.getSession).mockResolvedValue({ role: 'guest', portalEnabled: false })

    try {
      render(<App />)
      await screen.findByTestId('portal-disabled-screen')

      vi.mocked(api.getSession).mockRejectedValue(new TypeError('Failed to fetch'))
      const before = vi.mocked(api.getSession).mock.calls.length
      await vi.advanceTimersByTimeAsync(31_000)

      // Two further ticks happened, so a rejected poll did not stop the timer.
      expect(vi.mocked(api.getSession).mock.calls.length).toBe(before + 2)
      expect(screen.getByTestId('portal-disabled-screen')).toBeTruthy()
      expect(screen.queryByTestId('portal-unreachable-screen')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not leak an unhandled rejection', async () => {
    // The rejection must be caught, not merely survived. vitest fails the run
    // on an unhandled rejection, so this asserts the absence by completing.
    vi.mocked(api.getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    render(<App />)
    await screen.findByTestId('portal-unreachable-screen')
  })
})

describe('the unreachable screen itself', () => {
  afterEach(() => {
    cleanup()
  })

  it('names what is known — that the portal did not answer', () => {
    render(<Unreachable onRetry={() => {}} />)

    const text = screen.getByTestId('portal-unreachable-screen').textContent ?? ''
    expect(text).toMatch(/can't reach the guest portal/i)
    // We detect "the portal did not answer", never "you are away from home":
    // the portal is reachable over a VPN from anywhere, and unreachable from
    // the sofa when the add-on is stopped. The copy may name the likely cause,
    // but must not assert it as fact.
    expect(text.toLowerCase()).not.toMatch(/you are away|you're away|not at home/)
  })

  it('calls onRetry when the retry button is pressed', async () => {
    const onRetry = vi.fn()
    render(<Unreachable onRetry={onRetry} />)

    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(onRetry).toHaveBeenCalledOnce()
  })
})
