// test/unit/store.test.ts

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AllowlistStore } from '../../src/server/store/allowlist.ts'
import { AuditLog } from '../../src/server/store/auditlog.ts'
import { openDb } from '../../src/server/store/db.ts'
import type { AllowlistRow } from '../../src/shared/api.ts'

describe('openDb', () => {
  it('creates tables on first open', () => {
    const db = openDb(':memory:')

    // Verify exposed_device table exists
    const deviceTableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='exposed_device'")
      .get()
    expect(deviceTableCheck).toEqual({ name: 'exposed_device' })

    // Verify action_log table exists
    const logTableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_log'")
      .get()
    expect(logTableCheck).toEqual({ name: 'action_log' })
  })

  it('is idempotent (calling openDb twice is safe)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ha-test-'))
    const dbPath = join(tempDir, 'test.db')

    try {
      // First open: create tables and insert data
      const db1 = openDb(dbPath)
      db1.exec(
        "INSERT INTO exposed_device (entity_id, label, allowed_actions, sort_order) VALUES ('light.a', 'A', '[]', 0)",
      )

      // Second open: should not throw, should not clobber data
      const db2 = openDb(dbPath)
      const result = db2.prepare('SELECT entity_id FROM exposed_device').get()

      expect(result).toEqual({ entity_id: 'light.a' })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('AllowlistStore', () => {
  it('list() returns empty array when store is empty', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)
    expect(store.list()).toEqual([])
  })

  it('entityIds() returns empty array when store is empty', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)
    expect(store.entityIds()).toEqual([])
  })

  it('asMap() returns empty map when store is empty', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)
    expect(store.asMap()).toEqual(new Map())
  })

  it('replace() inserts new rows and fires onChange', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const events: string[][] = []
    store.onChange((entityIds) => {
      events.push(entityIds)
    })

    const rows: AllowlistRow[] = [
      {
        entityId: 'light.porch',
        label: 'Porch Light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 1,
      },
      { entityId: 'switch.fan', label: 'Ceiling Fan', allowedActions: ['toggle'], sortOrder: 2 },
    ]

    store.replace(rows)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(['light.porch', 'switch.fan'])
    expect(store.list()).toEqual(rows)
  })

  it('replace() is atomic: duplicate primary key leaves previous contents intact', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const initial: AllowlistRow[] = [
      { entityId: 'light.a', label: 'A', allowedActions: ['turn_on'], sortOrder: 1 },
    ]
    store.replace(initial)

    const events: string[][] = []
    store.onChange((entityIds) => {
      events.push(entityIds)
    })

    // Try to insert rows with duplicate entity_id
    const badRows: AllowlistRow[] = [
      { entityId: 'light.b', label: 'B', allowedActions: ['turn_off'], sortOrder: 1 },
      { entityId: 'light.b', label: 'B Duplicate', allowedActions: ['toggle'], sortOrder: 2 },
    ]

    expect(() => store.replace(badRows)).toThrow()

    // Previous contents should remain intact
    expect(store.list()).toEqual(initial)

    // onChange should NOT have fired
    expect(events).toHaveLength(0)
  })

  it('replace() fires onChange exactly once with new entity IDs', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const events: string[][] = []
    store.onChange((entityIds) => {
      events.push(entityIds)
    })

    store.replace([{ entityId: 'light.a', label: 'A', allowedActions: ['turn_on'], sortOrder: 1 }])

    store.replace([
      { entityId: 'light.b', label: 'B', allowedActions: ['turn_off'], sortOrder: 1 },
      { entityId: 'light.c', label: 'C', allowedActions: ['toggle'], sortOrder: 2 },
    ])

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual(['light.a'])
    expect(events[1]).toEqual(['light.b', 'light.c'])
  })

  it('onChange() unsubscribe works', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const events: string[][] = []
    const unsubscribe = store.onChange((entityIds) => {
      events.push(entityIds)
    })

    store.replace([{ entityId: 'light.a', label: 'A', allowedActions: ['turn_on'], sortOrder: 1 }])

    expect(events).toHaveLength(1)

    unsubscribe()

    store.replace([{ entityId: 'light.b', label: 'B', allowedActions: ['turn_off'], sortOrder: 1 }])

    // Should still be 1 because we unsubscribed
    expect(events).toHaveLength(1)
  })

  it('onChange() unsubscribe is idempotent', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const unsubscribe = store.onChange(() => {})

    unsubscribe()
    unsubscribe() // Should not throw

    expect(true).toBe(true)
  })

  it('list() returns rows ordered by sortOrder, then entityId', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const rows: AllowlistRow[] = [
      { entityId: 'light.c', label: 'C', allowedActions: ['turn_on'], sortOrder: 2 },
      { entityId: 'light.a', label: 'A', allowedActions: ['turn_off'], sortOrder: 1 },
      { entityId: 'light.b', label: 'B', allowedActions: ['toggle'], sortOrder: 1 },
    ]

    store.replace(rows)

    const result = store.list()
    expect(result.map((r) => r.entityId)).toEqual(['light.a', 'light.b', 'light.c'])
  })

  it('asMap() returns correct Map<string, readonly string[]>', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    store.replace([
      {
        entityId: 'light.porch',
        label: 'Porch',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 1,
      },
      { entityId: 'lock.front', label: 'Front Door', allowedActions: ['lock'], sortOrder: 2 },
    ])

    const map = store.asMap()
    expect(map.get('light.porch')).toEqual(['turn_on', 'turn_off'])
    expect(map.get('lock.front')).toEqual(['lock'])
    expect(map.get('nonexistent')).toBeUndefined()
  })

  it('allowedActions survives JSON round-trip', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const rows: AllowlistRow[] = [
      {
        entityId: 'light.a',
        label: 'A',
        allowedActions: ['turn_on', 'turn_off', 'toggle'],
        sortOrder: 1,
      },
    ]

    store.replace(rows)

    const result = store.list()
    expect(result[0]?.allowedActions).toEqual(['turn_on', 'turn_off', 'toggle'])
  })

  it('handles corrupt JSON in allowedActions gracefully', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // Insert a good row and a corrupt row
      db.prepare(
        'INSERT INTO exposed_device (entity_id, label, allowed_actions, sort_order) VALUES (?, ?, ?, ?)',
      ).run('light.good', 'Good', '["turn_on"]', 1)

      db.prepare(
        'INSERT INTO exposed_device (entity_id, label, allowed_actions, sort_order) VALUES (?, ?, ?, ?)',
      ).run('light.corrupt', 'Corrupt', 'not valid json', 2)

      const result = store.list()

      // Should keep both rows
      expect(result).toHaveLength(2)

      // Good row should be intact
      expect(result[0]).toEqual({
        entityId: 'light.good',
        label: 'Good',
        allowedActions: ['turn_on'],
        sortOrder: 1,
      })

      // Corrupt row should appear with empty allowedActions (fail closed)
      expect(result[1]).toEqual({
        entityId: 'light.corrupt',
        label: 'Corrupt',
        allowedActions: [],
        sortOrder: 2,
      })

      // Should have logged an error naming the entity
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('light.corrupt'))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('throwing listener does not prevent other listeners from running', () => {
    const db = openDb(':memory:')
    const store = new AllowlistStore(db)

    const events1: string[][] = []
    const events2: string[][] = []

    store.onChange(() => {
      throw new Error('Listener 1 throws')
    })

    store.onChange((entityIds) => {
      events1.push(entityIds)
    })

    store.onChange(() => {
      throw new Error('Listener 2 throws')
    })

    store.onChange((entityIds) => {
      events2.push(entityIds)
    })

    // This should not throw, and both non-throwing listeners should fire
    store.replace([{ entityId: 'light.a', label: 'A', allowedActions: ['turn_on'], sortOrder: 1 }])

    expect(events1).toHaveLength(1)
    expect(events2).toHaveLength(1)
  })
})

describe('AuditLog', () => {
  it('recent() returns empty array when log is empty', () => {
    const db = openDb(':memory:')
    const log = new AuditLog(db)
    expect(log.recent(10)).toEqual([])
  })

  it('record() inserts an entry', () => {
    const db = openDb(':memory:')
    const log = new AuditLog(db)

    log.record({
      ts: 1234567890000,
      entityId: 'light.porch',
      action: 'turn_on',
      role: 'guest',
      ok: true,
    })

    const entries = log.recent(10)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      ts: 1234567890000,
      entityId: 'light.porch',
      action: 'turn_on',
      role: 'guest',
      ok: true,
    })
  })

  it('recent() returns newest first', () => {
    const db = openDb(':memory:')
    const log = new AuditLog(db)

    log.record({ ts: 1000, entityId: 'light.a', action: 'turn_on', role: 'guest', ok: true })
    log.record({ ts: 2000, entityId: 'light.b', action: 'turn_off', role: 'admin', ok: false })
    log.record({ ts: 3000, entityId: 'light.c', action: 'toggle', role: 'guest', ok: true })

    const entries = log.recent(10)
    expect(entries.map((e) => e.ts)).toEqual([3000, 2000, 1000])
  })

  it('recent() respects limit', () => {
    const db = openDb(':memory:')
    const log = new AuditLog(db)

    for (let i = 0; i < 20; i++) {
      log.record({ ts: i, entityId: 'light.a', action: 'turn_on', role: 'guest', ok: true })
    }

    const entries = log.recent(5)
    expect(entries).toHaveLength(5)
    expect(entries[0]?.ts).toBe(19)
    expect(entries[4]?.ts).toBe(15)
  })

  it('ok field round-trips as boolean', () => {
    const db = openDb(':memory:')
    const log = new AuditLog(db)

    log.record({ ts: 1000, entityId: 'light.a', action: 'turn_on', role: 'guest', ok: true })
    log.record({ ts: 2000, entityId: 'light.b', action: 'turn_off', role: 'admin', ok: false })

    const entries = log.recent(10)
    expect(entries[0]?.ok).toBe(false)
    expect(entries[1]?.ok).toBe(true)
    expect(typeof entries[0]?.ok).toBe('boolean')
    expect(typeof entries[1]?.ok).toBe('boolean')
  })
})
