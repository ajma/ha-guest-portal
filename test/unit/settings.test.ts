import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'

describe('SettingsStore', () => {
  let db: DatabaseSync
  let settings: SettingsStore

  beforeEach(() => {
    db = openDb(':memory:')
    settings = new SettingsStore(db)
  })

  it('defaults to enabled', () => {
    expect(settings.getPortalEnabled()).toBe(true)
  })

  it('persists a disabled flag across store instances', () => {
    settings.setPortalEnabled(false)
    expect(new SettingsStore(db).getPortalEnabled()).toBe(false)
  })

  it('notifies listeners on change', () => {
    const listener = vi.fn()
    settings.onPortalEnabledChange(listener)

    settings.setPortalEnabled(false)

    expect(listener).toHaveBeenCalledWith(false)
  })

  it('does not notify listeners when the value is unchanged', () => {
    const listener = vi.fn()
    settings.onPortalEnabledChange(listener)

    settings.setPortalEnabled(true)

    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = settings.onPortalEnabledChange(listener)
    unsubscribe()

    settings.setPortalEnabled(false)

    expect(listener).not.toHaveBeenCalled()
  })

  it('generates a stable integration token', () => {
    const token = settings.getIntegrationToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(settings.getIntegrationToken()).toBe(token)
    expect(new SettingsStore(db).getIntegrationToken()).toBe(token)
  })

  it('generates a stable portal id', () => {
    const id = settings.getPortalId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new SettingsStore(db).getPortalId()).toBe(id)
  })

  it('generates a different token for a different database', () => {
    const other = new SettingsStore(openDb(':memory:'))
    expect(other.getIntegrationToken()).not.toBe(settings.getIntegrationToken())
  })

  it('defaults the theme to classic', () => {
    expect(settings.getTheme()).toBe('classic')
  })

  it('persists a theme across store instances', () => {
    settings.setTheme('tiles')
    expect(new SettingsStore(db).getTheme()).toBe('tiles')
  })

  it('reads an unrecognised stored theme back as classic', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('portal_theme', 'bogus')").run()
    expect(settings.getTheme()).toBe('classic')
  })
})
