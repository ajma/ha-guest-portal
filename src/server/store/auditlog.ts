// src/server/store/auditlog.ts
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Role } from '../../shared/api.js'

export type AuditEntry = {
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
      .prepare('INSERT INTO action_log (ts, entity_id, action, role, ok) VALUES (?, ?, ?, ?, ?)')
      .run(e.ts, e.entityId, e.action, e.role, e.ok ? 1 : 0)
  }

  recent(limit: number): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT ts, entity_id, action, role, ok FROM action_log ORDER BY id DESC LIMIT ?')
      .all(limit)

    const result: AuditEntry[] = []

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
