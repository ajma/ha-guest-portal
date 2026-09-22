import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, beforeEach } from 'vitest'
import { openDb } from '../../src/server/store/db.js'
import { PortalStore } from '../../src/server/store/portals.js'
import { AllowlistStore } from '../../src/server/store/allowlist.js'

describe('AllowlistStore (portal-scoped)', () => {
  let db: DatabaseSync
  let portals: PortalStore
  let store: AllowlistStore
  let timothy: string
  let mary: string

  beforeEach(() => {
    db = openDb(':memory:')
    portals = new PortalStore(db)
    store = new AllowlistStore(db)
    timothy = portals.create({ title: 'Timothy', password: 'pass-1' }).id
    mary = portals.create({ title: 'Mary', password: 'pass-2' }).id
  })

  it('keeps each portal\'s allowlist independent', () => {
    store.replace(timothy, [
      { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    store.replace(mary, [
      { entityId: 'light.mary_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
    ])

    expect(store.list(timothy)).toHaveLength(1)
    expect(store.list(timothy)[0]?.entityId).toBe('light.timothy_room')
    expect(store.list(mary)[0]?.entityId).toBe('light.mary_room')
  })

  it('allows the same entity in more than one portal, independently configured', () => {
    store.replace(timothy, [
      { entityId: 'light.shared', label: 'Living Room', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    store.replace(mary, [
      {
        entityId: 'light.shared',
        label: 'Living Room',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
      },
    ])

    expect(store.asMap(timothy).get('light.shared')).toEqual(['turn_on'])
    expect(store.asMap(mary).get('light.shared')).toEqual(['turn_on', 'turn_off'])
  })

  it('notifies onChange with the portal id that changed', () => {
    const seen: Array<{ portalId: string; entityIds: string[] }> = []
    store.onChange((portalId, entityIds) => seen.push({ portalId, entityIds }))

    store.replace(timothy, [
      { entityId: 'light.a', label: 'A', allowedActions: [], sortOrder: 0 },
    ])

    expect(seen).toEqual([{ portalId: timothy, entityIds: ['light.a'] }])
  })

  it('does not roll back a transaction it did not start', () => {
    store.replace(timothy, [
      { entityId: 'light.keep', label: 'Keep', allowedActions: [], sortOrder: 0 },
    ])

    // A caller with its own transaction open. `replace`'s BEGIN cannot succeed
    // inside it, and the failure must be reported as-is — not turned into a
    // ROLLBACK that discards work belonging to whoever opened the outer one.
    db.exec('BEGIN')
    db.prepare('UPDATE portal SET title = ? WHERE id = ?').run('Renamed', timothy)

    expect(() =>
      store.replace(timothy, [
        { entityId: 'light.other', label: 'Other', allowedActions: [], sortOrder: 0 },
      ]),
    ).toThrow()

    expect(portals.get(timothy)?.title).toBe('Renamed')
    expect(store.list(timothy).map((r) => r.entityId)).toEqual(['light.keep'])

    db.exec('COMMIT')
    expect(portals.get(timothy)?.title).toBe('Renamed')
  })
})
