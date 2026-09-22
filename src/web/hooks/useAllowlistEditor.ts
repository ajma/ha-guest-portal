import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AllowlistRow, CatalogEntry, Device } from '@shared/api.js'
import { DOMAIN_ACTIONS, type SupportedDomain } from '@shared/devices.js'
import { getPortalAllowlist, putPortalAllowlist } from '../api.js'

function defaultActionsFor(domain: string): readonly string[] {
  return Object.hasOwn(DOMAIN_ACTIONS, domain)
    ? DOMAIN_ACTIONS[domain as SupportedDomain]
    : []
}

export type AllowlistEditor = {
  rows: AllowlistRow[]
  pending: boolean
  error: string | null
  /** False while the list a save would be computed from is still unknown. */
  ready: boolean
  loadFailed: boolean
  orphaned: string[]
  reload: () => void
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
 *
 * `base` is the list a save is computed from, and null means "not known yet".
 * That distinction is the point of it: an empty stream on its own is
 * indistinguishable from a portal with no devices, and a whole-list PUT
 * computed from the wrong one erases the allowlist. `connected` is what tells
 * the two apart — see the stream effect. `editing` gates the fetch that fills
 * `base` — the endpoint is admin-only, and a guest reaching it takes a 401,
 * which the api client turns into a logout.
 */
export function useAllowlistEditor(
  devices: Device[],
  portalId: string,
  editing: boolean,
  connected: boolean,
): AllowlistEditor {
  const [optimistic, setOptimistic] = useState<AllowlistRow[] | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const streamRows = useMemo(() => toRows(devices), [devices])
  const streamKey = useMemo(() => allowlistKey(streamRows), [streamRows])
  const lastStreamKey = useRef(streamKey)
  const [editingPortalId, setEditingPortalId] = useState(portalId)
  const [base, setBase] = useState<AllowlistRow[] | null>(
    streamRows.length > 0 ? streamRows : null,
  )
  const [orphaned, setOrphaned] = useState<string[]>([])
  const [loadFailed, setLoadFailed] = useState(false)

  // Same render-phase reset as PortalSettingsAccordion, for the same reason:
  // callers render this page without a key, so a portal switch keeps the hook
  // and its optimistic rows. Those rows describe the portal that was left, and
  // the next save is a whole-list PUT — dropping them in an effect instead
  // would leave a commit in which a click writes them to the new portal.
  //
  // `base` goes to null rather than to the stream's rows: at this render the
  // stream still holds the list of the portal that was left.
  if (editingPortalId !== portalId) {
    setEditingPortalId(portalId)
    setOptimistic(null)
    setError(null)
    setBase(null)
    setOrphaned([])
    setLoadFailed(false)
  }

  useEffect(() => {
    if (streamKey === lastStreamKey.current) return
    lastStreamKey.current = streamKey
    setOptimistic(null)
    // A delivered list is the server's own answer and the freshest base there
    // is. An empty one is only an answer while the stream is up: the store
    // empties its snapshot when the stream is torn down, so the same frame
    // arrives on every disconnect saying nothing at all. `connected` separates
    // them — the store clears `devices` and `connected` in one snapshot
    // (`store.ts`), so a teardown is never seen as a live empty list. Refusing
    // a live one instead would leave an allowlist another session emptied
    // un-lowerable until the next fetch, and put every deleted device back.
    if (streamRows.length > 0 || connected) setBase(streamRows)
  }, [streamKey, streamRows, connected])

  // One token per portal this hook has been pointed at, abandoned when it moves
  // on or unmounts — the same guard PortalSettingsAccordion uses, and needed
  // here for the same reason: a response for the portal that was left must not
  // become the base the next save is computed from.
  const loadTarget = useRef({ portalId, abandoned: false })
  useEffect(() => {
    const target = { portalId, abandoned: false }
    loadTarget.current = target
    return () => {
      target.abandoned = true
    }
  }, [portalId])

  // Read after the response, so a ref rather than a dependency of `load`: that
  // callback is keyed to the portal, and rebuilding it per stream frame would
  // refetch the allowlist on every frame.
  const latestStreamRows = useRef(streamRows)
  useEffect(() => {
    latestStreamRows.current = streamRows
  }, [streamRows])

  const load = useCallback(async (): Promise<void> => {
    const target = loadTarget.current
    const abandoned = (): boolean => target.abandoned || target.portalId !== portalId
    try {
      const result = await getPortalAllowlist(portalId)
      if (abandoned()) return
      if (!result.ok) {
        setLoadFailed(true)
        return
      }
      setLoadFailed(false)
      setOrphaned(result.data.orphaned)
      // Behind the stream while it is delivering, since it can be ahead of this
      // response — but authoritative when it is not. Left as a pure fallback,
      // nothing could ever lower the base: an allowlist emptied in another
      // session arrives as the empty snapshot this hook refuses to adopt, and
      // the next save would put every deleted device back.
      setBase((current) =>
        current === null || latestStreamRows.current.length === 0 ? result.data.devices : current,
      )
    } catch {
      if (!abandoned()) setLoadFailed(true)
    }
  }, [portalId])

  useEffect(() => {
    if (!editing) return
    void load()
  }, [editing, load])

  const rows = optimistic ?? base ?? streamRows

  const commit = useCallback(
    async (next: AllowlistRow[], previous: AllowlistRow[] | null): Promise<void> => {
      setOptimistic(next)
      setPending(true)
      setError(null)

      let saved = false
      try {
        const result = await putPortalAllowlist(portalId, next)
        saved = result.ok
      } catch {
        // `putPortalAllowlist` reports HTTP failures as `{ ok: false }`, but nothing
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
    [portalId],
  )

  const mutate = useCallback(
    (fn: (current: AllowlistRow[]) => AllowlistRow[] | null): void => {
      // Refusing has to be said out loud. Silently dropping the edit leaves a
      // button that does nothing, and the owner no reason to wait rather than
      // to keep clicking it.
      if (base === null) {
        setError(
          loadFailed
            ? 'Could not load this portal’s device list, so nothing was changed'
            : 'Still loading this portal’s device list — try that again in a moment',
        )
        return
      }
      const next = fn(rows)
      if (next === null) return
      void commit(next, optimistic)
    },
    [base, commit, loadFailed, optimistic, rows],
  )

  return {
    rows,
    pending,
    error,
    ready: base !== null,
    loadFailed,
    orphaned,
    reload: () => {
      setLoadFailed(false)
      void load()
    },
    dismissError: () => {
      setError(null)
    },
    add: (entity) =>
      mutate((current) =>
        reindex([
          ...current,
          {
            entityId: entity.entityId,
            label: entity.name,
            allowedActions: [...defaultActionsFor(entity.domain)],
            sortOrder: 0,
          },
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
