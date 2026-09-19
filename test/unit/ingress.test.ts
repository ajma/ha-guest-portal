import { describe, expect, it } from 'vitest'
import { isFromSupervisor } from '../../src/server/runtime.ts'

describe('Ingress support', () => {
  describe('isFromSupervisor', () => {
    it('returns true for exact Supervisor address', () => {
      expect(isFromSupervisor('172.30.32.2')).toBe(true)
    })

    it('returns true for IPv6-mapped Supervisor address', () => {
      expect(isFromSupervisor('::ffff:172.30.32.2')).toBe(true)
    })

    it('returns false for localhost', () => {
      expect(isFromSupervisor('127.0.0.1')).toBe(false)
      expect(isFromSupervisor('::1')).toBe(false)
    })

    it('returns false for LAN addresses', () => {
      expect(isFromSupervisor('192.168.1.100')).toBe(false)
      expect(isFromSupervisor('10.0.0.1')).toBe(false)
      expect(isFromSupervisor('172.16.0.1')).toBe(false)
    })

    it('returns false for undefined', () => {
      expect(isFromSupervisor(undefined)).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isFromSupervisor('')).toBe(false)
    })
  })
})
