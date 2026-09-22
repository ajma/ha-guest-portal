// src/server/store/auditlog.ts
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Role } from '../../shared/api.js'

export type AuditEntry = {
  portalId: string
  ts: number
  entityId: string
  action: string
  role: Role
  ok: boolean
}

const ActionLogRowSchema = z.object({
  ts: z.number(),
  entity_id: z.string(),
  action: z.string(),
  role: z.enum(['guest', 'admin']),
  ok: z.number(),
})

export class AuditLog {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(e: AuditEntry): void {
    this.db
      .prepare(
        'INSERT INTO action_log (portal_id, ts, entity_id, action, role, ok) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(e.portalId, e.ts, e.entityId, e.action, e.role, e.ok ? 1 : 0)
  }

  /**
   * Read side of the audit log. No production code calls this, and that is by
   * design rather than an oversight: the design doc makes the log "a test
   * oracle: integration tests assert on `action_log` rows, verifying the
   * decision the server made rather than the call it happened to emit"
   * (docs/superpowers/specs/2026-09-18-ha-guest-portal-design.md).
   *
   * That is what most of its callers do — routes-guest.test.ts checks what a
   * guest action wrote here, which is a real assertion about production code.
   * Deleting this would take the oracle with it.
   */
  recent(portalId: string, limit: number): Array<Omit<AuditEntry, 'portalId'>> {
    const rows = this.db
      .prepare(
        'SELECT ts, entity_id, action, role, ok FROM action_log WHERE portal_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(portalId, limit)

    const result: Array<Omit<AuditEntry, 'portalId'>> = []

    for (const row of rows) {
      const parsed = ActionLogRowSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }

      const { ts, entity_id, action, role, ok } = parsed.data

      result.push({
        ts,
        entityId: entity_id,
        action,
        role,
        ok: ok === 1,
      })
    }

    return result
  }
}
