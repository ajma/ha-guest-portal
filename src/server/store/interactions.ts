import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export type GuestInteraction = {
  portalId: string
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
 * Append-only per portal. Home Assistant's recorder keeps the state history of
 * the sensor fed by each portal's latest row, so a second history here would
 * be redundant — `latest()` is the only read this store needs to support. It is
 * persisted to SQLite rather than held in memory so the sensor does not blank to
 * `unknown` on restart.
 */
export class InteractionStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(e: GuestInteraction): void {
    this.db
      .prepare(
        `INSERT INTO guest_interaction (portal_id, ts, kind, entity_id, label, action, ok)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.portalId, e.ts, e.kind, e.entityId, e.label, e.action, e.ok ? 1 : 0)
  }

  latest(portalId: string): Omit<GuestInteraction, 'portalId'> | null {
    const row = this.db
      .prepare(
        'SELECT ts, kind, entity_id, label, action, ok FROM guest_interaction WHERE portal_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(portalId)

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
