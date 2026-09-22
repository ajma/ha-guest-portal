import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import type { Device } from '@shared/api.js'
import { useToggleDevice } from '../../src/web/hooks/useToggleDevice.ts'
import { useLockDevice } from '../../src/web/hooks/useLockDevice.ts'
import { useCoverDevice } from '../../src/web/hooks/useCoverDevice.ts'
import { PortalIdProvider } from '../../src/web/portalContext.ts'
import * as api from '../../src/web/api.ts'

// An admin's portal is never in their session, so every action has to carry it
// in the query string. The hooks read it from the portal page's context; the
// assertions below pin the third argument, because a two-argument call is
// exactly the shape that made every admin tile return 400.
const PORTAL_ID = 'timothy'

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <PortalIdProvider value={PORTAL_ID}>{children}</PortalIdProvider>
}

// Promise.withResolvers is ES2024; this project's lib is ES2022.
function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function toggleDevice(overrides: Partial<Device> = {}): Device {
  return {
    entityId: 'light.porch',
    label: 'Porch',
    domain: 'light',
    allowedActions: ['turn_on', 'turn_off'],
    sortOrder: 0,
    state: { state: 'off', attributes: {}, stale: false },
    ...overrides,
  }
}

describe('useToggleDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports off state', async () => {
    const dev = toggleDevice()
    const { result } = renderHook(() => useToggleDevice(dev, false), { wrapper })
    expect(result.current.isOn).toBe(false)
    expect(result.current.stateText).toBe('Off')
  })

  // Kills a context that answers `undefined` when there is no provider. The
  // portal id is a required parameter of performAction, which catches a dropped
  // argument but not a dropped provider: a tile rendered outside a portal — a
  // theme with its own root, a second route reusing the tiles — would send
  // every action without one and take a 400 on each, with the typecheck and
  // this suite both green. Nine tests in this file used to render exactly that.
  it('refuses to run outside a portal', () => {
    const dev = toggleDevice()
    expect(() => renderHook(() => useToggleDevice(dev, false))).toThrow(/PortalIdProvider/)
  })

  it('calls turn_on when off', async () => {
    const performActionSpy = vi
      .spyOn(api, 'performAction')
      .mockResolvedValue({ ok: true, data: undefined })
    const dev = toggleDevice()
    const { result, unmount } = renderHook(() => useToggleDevice(dev, false), { wrapper })
    await act(async () => {
      await result.current.activate()
    })
    await waitFor(() =>
      expect(performActionSpy).toHaveBeenCalledWith('light.porch', 'turn_on', PORTAL_ID),
    )
    unmount()
    performActionSpy.mockRestore()
  })

  it('falls back to toggle when only toggle is allowed', async () => {
    const performActionSpy = vi
      .spyOn(api, 'performAction')
      .mockResolvedValue({ ok: true, data: undefined })
    const d = toggleDevice({ allowedActions: ['toggle'] })
    const { result, unmount } = renderHook(() => useToggleDevice(d, false), { wrapper })
    await act(async () => {
      await result.current.activate()
    })
    await waitFor(() =>
      expect(performActionSpy).toHaveBeenCalledWith('light.porch', 'toggle', PORTAL_ID),
    )
    unmount()
    performActionSpy.mockRestore()
  })

  it('shows the optimistic state immediately', async () => {
    // Hold the action in flight so the optimistic window is observable. If the
    // hook waited for the server instead of flipping state up front, isOn would
    // still be false here.
    const deferred = defer<Awaited<ReturnType<typeof api.performAction>>>()
    vi.spyOn(api, 'performAction').mockReturnValue(deferred.promise)
    const dev = toggleDevice()
    const { result } = renderHook(() => useToggleDevice(dev, false), { wrapper })

    act(() => {
      void result.current.activate()
    })
    expect(result.current.isOn).toBe(true)
    expect(result.current.pending).toBe(true)

    await act(async () => {
      deferred.resolve({ ok: true, data: undefined })
      await deferred.promise
    })
    // Success keeps the optimistic state until a patch arrives or the 5s backstop fires.
    expect(result.current.isOn).toBe(true)
    expect(result.current.pending).toBe(false)
  })

  it('reverts the optimistic state when the call fails', async () => {
    vi.spyOn(api, 'performAction').mockResolvedValue({ ok: false, status: 503 })
    const dev = toggleDevice()
    const { result } = renderHook(() => useToggleDevice(dev, false), { wrapper })
    await act(async () => {
      await result.current.activate()
    })
    await waitFor(() => expect(result.current.isOn).toBe(false))
    expect(result.current.error).toBe('Action failed')
  })

  it('clears the optimistic state when the connection drops', async () => {
    // The optimistic state is a bet that a patch will confirm it. Once the stream
    // is gone no patch can arrive, so continuing to show "On" would be a lie that
    // outlives the evidence for it. Only covered here — the tile tests exercise
    // the button's disabled attribute, not this branch.
    const deferred = defer<Awaited<ReturnType<typeof api.performAction>>>()
    vi.spyOn(api, 'performAction').mockReturnValue(deferred.promise)
    const dev = toggleDevice()
    const { result, rerender } = renderHook(({ off }) => useToggleDevice(dev, off), {
      initialProps: { off: false },
      wrapper,
    })

    act(() => {
      void result.current.activate()
    })
    expect(result.current.isOn).toBe(true)

    await act(async () => {
      rerender({ off: true })
    })
    expect(result.current.isOn).toBe(false)

    await act(async () => {
      deferred.resolve({ ok: true, data: undefined })
      await deferred.promise
    })
  })

  it('reports canActivate false when no action applies', async () => {
    const d = toggleDevice({ allowedActions: [] })
    const { result } = renderHook(() => useToggleDevice(d, false), { wrapper })
    expect(result.current.canActivate).toBe(false)
  })

  it('shows Unknown when stale', async () => {
    const d = toggleDevice({ state: { state: 'on', attributes: {}, stale: true } })
    const { result } = renderHook(() => useToggleDevice(d, false), { wrapper })
    expect(result.current.stateText).toBe('Unknown')
  })
})

describe('useLockDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function lockDevice(): Device {
    return {
      entityId: 'lock.front',
      label: 'Front Door',
      domain: 'lock',
      allowedActions: ['lock', 'unlock'],
      sortOrder: 0,
      state: { state: 'locked', attributes: {}, stale: false },
    }
  }

  it('arms on the first unlock request rather than unlocking', async () => {
    const performActionSpy = vi
      .spyOn(api, 'performAction')
      .mockResolvedValue({ ok: true, data: undefined })
    const dev = lockDevice()
    const { result } = renderHook(() => useLockDevice(dev, false), { wrapper })
    await act(async () => {
      await result.current.requestUnlock()
    })
    expect(result.current.unlockConfirmPending).toBe(true)
    expect(performActionSpy).not.toHaveBeenCalled()
  })

  it('unlocks on the second request', async () => {
    const performActionSpy = vi
      .spyOn(api, 'performAction')
      .mockResolvedValue({ ok: true, data: undefined })
    const dev = lockDevice()
    const { result } = renderHook(() => useLockDevice(dev, false), { wrapper })
    await act(async () => {
      await result.current.requestUnlock()
    })
    await act(async () => {
      await result.current.requestUnlock()
    })
    await waitFor(() =>
      expect(performActionSpy).toHaveBeenCalledWith('lock.front', 'unlock', PORTAL_ID),
    )
  })
})

describe('useCoverDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function coverDevice(overrides: Partial<Device> = {}): Device {
    return {
      entityId: 'cover.garage',
      label: 'Garage Door',
      domain: 'cover',
      allowedActions: ['open_cover', 'close_cover', 'stop_cover'],
      sortOrder: 0,
      state: { state: 'closed', attributes: {}, stale: false },
      ...overrides,
    }
  }

  it('reports closed state', async () => {
    const dev = coverDevice()
    const { result } = renderHook(() => useCoverDevice(dev, false), { wrapper })
    expect(result.current.stateText).toBe('Closed')
  })

  it('calls open_cover when open is triggered', async () => {
    const performActionSpy = vi
      .spyOn(api, 'performAction')
      .mockResolvedValue({ ok: true, data: undefined })
    const dev = coverDevice()
    const { result } = renderHook(() => useCoverDevice(dev, false), { wrapper })
    await act(async () => {
      await result.current.open()
    })
    await waitFor(() =>
      expect(performActionSpy).toHaveBeenCalledWith('cover.garage', 'open_cover', PORTAL_ID),
    )
  })

  it('calls close_cover when close is triggered', async () => {
    const performActionSpy = vi
      .spyOn(api, 'performAction')
      .mockResolvedValue({ ok: true, data: undefined })
    const dev = coverDevice()
    const { result } = renderHook(() => useCoverDevice(dev, false), { wrapper })
    await act(async () => {
      await result.current.close()
    })
    await waitFor(() =>
      expect(performActionSpy).toHaveBeenCalledWith('cover.garage', 'close_cover', PORTAL_ID),
    )
  })

  it('calls stop_cover when stop is triggered', async () => {
    const performActionSpy = vi
      .spyOn(api, 'performAction')
      .mockResolvedValue({ ok: true, data: undefined })
    const dev = coverDevice()
    const { result } = renderHook(() => useCoverDevice(dev, false), { wrapper })
    await act(async () => {
      await result.current.stop()
    })
    await waitFor(() =>
      expect(performActionSpy).toHaveBeenCalledWith('cover.garage', 'stop_cover', PORTAL_ID),
    )
  })

  it('sets pending state during action', async () => {
    // Hold the action in flight: pending must be true only while it is unsettled.
    const deferred = defer<Awaited<ReturnType<typeof api.performAction>>>()
    vi.spyOn(api, 'performAction').mockReturnValue(deferred.promise)
    const dev = coverDevice()
    const { result } = renderHook(() => useCoverDevice(dev, false), { wrapper })

    expect(result.current.pending).toBe(false)
    act(() => {
      void result.current.open()
    })
    expect(result.current.pending).toBe(true)

    await act(async () => {
      deferred.resolve({ ok: true, data: undefined })
      await deferred.promise
    })
    expect(result.current.pending).toBe(false)
  })

  it('reports canOpen false when action is not allowed', async () => {
    const d = coverDevice({ allowedActions: ['close_cover'] })
    const { result } = renderHook(() => useCoverDevice(d, false), { wrapper })
    expect(result.current.canOpen).toBe(false)
    expect(result.current.canClose).toBe(true)
  })

  it('shows Unknown when stale', async () => {
    const d = coverDevice({ state: { state: 'open', attributes: {}, stale: true } })
    const { result } = renderHook(() => useCoverDevice(d, false), { wrapper })
    expect(result.current.stateText).toBe('Unknown')
  })
})
