import { describe, expect, it } from 'vitest'
import {
  assertAdminAccessPossible,
  assertNoAdminPasswordCollision,
  loadConfig,
} from '../../src/server/config.ts'

const valid = {
  HA_BASE_URL: 'http://192.168.1.100:8123',
  HA_TOKEN: 'tok',
}

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const c = loadConfig({ ...valid })
    expect(c.port).toBe(9123)
    expect(c.dbPath).toBe('/data/portal.db')
    expect(c.trustProxy).toBeUndefined()
    expect(c.ingressPort).toBeUndefined()
  })

  it('accepts INGRESS_PORT when provided', () => {
    const c = loadConfig({ ...valid, INGRESS_PORT: '8099' })
    expect(c.ingressPort).toBe(8099)
  })

  it('strips a trailing slash from HA_BASE_URL', () => {
    expect(loadConfig({ ...valid, HA_BASE_URL: 'http://192.168.1.100:8123/' }).haBaseUrl).toBe(
      'http://192.168.1.100:8123',
    )
  })

  it.each(['HA_BASE_URL', 'HA_TOKEN'])(
    'throws when %s is missing',
    (key) => {
      const env: Record<string, string> = { ...valid }
      delete env[key]
      expect(() => loadConfig(env)).toThrow()
    },
  )

  it('loads with no ADMIN_PASSWORD set', () => {
    const cfg = loadConfig({
      HA_BASE_URL: 'http://192.168.1.10:8123',
      HA_TOKEN: 'token',
    } as NodeJS.ProcessEnv)
    expect(cfg.adminPassword).toBeUndefined()
  })

  it('loads with ADMIN_PASSWORD set', () => {
    const cfg = loadConfig({
      HA_BASE_URL: 'http://192.168.1.10:8123',
      HA_TOKEN: 'token',
      ADMIN_PASSWORD: 'at-least-8-chars',
    } as NodeJS.ProcessEnv)
    expect(cfg.adminPassword).toBe('at-least-8-chars')
  })

  it('still rejects a too-short ADMIN_PASSWORD when one is supplied', () => {
    expect(() =>
      loadConfig({
        HA_BASE_URL: 'http://192.168.1.10:8123',
        HA_TOKEN: 'token',
        ADMIN_PASSWORD: 'short',
      } as NodeJS.ProcessEnv),
    ).toThrow()
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...valid, PORT: 'abc' })).toThrow()
  })

  it('does not leak password values in error messages', () => {
    // Without this the test passes when loadConfig stops throwing at all, and
    // the catch block — the only place it asserts anything — never runs.
    expect.assertions(1)
    const secretPassword = 'short'
    try {
      loadConfig({ ...valid, ADMIN_PASSWORD: secretPassword })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain(secretPassword)
    }
  })
})

describe('assertAdminAccessPossible', () => {
  it('throws when neither ingress nor an admin password can reach admin', () => {
    const cfg = loadConfig({ ...valid })
    expect(() => assertAdminAccessPossible(cfg)).toThrow(/ADMIN_PASSWORD/)
  })

  it('accepts ingress alone', () => {
    const cfg = loadConfig({ ...valid, INGRESS_PORT: '8099' })
    expect(() => assertAdminAccessPossible(cfg)).not.toThrow()
  })

  it('accepts an admin password alone', () => {
    const cfg = loadConfig({ ...valid, ADMIN_PASSWORD: 'at-least-8-chars' })
    expect(() => assertAdminAccessPossible(cfg)).not.toThrow()
  })

  it('accepts both together', () => {
    const cfg = loadConfig({
      ...valid,
      INGRESS_PORT: '8099',
      ADMIN_PASSWORD: 'at-least-8-chars',
    })
    expect(() => assertAdminAccessPossible(cfg)).not.toThrow()
  })
})

describe('assertNoAdminPasswordCollision', () => {
  const cfgWith = (adminPassword?: string) =>
    loadConfig(adminPassword === undefined ? { ...valid } : { ...valid, ADMIN_PASSWORD: adminPassword })

  it('refuses to start when a portal password is also the admin password', () => {
    // classify() tries the admin password first, so this portal's guests would
    // be handed an admin session over every portal in the deployment.
    const cfg = cfgWith('shared-secret-1')
    const portals = [
      { id: 'p1', title: 'Timothy', password: 'timothy-secret-1' },
      { id: 'p2', title: 'Mary', password: 'shared-secret-1' },
    ]

    expect(() => assertNoAdminPasswordCollision(cfg, portals)).toThrow(/Mary/)
  })

  it('does not put the colliding password in the error message', () => {
    expect.assertions(1)
    const cfg = cfgWith('shared-secret-1')
    try {
      assertNoAdminPasswordCollision(cfg, [{ id: 'p1', title: 'Mary', password: 'shared-secret-1' }])
    } catch (err) {
      expect(err instanceof Error ? err.message : String(err)).not.toContain('shared-secret-1')
    }
  })

  it('names every colliding portal, not just the first', () => {
    const cfg = cfgWith('shared-secret-1')
    const portals = [
      { id: 'p1', title: 'Timothy', password: 'shared-secret-1' },
      { id: 'p2', title: 'Mary', password: 'shared-secret-1' },
    ]

    expect(() => assertNoAdminPasswordCollision(cfg, portals)).toThrow(/Timothy.*Mary/)
  })

  it('accepts portals whose passwords all differ from the admin password', () => {
    const cfg = cfgWith('admin-secret-1')
    const portals = [{ id: 'p1', title: 'Timothy', password: 'timothy-secret-1' }]

    expect(() => assertNoAdminPasswordCollision(cfg, portals)).not.toThrow()
  })

  it('accepts a deployment with no admin password at all', () => {
    const cfg = cfgWith()
    const portals = [{ id: 'p1', title: 'Timothy', password: 'timothy-secret-1' }]

    expect(() => assertNoAdminPasswordCollision(cfg, portals)).not.toThrow()
  })
})
