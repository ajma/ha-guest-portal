import { beforeEach, describe, expect, it } from 'vitest'
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

  it('generates a stable integration token', () => {
    const token = settings.getIntegrationToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(settings.getIntegrationToken()).toBe(token)
    expect(new SettingsStore(db).getIntegrationToken()).toBe(token)
  })

  it('renames the deployment id getter without changing its persistence behaviour', () => {
    const store = new SettingsStore(db)
    const first = store.getDeploymentId()
    const second = store.getDeploymentId()
    expect(first).toBe(second)
    expect(typeof first).toBe('string')
  })

  it('generates a different token for a different database', () => {
    const other = new SettingsStore(openDb(':memory:'))
    expect(other.getIntegrationToken()).not.toBe(settings.getIntegrationToken())
  })

  it('tracks the last-selected portal id', () => {
    const store = new SettingsStore(db)
    expect(store.getLastSelectedPortalId()).toBeNull()
    store.setLastSelectedPortalId('portal-a')
    expect(store.getLastSelectedPortalId()).toBe('portal-a')
    store.clearLastSelectedPortalId()
    expect(store.getLastSelectedPortalId()).toBeNull()
  })

  it('tolerates clearing a last-selected portal id that was never set', () => {
    const store = new SettingsStore(db)
    store.clearLastSelectedPortalId()
    expect(store.getLastSelectedPortalId()).toBeNull()
  })
})
