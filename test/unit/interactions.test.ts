import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'

describe('InteractionStore', () => {
  let db: DatabaseSync
  let store: InteractionStore

  beforeEach(() => {
    db = openDb(':memory:')
    db.exec("INSERT INTO portal (id, title, theme, password, enabled, created_at) VALUES ('portal-default', 'Default', 'classic', 'p', 1, 0)")
    store = new InteractionStore(db)
  })

  it('returns null before any interaction', () => {
    expect(store.latest('portal-default')).toBeNull()
  })

  it('round-trips an action interaction', () => {
    store.record({
      portalId: 'portal-default',
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })

    expect(store.latest('portal-default')).toEqual({
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
      portalId: 'portal-default',
      ts: 1_700_000_000_001,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })

    expect(store.latest('portal-default')).toEqual({
      ts: 1_700_000_000_001,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })
  })

  it('latest() returns the most recent interaction', () => {
    store.record({
      portalId: 'portal-default',
      ts: 1,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })
    store.record({
      portalId: 'portal-default',
      ts: 2,
      kind: 'action',
      entityId: 'light.porch',
      label: 'Porch',
      action: 'turn_on',
      ok: false,
    })

    expect(store.latest('portal-default')?.ts).toBe(2)

    const count = db.prepare('SELECT COUNT(*) AS n FROM guest_interaction').get() as { n: number }
    expect(count.n).toBe(2)
  })

  it('persists across store instances', () => {
    store.record({
      portalId: 'portal-default',
      ts: 42,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })

    expect(new InteractionStore(db).latest('portal-default')?.ts).toBe(42)
  })

  it('records a failed action', () => {
    store.record({
      portalId: 'portal-default',
      ts: 7,
      kind: 'action',
      entityId: 'lock.back',
      label: 'Back Door',
      action: 'unlock',
      ok: false,
    })

    expect(store.latest('portal-default')?.ok).toBe(false)
  })

  it('keeps each portal\'s latest interaction separate and append-only', () => {
    db.exec("INSERT INTO portal (id, title, theme, password, enabled, created_at) VALUES ('portal-timothy', 't', 'classic', 'p1', 1, 0), ('portal-mary', 'm', 'classic', 'p2', 1, 0)")

    const timothy = 'portal-timothy'
    const mary = 'portal-mary'

    store.record({ portalId: timothy, ts: 1, kind: 'login', entityId: null, label: null, action: null, ok: true })
    store.record({ portalId: mary, ts: 2, kind: 'login', entityId: null, label: null, action: null, ok: true })
    store.record({ portalId: timothy, ts: 3, kind: 'action', entityId: 'light.a', label: 'A', action: 'turn_on', ok: true })

    expect(store.latest(timothy)?.ts).toBe(3)
    expect(store.latest(mary)?.ts).toBe(2)

    const count = db.prepare('SELECT COUNT(*) AS n FROM guest_interaction').get() as { n: number }
    expect(count.n).toBe(3)
  })
})
