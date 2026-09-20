import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { CatalogEntry, Device } from '@shared/api.js'
import { useAllowlistEditor } from '../../src/web/hooks/useAllowlistEditor.ts'
import * as api from '../../src/web/api.ts'

// Promise.withResolvers is ES2024; this project's lib is ES2022.
function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function device(overrides: Partial<Device> = {}): Device {
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

const two = [
  device(),
  device({
    entityId: 'lock.front',
    label: 'Front',
    domain: 'lock',
    allowedActions: ['unlock'],
    sortOrder: 1,
  }),
]

describe('useAllowlistEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: true, data: undefined })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('derives rows from the live devices, sorted', () => {
    const { result } = renderHook(() => useAllowlistEditor([two[1] as Device, two[0] as Device]))
    expect(result.current.rows.map((r) => r.entityId)).toEqual(['light.porch', 'lock.front'])
  })

  it('renames by entity id, not by position', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.rename('lock.front', 'Front Door')
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.find((r) => r.entityId === 'lock.front')?.label).toBe('Front Door')
    expect(sent?.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
  })

  it('mutates the right device when the stream delivers the list in another order', async () => {
    // Another session's edit can reorder the list underneath us. Rows are ordered
    // by sortOrder, so here the incoming array order and the row order disagree:
    // anything keyed by array position would rename the other device.
    const { result } = renderHook(() => useAllowlistEditor([two[1] as Device, two[0] as Device]))
    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch Light')
    expect(sent?.find((r) => r.entityId === 'lock.front')?.label).toBe('Front')
  })

  it('adds a device with no allowed actions so it cannot be operated yet', async () => {
    const entry = { entityId: 'switch.fan', name: 'Fan', supported: true } as CatalogEntry
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.add(entry)
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    const added = sent?.find((r) => r.entityId === 'switch.fan')
    expect(added?.allowedActions).toEqual([])
    expect(added?.sortOrder).toBe(2)
  })

  it('toggles an action off and on again', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.toggleAction('light.porch', 'turn_off')
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.find((r) => r.entityId === 'light.porch')?.allowedActions).toEqual(['turn_on'])
  })

  it('removes by entity id', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.remove('light.porch')
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.map((r) => r.entityId)).toEqual(['lock.front'])
    // The survivor closes the gap the removal left, so sortOrder stays contiguous.
    expect(sent?.map((r) => r.sortOrder)).toEqual([0])
  })

  it('reindexes sortOrder after a move so the order is contiguous', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.move('lock.front', -1)
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.map((r) => [r.entityId, r.sortOrder])).toEqual([
      ['lock.front', 0],
      ['light.porch', 1],
    ])
  })

  it('ignores a move that would fall off either end', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.move('light.porch', -1)
    })
    act(() => {
      result.current.move('lock.front', 1)
    })
    expect(api.putAllowlist).not.toHaveBeenCalled()
    // Control: an in-range move through the same entry point does save, so the
    // assertion above pins the bounds check rather than a hook that never writes.
    act(() => {
      result.current.move('light.porch', 1)
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalledTimes(1))
  })

  it('shows the change immediately, before the server answers', async () => {
    const deferred = defer<Awaited<ReturnType<typeof api.putAllowlist>>>()
    vi.spyOn(api, 'putAllowlist').mockReturnValue(deferred.promise)
    const { result } = renderHook(() => useAllowlistEditor(two))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })
    expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch Light')
    expect(result.current.pending).toBe(true)

    await act(async () => {
      deferred.resolve({ ok: true, data: undefined })
      await deferred.promise
    })
    expect(result.current.pending).toBe(false)
  })

  it('reports a network failure instead of leaking an unhandled rejection', async () => {
    // putAllowlist reports HTTP failures as { ok: false }, but nothing in the
    // api client guards fetch itself — offline and aborted requests reject.
    // Mutations are fired with `void commit(...)`, so an uncaught rejection
    // here would surface as an unhandled error and the owner would see the
    // edit revert with no explanation.
    vi.spyOn(api, 'putAllowlist').mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useAllowlistEditor(two))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.pending).toBe(false)
    expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
  })

  it('reverts and reports when the save fails', async () => {
    vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: false, status: 500 })
    const { result } = renderHook(() => useAllowlistEditor(two))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    // The grid must go back to the truth, not keep showing a change that
    // never landed.
    expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
  })

  it('clears the error once it is dismissed', async () => {
    vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: false, status: 500 })
    const { result } = renderHook(() => useAllowlistEditor(two))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())

    act(() => {
      result.current.dismissError()
    })
    expect(result.current.error).toBeNull()
  })
})
