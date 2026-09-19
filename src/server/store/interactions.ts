// src/server/store/interactions.ts
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export type GuestInteraction = {
  ts: number
  kind: 'action' | 'login'
  entityId: string | null
  label: string | null
  action: string | null
  ok: boolean
}

const InteractionRowSchema = z.object({
  ts: z.number(),
  kind: z.enum(['action', 'login']),
  entity_id: z.string().nullable(),
  label: z.string().nullable(),
  action: z.string().nullable(),
  ok: z.number(),
})

/**
 * Holds only the most recent guest interaction, upserted on id = 1.
 *
 * Home Assistant's recorder keeps the state history of the sensor fed by this
 * row, so a second history here would be redundant. It is persisted rather
 * than held in memory so the sensor does not blank to `unknown` on restart.
 */
export class InteractionStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(e: GuestInteraction): void {
    this.db
      .prepare(
        `INSERT INTO guest_interaction (id, ts, kind, entity_id, label, action, ok)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ts = excluded.ts,
           kind = excluded.kind,
           entity_id = excluded.entity_id,
           label = excluded.label,
           action = excluded.action,
           ok = excluded.ok`,
      )
      .run(e.ts, e.kind, e.entityId, e.label, e.action, e.ok ? 1 : 0)
  }

  latest(): GuestInteraction | null {
    const row = this.db
      .prepare('SELECT ts, kind, entity_id, label, action, ok FROM guest_interaction WHERE id = 1')
      .get()

    if (row === undefined) return null

    const parsed = InteractionRowSchema.safeParse(row)
    if (!parsed.success) return null

    const { ts, kind, entity_id, label, action, ok } = parsed.data

    return {
      ts,
      kind,
      entityId: entity_id,
      label,
      action,
      ok: ok === 1,
    }
  }
}
