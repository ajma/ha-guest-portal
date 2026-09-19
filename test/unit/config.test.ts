import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/server/config.ts'

const valid = {
  HA_BASE_URL: 'http://192.168.1.100:8123',
  HA_TOKEN: 'tok',
  GUEST_PASSWORD: 'guest-pw',
  ADMIN_PASSWORD: 'admin-pw',
}

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const c = loadConfig({ ...valid })
    expect(c.port).toBe(8080)
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

  it.each(['HA_BASE_URL', 'HA_TOKEN', 'GUEST_PASSWORD', 'ADMIN_PASSWORD'])(
    'throws when %s is missing',
    (key) => {
      const env: Record<string, string> = { ...valid }
      delete env[key]
      expect(() => loadConfig(env)).toThrow()
    },
  )

  it('rejects identical guest and admin passwords', () => {
    expect(() => loadConfig({ ...valid, ADMIN_PASSWORD: 'guest-pw' })).toThrow(/must differ/i)
  })

  it('rejects a password shorter than 8 characters', () => {
    expect(() => loadConfig({ ...valid, GUEST_PASSWORD: 'short' })).toThrow()
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...valid, PORT: 'abc' })).toThrow()
  })

  it('does not leak password values in error messages', () => {
    const secretPassword = 'secret123'
    try {
      loadConfig({ ...valid, GUEST_PASSWORD: 'short', ADMIN_PASSWORD: secretPassword })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain(secretPassword)
      expect(msg).not.toContain('short')
    }
  })
})
