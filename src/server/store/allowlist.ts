// src/server/store/allowlist.ts
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { AllowlistRow } from '../../shared/api.js'

export type AllowlistChangeListener = (portalId: string, entityIds: string[]) => void

const ExposedDeviceRowSchema = z.object({
  entity_id: z.string(),
  label: z.string(),
  allowed_actions: z.string(),
  sort_order: z.number(),
})

const EntityIdRowSchema = z.object({
  entity_id: z.string(),
})

export class AllowlistStore {
  private db: DatabaseSync
  private listeners: Set<AllowlistChangeListener> = new Set()

  constructor(db: DatabaseSync) {
    this.db = db
  }

  list(portalId: string): AllowlistRow[] {
    const rows = this.db
      .prepare(
        'SELECT entity_id, label, allowed_actions, sort_order FROM exposed_device WHERE portal_id = ? ORDER BY sort_order, entity_id',
      )
      .all(portalId)

    const result: AllowlistRow[] = []

    for (const row of rows) {
      const parsed = ExposedDeviceRowSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }

      const { entity_id, label, allowed_actions, sort_order } = parsed.data

      // Parse JSON defensively - fail closed but stay visible
      let allowedActions: string[]
      try {
        const jsonParsed = JSON.parse(allowed_actions)
        allowedActions = Array.isArray(jsonParsed) ? jsonParsed : []
      } catch {
        console.error(
          `Corrupt allowed_actions JSON for entity ${entity_id}, failing closed with empty actions`,
        )
        allowedActions = []
      }

      result.push({
        entityId: entity_id,
        label,
        allowedActions,
        sortOrder: sort_order,
      })
    }

    return result
  }

  entityIds(portalId: string): string[] {
    const rows = this.db
      .prepare('SELECT entity_id FROM exposed_device WHERE portal_id = ? ORDER BY sort_order, entity_id')
      .all(portalId)

    const result: string[] = []

    for (const row of rows) {
      const parsed = EntityIdRowSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }
      result.push(parsed.data.entity_id)
    }

    return result
  }

  asMap(portalId: string): Map<string, readonly string[]> {
    const rows = this.list(portalId)
    const map = new Map<string, readonly string[]>()

    for (const row of rows) {
      map.set(row.entityId, row.allowedActions)
    }

    return map
  }

  replace(portalId: string, rows: AllowlistRow[]): void {
    try {
      this.db.exec('BEGIN')

      this.db.prepare('DELETE FROM exposed_device WHERE portal_id = ?').run(portalId)

      const insert = this.db.prepare(
        'INSERT INTO exposed_device (portal_id, entity_id, label, allowed_actions, sort_order) VALUES (?, ?, ?, ?, ?)',
      )

      for (const row of rows) {
        insert.run(portalId, row.entityId, row.label, JSON.stringify(row.allowedActions), row.sortOrder)
      }

      this.db.exec('COMMIT')

      // Fire listeners only after successful commit
      const entityIds = rows.map((r) => r.entityId)
      this.notifyListeners(portalId, entityIds)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  onChange(fn: AllowlistChangeListener): () => void {
    this.listeners.add(fn)

    // Return unsubscribe function that's idempotent
    let unsubscribed = false
    return () => {
      if (!unsubscribed) {
        this.listeners.delete(fn)
        unsubscribed = true
      }
    }
  }

  private notifyListeners(portalId: string, entityIds: string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(portalId, entityIds)
      } catch {
        // Swallow errors to prevent one listener from breaking others
      }
    }
  }
}
