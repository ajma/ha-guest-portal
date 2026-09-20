import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AllowlistRow, CatalogEntry, Device } from '@shared/api.js'
import { putAllowlist } from '../api.js'

export type AllowlistEditor = {
  rows: AllowlistRow[]
  pending: boolean
  error: string | null
  add: (entity: CatalogEntry) => void
  remove: (entityId: string) => void
  rename: (entityId: string, label: string) => void
  toggleAction: (entityId: string, action: string) => void
  move: (entityId: string, direction: -1 | 1) => void
  dismissError: () => void
}

/** `Device` is a superset of `AllowlistRow`; the stream is the source of truth. */
function toRows(devices: Device[]): AllowlistRow[] {
  return [...devices]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ entityId, label, allowedActions, sortOrder }) => ({
      entityId,
      label,
      allowedActions,
      sortOrder,
    }))
}

function reindex(rows: AllowlistRow[]): AllowlistRow[] {
  return rows.map((row, i) => ({ ...row, sortOrder: i }))
}

/**
 * A key for "the allowlist the stream is currently showing".
 *
 * `devices` is stable by identity between frames — `useSyncExternalStore` hands
 * back the same snapshot until one arrives — but a `patch` frame rebuilds the
 * array for a mere state change (a light switching on), which says nothing
 * about the allowlist. Comparing the projection instead means only an actual
 * allowlist change retires the overlay.
 */
function allowlistKey(rows: AllowlistRow[]): string {
  return JSON.stringify(rows)
}

/**
 * Instant-save editing of the allowlist.
 *
 * There is no dirty state by design. This page also holds a live SSE stream, so
 * batching edits locally would mean reconciling every incoming snapshot against
 * uncommitted changes. Writing immediately keeps the stream authoritative.
 *
 * The optimistic overlay lives from the moment an edit is made until the stream
 * delivers a different allowlist — *that* is the server confirming, and it is
 * the only event that makes `devices` a safe base again. It is deliberately not
 * dropped when the PUT resolves: the server broadcasts only after a WebSocket
 * round trip to Home Assistant (`src/server/runtime.ts`), and broadcasts
 * nothing at all if that fails, so between the response and the frame `devices`
 * still holds the pre-edit list. Every write is a whole-allowlist PUT, so
 * computing the next one from that list would silently undo the last edit — and
 * with the stream down it would do so on every edit, with no race involved.
 *
 * A failed save still reverts immediately, and reverts exactly the edit that
 * failed: the PUT is atomic, so the server still holds the list the mutation
 * was computed from, and that list — not the possibly older one the stream last
 * delivered — is what the overlay goes back to.
 *
 * Mutations are keyed by entity id, never by index — another session's edit can
 * reorder the list underneath, and an index would then hit the wrong device.
 */
export function useAllowlistEditor(devices: Device[]): AllowlistEditor {
  const [optimistic, setOptimistic] = useState<AllowlistRow[] | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const streamRows = useMemo(() => toRows(devices), [devices])
  const streamKey = useMemo(() => allowlistKey(streamRows), [streamRows])
  const lastStreamKey = useRef(streamKey)

  useEffect(() => {
    if (streamKey === lastStreamKey.current) return
    lastStreamKey.current = streamKey
    setOptimistic(null)
  }, [streamKey])

  const rows = optimistic ?? streamRows

  const commit = useCallback(
    async (next: AllowlistRow[], previous: AllowlistRow[] | null): Promise<void> => {
      setOptimistic(next)
      setPending(true)
      setError(null)

      let saved = false
      try {
        const result = await putAllowlist(next)
        saved = result.ok
      } catch {
        // `putAllowlist` reports HTTP failures as `{ ok: false }`, but nothing
        // in the api client guards `fetch` itself — offline, aborted and DNS
        // failures reject. Callers reach this through `void commit(...)`, so
        // without this the owner would see the edit silently revert with no
        // explanation, and the rejection would go unhandled.
        saved = false
      }

      if (!saved) {
        // `previous` is null when this edit was computed from the stream's own
        // list, which is the common case and the plain revert.
        setOptimistic(previous)
        setError('Could not save that change')
      }
      setPending(false)
    },
    [],
  )

  const mutate = useCallback(
    (fn: (current: AllowlistRow[]) => AllowlistRow[] | null): void => {
      const next = fn(rows)
      if (next === null) return
      void commit(next, optimistic)
    },
    [commit, optimistic, rows],
  )

  return {
    rows,
    pending,
    error,
    dismissError: () => {
      setError(null)
    },
    add: (entity) =>
      mutate((current) =>
        reindex([
          ...current,
          { entityId: entity.entityId, label: entity.name, allowedActions: [], sortOrder: 0 },
        ]),
      ),
    remove: (entityId) =>
      mutate((current) => reindex(current.filter((r) => r.entityId !== entityId))),
    rename: (entityId, label) =>
      mutate((current) => current.map((r) => (r.entityId === entityId ? { ...r, label } : r))),
    toggleAction: (entityId, action) =>
      mutate((current) =>
        current.map((r) =>
          r.entityId === entityId
            ? {
                ...r,
                allowedActions: r.allowedActions.includes(action)
                  ? r.allowedActions.filter((a) => a !== action)
                  : [...r.allowedActions, action],
              }
            : r,
        ),
      ),
    move: (entityId, direction) =>
      mutate((current) => {
        const from = current.findIndex((r) => r.entityId === entityId)
        const to = from + direction
        if (from === -1 || to < 0 || to >= current.length) return null
        const next = [...current]
        const [moved] = next.splice(from, 1)
        if (moved === undefined) return null
        next.splice(to, 0, moved)
        return reindex(next)
      }),
  }
}
