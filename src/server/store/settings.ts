import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const KEY_INTEGRATION_TOKEN = 'integration_token'
const KEY_DEPLOYMENT_ID = 'deployment_id'
const KEY_LAST_SELECTED_PORTAL_ID = 'last_selected_portal_id'

const SettingRowSchema = z.object({
  value: z.string(),
})

export class SettingsStore {
  private db: DatabaseSync

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
   * Used for the integration token and deployment id, which must be stable
   * for the life of the database but are never configured by hand.
   */
  private readOrCreate(key: string, generate: () => string): string {
    const existing = this.read(key)
    if (existing !== null) return existing

    const created = generate()
    this.write(key, created)
    return created
  }

  getIntegrationToken(): string {
    return this.readOrCreate(KEY_INTEGRATION_TOKEN, () => randomBytes(32).toString('hex'))
  }

  /**
   * Identifies this *deployment* for Supervisor discovery and the HA device
   * registry — distinct from any individual portal's own id (`Portal.id`).
   */
  getDeploymentId(): string {
    return this.readOrCreate(KEY_DEPLOYMENT_ID, () => randomUUID())
  }

  getLastSelectedPortalId(): string | null {
    return this.read(KEY_LAST_SELECTED_PORTAL_ID)
  }

  setLastSelectedPortalId(id: string): void {
    this.write(KEY_LAST_SELECTED_PORTAL_ID, id)
  }
}
