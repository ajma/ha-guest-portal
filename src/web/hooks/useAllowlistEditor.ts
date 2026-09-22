import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AllowlistRow, CatalogEntry, Device } from '@shared/api.js'
import { DOMAIN_ACTIONS, type SupportedDomain } from '@shared/devices.js'
import { getPortalAllowlist, putPortalAllowlist } from '../api.js'
import { useDeviceStore } from '../store.js'

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
 * Whether the stream has actually answered *for `portalId`*, as opposed to
 * having said nothing about it yet.
 *
 * A delivered list is the server's own answer and the freshest base there is.
 * An empty one is only an answer while the stream is up: the store empties its
 * snapshot when the stream is torn down, so the same frame arrives on every
 * disconnect saying nothing at all. `connected` separates them — the store
 * clears `devices` and `connected` in one snapshot object with one
 * notification (`store.ts`), so a teardown is never seen as a live empty list.
 *
 * Both answers are load-bearing and they fail in opposite directions. Reading
 * a torn-down stream as "no devices" PUTs `[]` and erases the allowlist;
 * refusing a live empty one leaves an allowlist another session emptied
 * un-lowerable, and puts every deleted device back. Every site that decides
 * what `base` should be asks this one function, because three inline copies of
 * the question is how the two directions kept getting different answers.
 *
 * `streamPortalId` is the third input rather than a separate guard because it
 * is the same question: rows belonging to another portal have told this portal
 * nothing. Which makes it right in both directions too — the effect declines
 * them, and `load()` treats the GET as the only thing that has spoken. A
 * portal switch leaves the store still naming the portal that was left until
 * its teardown effect runs, and a frame landing in that batch is precisely the
 * case this catches. Null means no stream at all, which claims nothing either
 * way and is left to `rows`/`connected` to decide.
 *
 * Where that third input is actually load-bearing, as of this writing: the
 * stream effect only. At the other two call sites — the initial `base` and
 * `load()` — both branches currently agree whatever it answers, because a
 * portal switch nulls `base` first and `Portal.tsx` is the only caller of
 * `connectDeviceStore`, so the store's refcount never exceeds 1 and two
 * portals' streams are never open at once. They pass it because the question
 * is the same one and asking it three different ways is what went wrong
 * before, not because the guard is what protects them today. Anyone moving one
 * of those call sites — or adding a second `connectDeviceStore` caller — is
 * removing an unreachability argument, not leaning on a live check.
 */
function streamHasAnswered(
  rows: AllowlistRow[],
  connected: boolean,
  streamPortalId: string | null,
  portalId: string,
): boolean {
  if (streamPortalId !== null && streamPortalId !== portalId) return false
  return rows.length > 0 || connected
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
 * the two apart — see `streamHasAnswered`. `editing` gates the fetch that fills
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
  // `devices` reaches this hook as a prop but carries no portal identity, and
  // the caller has none to add — the store is the only thing that knows whose
  // stream produced them, so it is read here directly rather than inferred
  // from the order renders arrive in.
  const streamPortalId = useDeviceStore().streamPortalId ?? null
  // The stream effect below only fires when the key CHANGES, and `lastStreamKey`
  // starts out holding the mount frame's key — so nothing re-decides the mount
  // frame. This initial value is the only thing that reads it.
  const [base, setBase] = useState<AllowlistRow[] | null>(
    streamHasAnswered(streamRows, connected, streamPortalId, portalId) ? streamRows : null,
  )
  const [orphaned, setOrphaned] = useState<string[]>([])
  const [loadFailed, setLoadFailed] = useState(false)

  // One token per portal this hook has been pointed at, abandoned when it moves
  // on or unmounts — the same guard PortalSettingsAccordion uses, and needed
  // here for the same reason: a response for the portal that was left must not
  // become the base the next save is computed from. Declared above the reset
  // block below because that block abandons it; see the note there.
  //
  // `abandoned` is the only field anything may read. `forPortalId` is a label,
  // and `load()` used to compare it against its own `portalId` as though it
  // were a second, independent guard: the token is built from the same
  // `portalId` the callback closes over, so that comparison was always false
  // and the cleanup was carrying the guard alone. Do not reinstate it. It is
  // kept as a label because the token is per-portal and the dependency below
  // is the whole mechanism — dropping the field makes `[portalId]` look
  // unused, and the lint fix for that (remove the dependency) would pin this
  // token at the mount portal's forever, so the reset block's abandon would
  // never be undone and no load would ever land again.
  const loadTarget = useRef({ forPortalId: portalId, abandoned: false })
  useEffect(() => {
    const target = { forPortalId: portalId, abandoned: false }
    loadTarget.current = target
    return () => {
      target.abandoned = true
    }
  }, [portalId])

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
    // Abandon the in-flight GET here, not only in the effect cleanup below.
    // This line is the whole guard for the window between them, and removing
    // it puts one portal's allowlist back in reach of another's save button.
    //
    // React flushes passive effects on a macrotask; a resolved `fetch`
    // continuation resumes on a microtask. So a GET issued for the portal
    // being left can resolve AFTER this render commits and BEFORE the cleanup
    // that would have marked it abandoned. `base` is null at that instant —
    // just set, above — and `load()` adopts the old portal's list as this
    // portal's base. The next click is a whole-list PUT of the wrong portal's
    // devices.
    //
    // This is the earliest moment the hook learns the portal changed, and the
    // token still in the ref is the one the outstanding GET holds: the effect
    // installs a fresh one only after commit, and its cleanup then covers
    // unmount. Mutating a ref in render is impure, but this
    // block already sets state during render for the same reason, and the
    // write only fires when `portalId` genuinely changed — which changes
    // `load`'s identity and re-runs the fetching effect, so the load being
    // abandoned is never one anybody still wants.
    loadTarget.current.abandoned = true
  }

  useEffect(() => {
    if (streamKey === lastStreamKey.current) return
    lastStreamKey.current = streamKey
    setOptimistic(null)
    if (streamHasAnswered(streamRows, connected, streamPortalId, portalId)) setBase(streamRows)
  }, [streamKey, streamRows, connected, streamPortalId, portalId])

  // Read after the response, so refs rather than dependencies of `load`: that
  // callback is keyed to the portal, and rebuilding it per stream frame would
  // refetch the allowlist on every frame — or, for `connected`, on every
  // connection blip.
  const latestStreamRows = useRef(streamRows)
  const latestConnected = useRef(connected)
  const latestStreamPortalId = useRef(streamPortalId)
  useEffect(() => {
    latestStreamRows.current = streamRows
    latestConnected.current = connected
    latestStreamPortalId.current = streamPortalId
  }, [streamRows, connected, streamPortalId])

  const load = useCallback(async (): Promise<void> => {
    const target = loadTarget.current
    // Read through the token, never captured as a boolean: it is false when
    // the GET is issued and the whole point is what it says once it resolves.
    const abandoned = (): boolean => target.abandoned
    try {
      const result = await getPortalAllowlist(portalId)
      if (abandoned()) return
      if (!result.ok) {
        setLoadFailed(true)
        return
      }
      setLoadFailed(false)
      setOrphaned(result.data.orphaned)
      // Behind the stream whenever the stream has answered, since it can be
      // ahead of this response — authoritative only when it has not. An empty
      // stream is NOT on its own a silent one: a live empty frame is an answer,
      // and a newer one than a GET issued before the deletion that emptied it,
      // so adopting here would resurrect every device that frame removed.
      // Left as a pure fallback nothing could lower the base either, so this
      // still has to fire when the stream is down — that is the other
      // direction, and the same question decides both.
      setBase((current) =>
        current === null ||
        !streamHasAnswered(
          latestStreamRows.current,
          latestConnected.current,
          latestStreamPortalId.current,
          portalId,
        )
          ? result.data.devices
          : current,
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
