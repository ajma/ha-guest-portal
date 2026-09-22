import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { AllowlistRow, CatalogEntry, Device } from '@shared/api.js'
import { useAllowlistEditor, type AllowlistEditor } from '../../src/web/hooks/useAllowlistEditor.ts'
import * as api from '../../src/web/api.ts'
import * as store from '../../src/web/store.ts'

vi.mock('../../src/web/api.ts')

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
  const body = vi.mocked(api.putPortalAllowlist).mock.calls[n - 1]?.[1]
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
    expect(api.putPortalAllowlist).toHaveBeenCalledTimes(calls)
    expect(result.current.pending).toBe(false)
  })
}

function rowOf(body: AllowlistRow[], entityId: string): AllowlistRow {
  const row = body.find((r) => r.entityId === entityId)
  if (row === undefined) throw new Error(`${entityId} is not in that payload`)
  return row
}

type Allowlist = { ok: true; data: { devices: AllowlistRow[]; orphaned: string[] } }

/** What GET /api/portals/:id/allowlist answers for these devices. */
function loaded(devices: Device[], orphaned: string[] = []): Allowlist {
  return {
    ok: true,
    data: {
      devices: devices.map(({ entityId, label, allowedActions, sortOrder }) => ({
        entityId,
        label,
        allowedActions,
        sortOrder,
      })),
      orphaned,
    },
  }
}

const fan = {
  entityId: 'switch.fan',
  name: 'Fan',
  domain: 'switch',
  supported: true,
} as CatalogEntry

describe('useAllowlistEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The hook reads the streaming portal's identity from the device store, a
    // module-level singleton. Nothing here connects one unless it says so, and
    // with no stream open the store names no portal — which is how these tests
    // get to hand `devices` in directly.
    store.resetStore()
    vi.mocked(api.putPortalAllowlist).mockResolvedValue({ ok: true, data: undefined })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue(loaded([]))
  })

  afterEach(() => {
    cleanup()
    store.resetStore()
    vi.restoreAllMocks()
  })

  it('derives rows from the live devices, sorted', () => {
    const { result } = renderHook(() => useAllowlistEditor([two[1] as Device, two[0] as Device], 'portal-1', true, true))
    expect(result.current.rows.map((r) => r.entityId)).toEqual(['light.porch', 'lock.front'])
  })

  it('renames by entity id, not by position', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))
    act(() => {
      result.current.rename('lock.front', 'Front Door')
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[1]
    expect(sent?.find((r) => r.entityId === 'lock.front')?.label).toBe('Front Door')
    expect(sent?.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
  })

  it('mutates the right device when the stream delivers the list in another order', async () => {
    // Another session's edit can reorder the list underneath us. Rows are ordered
    // by sortOrder, so here the incoming array order and the row order disagree:
    // anything keyed by array position would rename the other device.
    const { result } = renderHook(() => useAllowlistEditor([two[1] as Device, two[0] as Device], 'portal-1', true, true))
    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[1]
    expect(sent?.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch Light')
    expect(sent?.find((r) => r.entityId === 'lock.front')?.label).toBe('Front')
  })

  it('adds a device with every action for its domain, so it is usable immediately', async () => {
    const entry = {
      entityId: 'switch.fan',
      name: 'Fan',
      domain: 'switch',
      supported: true,
    } as CatalogEntry
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))
    act(() => {
      result.current.add(entry)
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[1]
    const added = sent?.find((r) => r.entityId === 'switch.fan')
    expect(added?.allowedActions).toEqual(['turn_on', 'turn_off', 'toggle'])
    expect(added?.sortOrder).toBe(2)
  })

  // The picker only offers supported domains, so this shouldn't occur in
  // practice — but the lookup itself has to fail closed rather than throw.
  it('adds a device with no allowed actions when its domain has none defined', async () => {
    const entry = {
      entityId: 'climate.thermostat',
      name: 'Thermostat',
      domain: 'climate',
      supported: false,
    } as CatalogEntry
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))
    act(() => {
      result.current.add(entry)
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[1]
    const added = sent?.find((r) => r.entityId === 'climate.thermostat')
    expect(added?.allowedActions).toEqual([])
  })

  it('toggles an action off and on again', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))
    act(() => {
      result.current.toggleAction('light.porch', 'turn_off')
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[1]
    expect(sent?.find((r) => r.entityId === 'light.porch')?.allowedActions).toEqual(['turn_on'])
  })

  it('removes by entity id', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))
    act(() => {
      result.current.remove('light.porch')
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[1]
    expect(sent?.map((r) => r.entityId)).toEqual(['lock.front'])
    // The survivor closes the gap the removal left, so sortOrder stays contiguous.
    expect(sent?.map((r) => r.sortOrder)).toEqual([0])
  })

  it('reindexes sortOrder after a move so the order is contiguous', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))
    act(() => {
      result.current.move('lock.front', -1)
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[1]
    expect(sent?.map((r) => [r.entityId, r.sortOrder])).toEqual([
      ['lock.front', 0],
      ['light.porch', 1],
    ])
  })

  it('ignores a move that would fall off either end', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))
    act(() => {
      result.current.move('light.porch', -1)
    })
    act(() => {
      result.current.move('lock.front', 1)
    })
    expect(api.putPortalAllowlist).not.toHaveBeenCalled()
    // Control: an in-range move through the same entry point does save, so the
    // assertion above pins the bounds check rather than a hook that never writes.
    act(() => {
      result.current.move('light.porch', 1)
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalledTimes(1))
  })

  it('shows the change immediately, before the server answers', async () => {
    const deferred = defer<Awaited<ReturnType<typeof api.putPortalAllowlist>>>()
    vi.mocked(api.putPortalAllowlist).mockReturnValue(deferred.promise)
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))

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
      ({ devices }: { devices: Device[] }) => useAllowlistEditor(devices, 'portal-1', true, true),
      { initialProps: { devices: [device()] } },
    )

    act(() => {
      result.current.rename('light.porch', '  Porch Light  ')
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())

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
      const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))

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
      const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))

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
      const { result } = renderHook(() => useAllowlistEditor(three, 'portal-1', true, true))

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
      const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))

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
      const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))

      act(() => {
        result.current.toggleAction('light.porch', 'turn_off')
      })
      await settled(result, 1)

      vi.mocked(api.putPortalAllowlist).mockResolvedValue({ ok: false, status: 500 })
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
        ({ devices }: { devices: Device[] }) => useAllowlistEditor(devices, 'portal-1', true, true),
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
    // putPortalAllowlist reports HTTP failures as { ok: false }, but nothing in the
    // api client guards fetch itself — offline and aborted requests reject.
    // Mutations are fired with `void commit(...)`, so an uncaught rejection
    // here would surface as an unhandled error and the owner would see the
    // edit revert with no explanation.
    vi.mocked(api.putPortalAllowlist).mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.pending).toBe(false)
    expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
  })

  it('reverts and reports when the save fails', async () => {
    vi.mocked(api.putPortalAllowlist).mockResolvedValue({ ok: false, status: 500 })
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    // The grid must go back to the truth, not keep showing a change that
    // never landed.
    expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
  })

  it('clears the error once it is dismissed', async () => {
    vi.mocked(api.putPortalAllowlist).mockResolvedValue({ ok: false, status: 500 })
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-1', true, true))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())

    act(() => {
      result.current.dismissError()
    })
    expect(result.current.error).toBeNull()
  })

  // Every save is a whole-allowlist PUT, and the list it is computed from comes
  // from a live stream. Whenever that list is empty or stale — the stream is
  // down, the portal was just switched, the snapshot has not arrived yet — a
  // single edit would replace the portal's real allowlist with it.
  describe('the list a save is computed from', () => {
    it('is the portal allowlist the server holds, not an empty stream', async () => {
      vi.mocked(api.getPortalAllowlist).mockResolvedValue(loaded(two))
      const { result } = renderHook(() => useAllowlistEditor([], 'portal-1', true, false))
      await waitFor(() => expect(result.current.ready).toBe(true))

      act(() => {
        result.current.add(fan)
      })
      await settled(result, 1)

      expect(putBody(1).map((r) => r.entityId)).toEqual([
        'light.porch',
        'lock.front',
        'switch.fan',
      ])
    })

    it('survives the stream dropping out after it has delivered', async () => {
      vi.mocked(api.getPortalAllowlist).mockResolvedValue(loaded(two))
      const { result, rerender } = renderHook(
        ({ devices, connected }: { devices: Device[]; connected: boolean }) =>
          useAllowlistEditor(devices, 'portal-1', true, connected),
        { initialProps: { devices: two, connected: true } },
      )

      // The store empties its snapshot when the EventSource goes away, so an
      // empty frame is also what a closed stream looks like. Taking it for
      // "this portal has no devices" is how the whole allowlist gets erased.
      rerender({ devices: [], connected: false })
      act(() => {
        result.current.rename('lock.front', 'Front Door')
      })
      await settled(result, 1)

      expect(putBody(1).map((r) => r.label)).toEqual(['Porch', 'Front Door'])
    })

    it('lets the server empty a base the stream no longer shows', async () => {
      // Another session, or the integration, removes every device from the
      // portal while this owner's stream is down. The empty snapshot that
      // arrives with it says nothing — the hook refuses it — so the fetch has
      // to be able to lower the base, or the next add would PUT the deleted
      // devices back.
      const { result, rerender } = renderHook(
        ({ devices, editing }: { devices: Device[]; editing: boolean }) =>
          useAllowlistEditor(devices, 'portal-1', editing, false),
        { initialProps: { devices: two, editing: true } },
      )

      rerender({ devices: [], editing: false })
      rerender({ devices: [], editing: true })
      await waitFor(() => expect(result.current.rows).toHaveLength(0))

      act(() => {
        result.current.add(fan)
      })
      await settled(result, 1)

      expect(putBody(1).map((r) => r.entityId)).toEqual(['switch.fan'])
    })

    it('lets a live stream empty it, since only a live one can say that', async () => {
      // The other half of the rule above, and the one the fetch cannot cover:
      // the owner is sitting in edit mode, so nothing re-enters it and no
      // second GET is ever issued. If a live empty frame is refused here, the
      // deleted devices stay in the base until the page is left, and the next
      // add PUTs every one of them back.
      vi.mocked(api.getPortalAllowlist).mockResolvedValue(loaded(two))
      const { result, rerender } = renderHook(
        ({ devices, connected }: { devices: Device[]; connected: boolean }) =>
          useAllowlistEditor(devices, 'portal-1', true, connected),
        { initialProps: { devices: two, connected: true } },
      )
      await waitFor(() => expect(result.current.rows).toHaveLength(2))

      rerender({ devices: [], connected: true })
      act(() => {
        result.current.add(fan)
      })
      await settled(result, 1)

      expect(putBody(1).map((r) => r.entityId)).toEqual(['switch.fan'])
    })

    it('is empty from the first render when a live stream shows nothing', async () => {
      // The stream effect only runs when the key CHANGES, and it starts out
      // holding the mount frame's key — so for a portal that is genuinely
      // empty, nothing after mount ever re-decides this. The initial value is
      // the only thing that can read the live empty stream as an answer, and
      // if it does not, the owner is told to wait for a fetch that may be the
      // slower of the two.
      const never = defer<Allowlist>()
      vi.mocked(api.getPortalAllowlist).mockReturnValue(never.promise)
      const { result } = renderHook(() => useAllowlistEditor([], 'portal-1', true, true))

      expect(result.current.ready).toBe(true)
      act(() => {
        result.current.add(fan)
      })
      await settled(result, 1)

      expect(putBody(1).map((r) => r.entityId)).toEqual(['switch.fan'])
    })

    it('does not let a fetch older than the deletion resurrect what a live frame removed', async () => {
      // The owner is in edit mode, so the GET is already in flight when
      // another session empties the allowlist. The live empty frame lands
      // first and correctly lowers the base; the response that follows
      // describes the list as it was BEFORE the deletion. Taking it would put
      // every deleted device back on the next save — an empty base is only
      // stale-looking here, the stream has answered and it is the newer of the
      // two.
      const gate = defer<Allowlist>()
      vi.mocked(api.getPortalAllowlist).mockReturnValue(gate.promise)
      const { result, rerender } = renderHook(
        ({ devices }: { devices: Device[] }) => useAllowlistEditor(devices, 'portal-1', true, true),
        { initialProps: { devices: two } },
      )

      rerender({ devices: [] })
      await waitFor(() => expect(result.current.rows).toHaveLength(0))

      await act(async () => {
        gate.resolve(loaded(two))
        await gate.promise
      })

      act(() => {
        result.current.add(fan)
      })
      await settled(result, 1)

      expect(putBody(1).map((r) => r.entityId)).toEqual(['switch.fan'])
    })

    it('does not undo a stream frame that lands while the fetch is in flight', async () => {
      // The other half of the rule above: while the stream is delivering it is
      // ahead of any response, so a device another session has just added must
      // not be dropped from the base — the next save would delete it.
      const gate = defer<Allowlist>()
      vi.mocked(api.getPortalAllowlist).mockReturnValue(gate.promise)
      const { result, rerender } = renderHook(
        ({ devices }: { devices: Device[] }) => useAllowlistEditor(devices, 'portal-1', true, true),
        { initialProps: { devices: two } },
      )

      rerender({ devices: three })
      await act(async () => {
        gate.resolve(loaded(two))
        await gate.promise
      })

      act(() => {
        result.current.rename('light.porch', 'Porch Light')
      })
      await settled(result, 1)

      expect(putBody(1).map((r) => r.entityId)).toEqual([
        'light.porch',
        'lock.front',
        'switch.fan',
      ])
    })

    it('refuses the edit, and says why, while it is still unknown', async () => {
      const gate = defer<Allowlist>()
      vi.mocked(api.getPortalAllowlist).mockReturnValue(gate.promise)
      const { result } = renderHook(() => useAllowlistEditor([], 'portal-1', true, false))

      act(() => {
        result.current.add(fan)
      })
      expect(api.putPortalAllowlist).not.toHaveBeenCalled()
      expect(result.current.ready).toBe(false)
      // A refusal the owner cannot see is a dead button: they retry, nothing
      // happens, and they have no reason to wait rather than give up.
      expect(result.current.error).not.toBeNull()

      await act(async () => {
        gate.resolve(loaded(two))
        await gate.promise
      })
      act(() => {
        result.current.add(fan)
      })
      await settled(result, 1)
      expect(putBody(1)).toHaveLength(3)
    })

    it('is not fetched outside edit mode, where only an admin may ask for it', () => {
      // A guest hitting the admin allowlist endpoint takes a 401, and the api
      // client turns any 401 into a logout.
      renderHook(() => useAllowlistEditor(two, 'portal-1', false, true))
      expect(api.getPortalAllowlist).not.toHaveBeenCalled()
    })
  })

  it('never writes the previous portal edits onto the portal switched to', async () => {
    // The hook is not remounted on a portal switch, and every save is a
    // whole-allowlist PUT. An optimistic row left over from the portal the
    // owner just left would be sent as part of the new portal's list, which
    // replaces it — the devices here stand in for a stream that has not
    // delivered the new portal's snapshot yet.
    // Mary's own allowlist shares nothing with the list the stream is still
    // showing, which is what makes the leak visible: an edit computed from
    // Timothy's devices would replace hers with them.
    vi.mocked(api.getPortalAllowlist).mockResolvedValue(
      loaded([device({ entityId: 'switch.fan', label: 'Fan', domain: 'switch', sortOrder: 0 })]),
    )
    const { result, rerender } = renderHook(
      ({ portalId }: { portalId: string }) => useAllowlistEditor(two, portalId, true, true),
      { initialProps: { portalId: 'timothy' } },
    )

    act(() => {
      result.current.rename('light.porch', 'Timothy porch')
    })
    await settled(result, 1)

    rerender({ portalId: 'mary' })
    expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => {
      result.current.rename('switch.fan', 'Mary fan')
    })
    await settled(result, 2)

    expect(vi.mocked(api.putPortalAllowlist).mock.calls[1]?.[0]).toBe('mary')
    expect(putBody(2).map((r) => r.label)).toEqual(['Mary fan'])
  })

  it('refuses stream rows that still describe the portal the owner just left', async () => {
    // The store empties its devices when a stream is torn down, but that runs
    // in an effect cleanup: a frame for the portal being left can land in the
    // very batch that switches to the next one. The render-phase reset nulls
    // `base`, and an effect that adopts whatever the stream is holding puts
    // the old portal's rows straight back — now under the new portal's id,
    // where the next whole-list PUT writes them over the new portal's own
    // allowlist. Only the store can settle whose rows these are; inferring it
    // from which render they arrived in is what produced this bug.
    const OriginalEventSource = globalThis.EventSource
    globalThis.EventSource = class FakeEventSource {
      addEventListener(): void {}
      close(): void {}
    } as unknown as typeof EventSource
    const teardownStream = store.connectDeviceStore('timothy')

    try {
      const maryAllowlist = defer<Allowlist>()
      vi.mocked(api.getPortalAllowlist).mockImplementation((portalId) =>
        portalId === 'mary' ? maryAllowlist.promise : Promise.resolve(loaded([device()])),
      )

      const { result, rerender } = renderHook(
        ({ portalId, devices }: { portalId: string; devices: Device[] }) =>
          useAllowlistEditor(devices, portalId, true, true),
        { initialProps: { portalId: 'timothy', devices: [device()] } },
      )

      // Timothy's stream delivers a second device in the same batch as the
      // switch to Mary. The stream is still Timothy's — nothing has torn it
      // down yet, and the store says so.
      rerender({ portalId: 'mary', devices: two })
      await act(async () => {
        maryAllowlist.resolve(loaded([]))
        await maryAllowlist.promise
      })

      act(() => {
        result.current.add(fan)
      })
      await settled(result, 1)

      expect(vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[0]).toBe('mary')
      expect(putBody(1).map((r) => r.entityId)).toEqual(['switch.fan'])
    } finally {
      teardownStream()
      globalThis.EventSource = OriginalEventSource
    }
  })

  it('refuses an allowlist for the portal the owner has already moved away from', async () => {
    // The GET is issued per portal and the hook is not remounted on a switch,
    // so a slow response for the portal that was left resolves into a hook now
    // pointed at another one. Nothing downstream refuses it: `base` was just
    // nulled by the render-phase reset, so the old portal's devices become the
    // new portal's base, and the next edit is a whole-list PUT of them over
    // this portal's own allowlist. The abandon token is the only thing that
    // stops it — the same guard PortalSettingsAccordion carries, and the same
    // thing its 'ignores a save that lands after the owner switched portals'
    // pins there.
    //
    // What this reaches is the token being READ after the response resolves,
    // which nothing else covers. It cannot separate the two places that SET
    // `abandoned`: a switch fires both the render-phase reset and the
    // `[portalId]` effect cleanup, so each covers for the other and dropping
    // either alone still passes here. Dropping both does not — and the cleanup
    // is pinned on its own by 'drops the load left behind when the effects
    // remount under it', which reaches it without the reset.
    //
    // The reset's own window — the GET resolving after the switch commits and
    // before the passive-effect flush — stays unpinned: React Testing Library
    // flushes effects before handing control back, so that interleaving is not
    // reachable from a test. The caveat note in the hook is what defends it.
    const timothy = defer<Allowlist>()
    vi.mocked(api.getPortalAllowlist).mockImplementation((portalId) =>
      portalId === 'timothy' ? timothy.promise : Promise.resolve(loaded([])),
    )

    const { result, rerender } = renderHook(
      ({ portalId }: { portalId: string }) => useAllowlistEditor([], portalId, true, false),
      { initialProps: { portalId: 'timothy' } },
    )

    // Mary's allowlist is empty and answers at once, so the base a save would
    // be computed from is settled before Timothy's reply lands. The stream is
    // down throughout, which is what leaves the fetch as the only thing that
    // can set a base — nothing else here can refuse Timothy's.
    rerender({ portalId: 'mary' })
    await waitFor(() => expect(result.current.ready).toBe(true))

    await act(async () => {
      timothy.resolve(loaded(two, ['light.gone']))
      await timothy.promise
    })

    // Timothy's devices are not Mary's, and neither are the entities Home
    // Assistant has stopped knowing about in his portal.
    expect(result.current.rows).toEqual([])
    expect(result.current.orphaned).toEqual([])

    act(() => {
      result.current.add(fan)
    })
    await settled(result, 1)

    expect(vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[0]).toBe('mary')
    expect(putBody(1).map((r) => r.entityId)).toEqual(['switch.fan'])
  })

  it('drops the load left behind when the effects remount under it', async () => {
    // The other half of the token, and the only path that reaches it on its
    // own. A portal switch fires BOTH the render-phase reset and this effect's
    // cleanup, so neither can be pinned there — each covers for the other. An
    // effect remount fires only the cleanup: `portalId` never changes, so the
    // reset block never runs, and the cleanup is the whole guard.
    //
    // `src/web/main.tsx` mounts the app in StrictMode, so this is what every
    // dev mount of this hook already does, and Fast Refresh does it again on
    // every edit. Both mounts issue a GET for the same portal. If the one
    // belonging to the mount that was thrown away is still allowed to land, it
    // overwrites the surviving mount's base with an older list — and the next
    // edit is a whole-list PUT of it.
    const abandonedLoad = defer<Allowlist>()
    const survivingLoad = defer<Allowlist>()
    const queued = [abandonedLoad, survivingLoad]
    vi.mocked(api.getPortalAllowlist).mockImplementation(() => {
      const next = queued.shift()
      if (next === undefined) throw new Error('a third GET was issued')
      return next.promise
    })

    const { result } = renderHook(() => useAllowlistEditor([], 'timothy', true, false), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(api.getPortalAllowlist).toHaveBeenCalledTimes(2))

    // The surviving mount's load answers first, so its list is the base. The
    // discarded mount's answers after it, describing the portal as it was
    // before a device was removed elsewhere.
    await act(async () => {
      survivingLoad.resolve(
        loaded([device({ entityId: 'switch.fan', label: 'Fan', domain: 'switch', sortOrder: 0 })]),
      )
      await survivingLoad.promise
    })
    await act(async () => {
      abandonedLoad.resolve(loaded(two))
      await abandonedLoad.promise
    })

    expect(result.current.rows.map((r) => r.entityId)).toEqual(['switch.fan'])
  })

  it('saves against the given portal id', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two, 'portal-42', true, true))
    act(() => {
      result.current.add({ entityId: 'switch.fan', name: 'Fan', domain: 'switch', supported: true } as CatalogEntry)
    })
    await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
    expect(vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[0]).toBe('portal-42')
  })
})
