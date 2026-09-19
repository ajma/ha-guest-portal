import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'

describe('InteractionStore', () => {
  let db: DatabaseSync
  let store: InteractionStore

  beforeEach(() => {
    db = openDb(':memory:')
    store = new InteractionStore(db)
  })

  it('returns null before any interaction', () => {
    expect(store.latest()).toBeNull()
  })

  it('round-trips an action interaction', () => {
    store.record({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })

    expect(store.latest()).toEqual({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })
  })

  it('round-trips a login interaction with null device columns', () => {
    store.record({
      ts: 1_700_000_000_001,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })

    expect(store.latest()).toEqual({
      ts: 1_700_000_000_001,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })
  })

  it('keeps only the most recent interaction', () => {
    store.record({
      ts: 1,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })
    store.record({
      ts: 2,
      kind: 'action',
      entityId: 'light.porch',
      label: 'Porch',
      action: 'turn_on',
      ok: false,
    })

    expect(store.latest()?.ts).toBe(2)

    const count = db.prepare('SELECT COUNT(*) AS n FROM guest_interaction').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('persists across store instances', () => {
    store.record({
      ts: 42,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })

    expect(new InteractionStore(db).latest()?.ts).toBe(42)
  })

  it('records a failed action', () => {
    store.record({
      ts: 7,
      kind: 'action',
      entityId: 'lock.back',
      label: 'Back Door',
      action: 'unlock',
      ok: false,
    })

    expect(store.latest()?.ok).toBe(false)
  })
})
