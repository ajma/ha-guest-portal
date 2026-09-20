import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { AllowlistRow, CatalogEntry, Device } from '@shared/api.js'
import { useAllowlistEditor, type AllowlistEditor } from '../../src/web/hooks/useAllowlistEditor.ts'
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

const three = [
  ...two,
  device({ entityId: 'switch.fan', label: 'Fan', domain: 'switch', sortOrder: 2 }),
]

/** The payload of the nth PUT (1-based), as the server would receive it. */
function putBody(n: number): AllowlistRow[] {
  const body = vi.mocked(api.putAllowlist).mock.calls[n - 1]?.[0]
  if (body === undefined) throw new Error(`no PUT #${n} was sent`)
  return body
}

/**
 * Waits until `calls` PUTs have gone out AND the hook has settled — `pending`
 * going false is the render that follows the response.
 *
 * Waiting on the call count alone is not enough to pin the defect: the response
 * handler may not have re-rendered yet, so a second edit could still read a
 * pre-response closure and pass by luck. Settling first makes the base the
 * next edit computes from deterministic.
 */
async function settled(
  result: { readonly current: AllowlistEditor },
  calls: number,
): Promise<void> {
  await waitFor(() => {
    expect(api.putAllowlist).toHaveBeenCalledTimes(calls)
    expect(result.current.pending).toBe(false)
  })
}

function rowOf(body: AllowlistRow[], entityId: string): AllowlistRow {
  const row = body.find((r) => r.entityId === entityId)
  if (row === undefined) throw new Error(`${entityId} is not in that payload`)
  return row
}

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

  // Migrated from admin-screen 're-fetches allowlist after successful save and
  // adopts server-normalized values'. There is no re-fetch now — the stream is
  // the source of truth — so the equivalent guarantee is that the optimistic
  // overlay is dropped when the save SUCCEEDS, not only when it fails. A hook
  // that keeps the overlay on success passes every other test here and would
  // show the owner their own untrimmed text forever, while the server holds
  // something else.
  it('adopts the value the stream delivers once the save lands', async () => {
    const { result, rerender } = renderHook(
      ({ devices }: { devices: Device[] }) => useAllowlistEditor(devices),
      { initialProps: { devices: [device()] } },
    )

    act(() => {
      result.current.rename('light.porch', '  Porch Light  ')
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())

    // What the server actually stored, arriving over SSE.
    rerender({ devices: [device({ label: 'Porch Light' })] })

    await waitFor(() =>
      expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe(
        'Porch Light',
      ),
    )
  })

  /**
   * Every write is a whole-allowlist PUT, so the base a mutation is computed
   * from is load-bearing. The overlay used to be dropped the moment the PUT
   * resolved, but the server only broadcasts after a WebSocket round trip to
   * Home Assistant — and broadcasts nothing at all if that fails. Between the
   * response and the frame, `devices` still held the pre-edit list, so the next
   * mutation was built on it and undid the previous one on the server.
   *
   * These render with a fixed `devices` array and never rerender: that is the
   * stream not having caught up yet, and — indefinitely — the stream being
   * down, which edit mode deliberately keeps usable.
   */
  describe('with the stream yet to confirm', () => {
    it('does not resurrect a revoked action when the device is then renamed', async () => {
      const { result } = renderHook(() => useAllowlistEditor(two))

      act(() => {
        result.current.toggleAction('light.porch', 'turn_off')
      })
      await settled(result, 1)
      expect(rowOf(putBody(1), 'light.porch').allowedActions).toEqual(['turn_on'])

      act(() => {
        result.current.rename('light.porch', 'Porch Light')
      })
      await settled(result, 2)

      // The rename must carry the revocation forward. Sending the old action
      // list back would hand guests a capability the owner just took away.
      const renamed = rowOf(putBody(2), 'light.porch')
      expect(renamed.label).toBe('Porch Light')
      expect(renamed.allowedActions).toEqual(['turn_on'])
    })

    it('toggles the same action twice, rather than sending the same change twice', async () => {
      const { result } = renderHook(() => useAllowlistEditor(two))

      act(() => {
        result.current.toggleAction('light.porch', 'turn_off')
      })
      await settled(result, 1)

      act(() => {
        result.current.toggleAction('light.porch', 'turn_off')
      })
      await settled(result, 2)

      expect(rowOf(putBody(1), 'light.porch').allowedActions).toEqual(['turn_on'])
      expect(rowOf(putBody(2), 'light.porch').allowedActions).toContain('turn_off')
    })

    it('moves a device two positions for two clicks of Move up', async () => {
      const { result } = renderHook(() => useAllowlistEditor(three))

      act(() => {
        result.current.move('switch.fan', -1)
      })
      await settled(result, 1)
      expect(putBody(1).map((r) => r.entityId)).toEqual(['light.porch', 'switch.fan', 'lock.front'])

      act(() => {
        result.current.move('switch.fan', -1)
      })
      await settled(result, 2)
      expect(putBody(2).map((r) => r.entityId)).toEqual(['switch.fan', 'light.porch', 'lock.front'])
    })

    it('accumulates three different edits instead of each reverting the last', async () => {
      const { result } = renderHook(() => useAllowlistEditor(two))

      act(() => {
        result.current.rename('light.porch', 'Porch Light')
      })
      await settled(result, 1)

      act(() => {
        result.current.toggleAction('light.porch', 'turn_off')
      })
      await settled(result, 2)

      act(() => {
        result.current.move('light.porch', 1)
      })
      await settled(result, 3)

      const final = putBody(3)
      expect(rowOf(final, 'light.porch').label).toBe('Porch Light')
      expect(rowOf(final, 'light.porch').allowedActions).toEqual(['turn_on'])
      expect(final.map((r) => [r.entityId, r.sortOrder])).toEqual([
        ['lock.front', 0],
        ['light.porch', 1],
      ])
      // And what the owner sees matches what was last sent.
      expect(result.current.rows).toEqual(final)
    })

    it('reverts the edit that failed, and only that edit', async () => {
      const { result } = renderHook(() => useAllowlistEditor(two))

      act(() => {
        result.current.toggleAction('light.porch', 'turn_off')
      })
      await settled(result, 1)

      vi.mocked(api.putAllowlist).mockResolvedValue({ ok: false, status: 500 })
      act(() => {
        result.current.rename('light.porch', 'Porch Light')
      })
      await waitFor(() => expect(result.current.error).not.toBeNull())

      // The rename never landed, so it goes — immediately, without waiting for
      // a frame that a failing server may never send. The revocation did land,
      // and a whole-list PUT is atomic, so the server still holds it: throwing
      // it away here would make the next edit restore it.
      const shown = rowOf(result.current.rows, 'light.porch')
      expect(shown.label).toBe('Porch')
      expect(shown.allowedActions).toEqual(['turn_on'])
    })

    it('adopts the stream again as soon as it delivers a different list', async () => {
      const { result, rerender } = renderHook(
        ({ devices }: { devices: Device[] }) => useAllowlistEditor(devices),
        { initialProps: { devices: [device()] } },
      )

      act(() => {
        result.current.rename('light.porch', '  Porch Light  ')
      })
      await settled(result, 1)

      // A state-only patch frame rebuilds the device array without touching the
      // allowlist. That is not the server confirming anything, so the overlay
      // has to survive it.
      rerender({ devices: [device({ state: { state: 'on', attributes: {}, stale: false } })] })
      expect(rowOf(result.current.rows, 'light.porch').label).toBe('  Porch Light  ')

      // The allowlist snapshot is, and retires the overlay — so the owner sees
      // what the server actually stored rather than their own untrimmed text.
      rerender({ devices: [device({ label: 'Porch Light' })] })
      await waitFor(() =>
        expect(rowOf(result.current.rows, 'light.porch').label).toBe('Porch Light'),
      )

      act(() => {
        result.current.rename('light.porch', 'Front Porch')
      })
      await settled(result, 2)
      expect(rowOf(putBody(2), 'light.porch').label).toBe('Front Porch')
    })
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
