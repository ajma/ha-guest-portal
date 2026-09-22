import { describe, expect, it } from 'vitest'
import { assertAdminAccessPossible, loadConfig } from '../../src/server/config.ts'

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
