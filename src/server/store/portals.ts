import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from '../../shared/themes.js'
import { normalizePortalTitle } from '../../shared/portalTitle.js'

export class DuplicatePasswordError extends Error {
  constructor() {
    super('That password is already in use by another portal')
  }
}

export type Portal = {
  id: string
  title: string
  theme: ThemeId
  password: string
  enabled: boolean
  createdAt: number
}

const PortalRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  theme: z.string(),
  password: z.string(),
  enabled: z.number(),
  created_at: z.number(),
})

function rowToPortal(row: unknown): Portal | null {
  const parsed = PortalRowSchema.safeParse(row)
  if (!parsed.success) return null
  const { id, title, theme, password, enabled, created_at } = parsed.data
  return {
    id,
    title,
    theme: isThemeId(theme) ? theme : DEFAULT_THEME_ID,
    password,
    enabled: enabled === 1,
    createdAt: created_at,
  }
}

// SQLite's UNIQUE constraint on `portal.password` is the source of truth for
// portal-vs-portal collisions; this message is what node:sqlite raises for it.
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('UNIQUE constraint failed: portal.password')
  )
}

export class PortalStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  list(): Portal[] {
    const rows = this.db
      .prepare('SELECT id, title, theme, password, enabled, created_at FROM portal ORDER BY created_at')
      .all()
    return rows.map(rowToPortal).filter((p): p is Portal => p !== null)
  }

  get(id: string): Portal | null {
    const row = this.db
      .prepare('SELECT id, title, theme, password, enabled, created_at FROM portal WHERE id = ?')
      .get(id)
    return row === undefined ? null : rowToPortal(row)
  }

  findByPassword(password: string): Portal | null {
    const row = this.db
      .prepare('SELECT id, title, theme, password, enabled, created_at FROM portal WHERE password = ?')
      .get(password)
    return row === undefined ? null : rowToPortal(row)
  }

  create(input: { title: string; password: string }): Portal {
    const id = randomUUID()
    const createdAt = Date.now()
    const title = normalizePortalTitle(input.title)

    try {
      this.db
        .prepare(
          'INSERT INTO portal (id, title, theme, password, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
        )
        .run(id, title, DEFAULT_THEME_ID, input.password, createdAt)
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new DuplicatePasswordError()
      throw error
    }

    const created = this.get(id)
    if (created === null) throw new Error('Portal vanished immediately after creation')
    return created
  }

  update(
    id: string,
    patch: { title?: string; theme?: ThemeId; enabled?: boolean; password?: string },
  ): Portal {
    const current = this.get(id)
    if (current === null) throw new Error(`No portal with id ${id}`)

    const next = {
      title: patch.title !== undefined ? normalizePortalTitle(patch.title) : current.title,
      theme: patch.theme ?? current.theme,
      enabled: patch.enabled ?? current.enabled,
      password: patch.password ?? current.password,
    }

    try {
      this.db
        .prepare('UPDATE portal SET title = ?, theme = ?, enabled = ?, password = ? WHERE id = ?')
        .run(next.title, next.theme, next.enabled ? 1 : 0, next.password, id)
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new DuplicatePasswordError()
      throw error
    }

    const updated = this.get(id)
    if (updated === null) throw new Error(`Portal ${id} vanished during update`)
    return updated
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM portal WHERE id = ?').run(id)
  }
}
