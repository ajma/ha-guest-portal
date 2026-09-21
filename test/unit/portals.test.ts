import { describe, expect, it, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.js'
import { PortalStore, DuplicatePasswordError } from '../../src/server/store/portals.js'

describe('PortalStore', () => {
  let db: DatabaseSync
  let store: PortalStore

  beforeEach(() => {
    db = openDb(':memory:')
    store = new PortalStore(db)
  })

  it('creates a portal with defaults and lists it', () => {
    const created = store.create({ title: 'Timothy', password: 'a-secret-1' })
    expect(created.title).toBe('Timothy')
    expect(created.enabled).toBe(true)
    expect(created.theme).toBe('classic')
    expect(typeof created.id).toBe('string')

    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(created.id)
  })

  it('rejects a duplicate password on create', () => {
    store.create({ title: 'Timothy', password: 'shared-pass' })
    expect(() => store.create({ title: 'Mary', password: 'shared-pass' })).toThrow(
      DuplicatePasswordError,
    )
  })

  it('rejects a duplicate password on update, but allows keeping your own', () => {
    const a = store.create({ title: 'Timothy', password: 'pass-a' })
    const b = store.create({ title: 'Mary', password: 'pass-b' })

    expect(() => store.update(b.id, { password: 'pass-a' })).toThrow(DuplicatePasswordError)
    expect(() => store.update(a.id, { password: 'pass-a' })).not.toThrow()
  })

  it('finds a portal by its password', () => {
    const created = store.create({ title: 'Timothy', password: 'find-me' })
    expect(store.findByPassword('find-me')?.id).toBe(created.id)
    expect(store.findByPassword('wrong')).toBeNull()
  })

  it('updates title, theme, and enabled independently', () => {
    const created = store.create({ title: 'Timothy', password: 'a-secret-2' })
    const updated = store.update(created.id, { title: 'Tim', theme: 'tiles', enabled: false })
    expect(updated).toEqual({ ...created, title: 'Tim', theme: 'tiles', enabled: false })
  })

  it('deletes a portal', () => {
    const created = store.create({ title: 'Timothy', password: 'a-secret-3' })
    store.delete(created.id)
    expect(store.list()).toHaveLength(0)
  })

  it('normalizes a whitespace-padded title on create', () => {
    const created = store.create({ title: '  Padded  ', password: 'pass-1' })
    expect(created.title).toBe('Padded')
  })

  it('falls back to default title when creating with empty or whitespace-only title', () => {
    const emptyCreated = store.create({ title: '', password: 'empty-pass' })
    expect(emptyCreated.title).toBe('Guest Portal')

    const whitespaceCreated = store.create({ title: '   ', password: 'whitespace-pass' })
    expect(whitespaceCreated.title).toBe('Guest Portal')
  })

  it('falls back to default title when updating to empty or whitespace-only title', () => {
    const created = store.create({ title: 'Original', password: 'update-pass' })

    const updatedEmpty = store.update(created.id, { title: '' })
    expect(updatedEmpty.title).toBe('Guest Portal')

    const updatedWhitespace = store.update(created.id, { title: '   ' })
    expect(updatedWhitespace.title).toBe('Guest Portal')
  })

  it('notifies onEnabledChange only when enabled actually flips', () => {
    const created = store.create({ title: 'Timothy', password: 'a-secret-4' })
    const seen: Array<{ portalId: string; enabled: boolean }> = []
    store.onEnabledChange((portalId, enabled) => seen.push({ portalId, enabled }))

    store.update(created.id, { title: 'Tim' }) // no enabled change
    expect(seen).toEqual([])

    store.update(created.id, { enabled: false })
    expect(seen).toEqual([{ portalId: created.id, enabled: false }])

    store.update(created.id, { enabled: false }) // already false, no change
    expect(seen).toEqual([{ portalId: created.id, enabled: false }])
  })
})
