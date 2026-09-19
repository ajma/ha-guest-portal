// src/server/store/settings.ts
import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export type PortalEnabledListener = (enabled: boolean) => void

const KEY_PORTAL_ENABLED = 'portal_enabled'
const KEY_INTEGRATION_TOKEN = 'integration_token'
const KEY_PORTAL_ID = 'portal_id'

const SettingRowSchema = z.object({
  value: z.string(),
})

export class SettingsStore {
  private db: DatabaseSync
  private listeners: Set<PortalEnabledListener> = new Set()

  constructor(db: DatabaseSync) {
    this.db = db
  }

  private read(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    if (row === undefined) return null

    const parsed = SettingRowSchema.safeParse(row)
    return parsed.success ? parsed.data.value : null
  }

  private write(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  /**
   * Read a value, generating and persisting one on first access.
   * Used for the integration token and portal id, which must be stable
   * for the life of the database but are never configured by hand.
   */
  private readOrCreate(key: string, generate: () => string): string {
    const existing = this.read(key)
    if (existing !== null) return existing

    const created = generate()
    this.write(key, created)
    return created
  }

  getPortalEnabled(): boolean {
    // Absent means enabled: an existing installation that upgrades into this
    // feature must not have its guest portal silently switched off.
    return this.read(KEY_PORTAL_ENABLED) !== '0'
  }

  setPortalEnabled(enabled: boolean): void {
    if (this.getPortalEnabled() === enabled) return

    this.write(KEY_PORTAL_ENABLED, enabled ? '1' : '0')

    for (const listener of this.listeners) {
      listener(enabled)
    }
  }

  onPortalEnabledChange(fn: PortalEnabledListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getIntegrationToken(): string {
    return this.readOrCreate(KEY_INTEGRATION_TOKEN, () => randomBytes(32).toString('hex'))
  }

  getPortalId(): string {
    return this.readOrCreate(KEY_PORTAL_ID, () => randomUUID())
  }
}
