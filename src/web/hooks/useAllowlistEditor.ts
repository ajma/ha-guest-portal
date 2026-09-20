import { useCallback, useState } from 'react'
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
 * Instant-save editing of the allowlist.
 *
 * There is no dirty state by design. This page also holds a live SSE stream, so
 * batching edits locally would mean reconciling every incoming snapshot against
 * uncommitted changes. Writing immediately keeps the stream authoritative: the
 * optimistic overlay exists only for the moment a request is in flight, and is
 * dropped as soon as the server answers either way.
 *
 * Mutations are keyed by entity id, never by index — another session's edit can
 * reorder the list underneath, and an index would then hit the wrong device.
 */
export function useAllowlistEditor(devices: Device[]): AllowlistEditor {
  const [optimistic, setOptimistic] = useState<AllowlistRow[] | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = optimistic ?? toRows(devices)

  const commit = useCallback(async (next: AllowlistRow[]): Promise<void> => {
    setOptimistic(next)
    setPending(true)
    setError(null)

    try {
      const result = await putAllowlist(next)
      if (!result.ok) {
        setError('Could not save that change')
      }
    } catch {
      // `putAllowlist` reports HTTP failures as `{ ok: false }`, but nothing in
      // the api client guards `fetch` itself — offline, aborted and DNS
      // failures reject. Callers reach this through `void commit(...)`, so
      // without this the owner would see the edit silently revert with no
      // explanation, and the rejection would go unhandled.
      setError('Could not save that change')
    } finally {
      // Either way the overlay goes: on success the stream delivers the same
      // list, on failure the stream still holds the truth we reverted to.
      setOptimistic(null)
      setPending(false)
    }
  }, [])

  const mutate = useCallback(
    (fn: (current: AllowlistRow[]) => AllowlistRow[] | null): void => {
      const next = fn(optimistic ?? toRows(devices))
      if (next === null) return
      void commit(next)
    },
    [commit, devices, optimistic],
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
