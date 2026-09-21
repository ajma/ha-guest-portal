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
})
