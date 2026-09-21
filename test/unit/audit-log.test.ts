import { describe, expect, it, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.js'
import { PortalStore } from '../../src/server/store/portals.js'
import { AuditLog } from '../../src/server/store/auditlog.js'

describe('AuditLog (portal-scoped)', () => {
  let db: DatabaseSync
  let audit: AuditLog
  let timothy: string
  let mary: string

  beforeEach(() => {
    db = openDb(':memory:')
    const portals = new PortalStore(db)
    audit = new AuditLog(db)
    timothy = portals.create({ title: 'Timothy', password: 'pass-1' }).id
    mary = portals.create({ title: 'Mary', password: 'pass-2' }).id
  })

  it('keeps each portal\'s audit trail separate', () => {
    audit.record({ portalId: timothy, ts: 1, entityId: 'light.a', action: 'turn_on', role: 'guest', ok: true })
    audit.record({ portalId: mary, ts: 2, entityId: 'light.b', action: 'turn_on', role: 'guest', ok: true })

    expect(audit.recent(timothy, 10)).toHaveLength(1)
    expect(audit.recent(timothy, 10)[0]?.entityId).toBe('light.a')
    expect(audit.recent(mary, 10)[0]?.entityId).toBe('light.b')
  })
})
