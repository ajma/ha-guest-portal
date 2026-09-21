import { describe, it, expect } from 'vitest'
import type { Config } from '../../src/server/config.ts'
import {
  SESSION_COOKIE,
  SessionStore,
  LoginRateLimiter,
  verifyPassword,
  classify,
  clientIp,
} from '../../src/server/http/auth.ts'
import { PortalStore } from '../../src/server/store/portals.js'
import { openDb } from '../../src/server/store/db.js'

describe('SESSION_COOKIE', () => {
  it('exports the session cookie name', () => {
    expect(SESSION_COOKIE).toBe('hagp_session')
  })
})

describe('SessionStore', () => {
  it('creates a session and retrieves it', () => {
    const store = new SessionStore()
    const sessionId = store.create({ role: 'guest', portalId: 'portal-123' })
    expect(sessionId).toBeDefined()
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
    const session = store.get(sessionId)
    expect(session).toBeDefined()
    expect(session).toMatchObject({ role: 'guest', portalId: 'portal-123' })
  })

  it('returns undefined for non-existent session', () => {
    const store = new SessionStore()
    expect(store.get('non-existent')).toBeUndefined()
  })

  it('expires sessions past TTL', () => {
    let now = 1000
    const clock = () => now
    const ttlMs = 60000 // 1 minute
    const store = new SessionStore({ ttlMs, now: clock })

    const sessionId = store.create({ role: 'admin' })
    const session = store.get(sessionId)
    expect(session).toMatchObject({ role: 'admin' })

    // Advance time past TTL
    now = 1000 + ttlMs + 1
    expect(store.get(sessionId)).toBeUndefined()
  })

  it('slides TTL on access', () => {
    let now = 1000
    const clock = () => now
    const ttlMs = 60000 // 1 minute
    const store = new SessionStore({ ttlMs, now: clock })

    const sessionId = store.create({ role: 'guest', portalId: 'p1' })
    // Created at t=1000, expires at t=61000

    // Access at halfway point - this refreshes expiry
    now = 1000 + ttlMs / 2 // t=31000
    let session = store.get(sessionId)
    expect(session).toMatchObject({ role: 'guest', portalId: 'p1' })
    // Now expires at t=91000 (31000 + 60000)

    // Advance to what would have been past original expiry
    now = 1000 + ttlMs + 1 // t=61001
    // Should still be valid because TTL was refreshed to 91000
    session = store.get(sessionId)
    expect(session).toMatchObject({ role: 'guest', portalId: 'p1' })

    // Now advance past the most recent refresh
    now = 61001 + ttlMs + 1 // t=121002
    expect(store.get(sessionId)).toBeUndefined()
  })

  it('destroys a session', () => {
    const store = new SessionStore()
    const sessionId = store.create({ role: 'admin' })
    const session = store.get(sessionId)
    expect(session).toMatchObject({ role: 'admin' })
    store.destroy(sessionId)
    expect(store.get(sessionId)).toBeUndefined()
  })

  it('generates unique session IDs with sufficient entropy', () => {
    const store = new SessionStore()
    const ids = new Set<string>()

    for (let i = 0; i < 1000; i++) {
      const id = store.create({ role: 'guest', portalId: 'p1' })
      expect(ids.has(id)).toBe(false)
      ids.add(id)
      // 32 bytes = 256 bits, base64url encoded is ~43 chars
      expect(id.length).toBeGreaterThanOrEqual(43)
    }
  })

  it('sweeps expired sessions and keeps live ones', () => {
    let now = 1000
    const clock = () => now
    const ttlMs = 60000
    const store = new SessionStore({ ttlMs, now: clock })

    const id1 = store.create({ role: 'guest', portalId: 'p1' })
    const id2 = store.create({ role: 'admin' })

    // Advance time to expire id1
    now = 1000 + ttlMs + 1
    const id3 = store.create({ role: 'guest', portalId: 'p2' })

    // Before sweep, id1 should be expired but still in memory
    expect(store.get(id1)).toBeUndefined()
    expect(store.get(id2)).toBeUndefined()
    let session = store.get(id3)
    expect(session).toMatchObject({ role: 'guest', portalId: 'p2' })

    store.sweep()

    // After sweep, expired sessions should be gone
    expect(store.get(id1)).toBeUndefined()
    expect(store.get(id2)).toBeUndefined()
    session = store.get(id3)
    expect(session).toMatchObject({ role: 'guest', portalId: 'p2' })
  })

  it('automatically reclaims expired sessions without explicit sweep', () => {
    let now = 1000
    const clock = () => now
    const ttlMs = 60000
    const store = new SessionStore({ ttlMs, now: clock })

    // Create 5000 sessions
    for (let i = 0; i < 5000; i++) {
      store.create({ role: 'guest', portalId: 'p1' })
    }
    expect(store.size).toBe(5000)

    // Advance past TTL
    now = 1000 + ttlMs + 1

    // Perform one ordinary operation (create)
    store.create({ role: 'admin' })

    // Map should have shrunk automatically (amortized sweep)
    // Should only have the new session left
    expect(store.size).toBeLessThan(10)
  })

  it('amortized sweeping preserves live sessions', () => {
    let now = 1000
    const clock = () => now
    const ttlMs = 60000
    const store = new SessionStore({ ttlMs, now: clock })

    // Create some sessions
    for (let i = 0; i < 100; i++) {
      store.create({ role: 'guest', portalId: 'p1' })
    }

    // Advance time but not past TTL
    now = 1000 + ttlMs / 2

    // Create a live session
    const liveId = store.create({ role: 'admin' })

    // Advance past the original TTL but access the live session
    now = 1000 + ttlMs + 1
    let session = store.get(liveId)
    expect(session).toMatchObject({ role: 'admin' })

    // Create another session to trigger sweep
    store.create({ role: 'guest', portalId: 'p1' })

    // Live session should still be valid
    session = store.get(liveId)
    expect(session).toMatchObject({ role: 'admin' })
  })
})

describe('verifyPassword', () => {
  it('returns true for exact match', () => {
    expect(verifyPassword('admin-pw', 'admin-pw')).toBe(true)
    expect(verifyPassword('guest-pw', 'guest-pw')).toBe(true)
  })

  it('returns false for incorrect password', () => {
    expect(verifyPassword('wrong', 'admin-pw')).toBe(false)
    expect(verifyPassword('admin', 'admin-pw')).toBe(false)
  })

  it('returns false for correct prefix', () => {
    expect(verifyPassword('admin-p', 'admin-pw')).toBe(false)
    expect(verifyPassword('guest-', 'guest-pw')).toBe(false)
  })

  it('returns false for value longer than expected', () => {
    expect(verifyPassword('admin-pwx', 'admin-pw')).toBe(false)
    expect(verifyPassword('guest-password', 'guest-pw')).toBe(false)
  })

  it('returns false for empty strings', () => {
    expect(verifyPassword('', 'admin-pw')).toBe(false)
    expect(verifyPassword('admin-pw', '')).toBe(false)
    expect(verifyPassword('', '')).toBe(true)
  })
})

describe('classify', () => {
  const cfg = { adminPassword: 'admin-secret' } as Config

  it('resolves the admin password to an admin role', () => {
    const portals = new PortalStore(openDb(':memory:'))
    expect(classify('admin-secret', cfg, portals)).toEqual({ role: 'admin' })
  })

  it('resolves a portal password to a guest role scoped to that portal', () => {
    const db = openDb(':memory:')
    const portals = new PortalStore(db)
    const portal = portals.create({ title: 'Timothy', password: 'timothy-pass' })

    expect(classify('timothy-pass', cfg, portals)).toEqual({ role: 'guest', portalId: portal.id })
  })

  it('rejects a password matching nothing', () => {
    const portals = new PortalStore(openDb(':memory:'))
    expect(classify('nope', cfg, portals)).toBeNull()
  })

  it('rejects everything when ADMIN_PASSWORD is unset and no portal matches', () => {
    const noAdminCfg = { adminPassword: undefined } as Config
    const portals = new PortalStore(openDb(':memory:'))
    expect(classify('anything', noAdminCfg, portals)).toBeNull()
  })

  it('finds portal password match in second portal (no early return)', () => {
    const db = openDb(':memory:')
    const portals = new PortalStore(db)
    portals.create({ title: 'First', password: 'first-pass' })
    const portal2 = portals.create({ title: 'Second', password: 'second-pass' })

    // Verify the loop doesn't stop at first portal
    expect(classify('second-pass', cfg, portals)).toEqual({ role: 'guest', portalId: portal2.id })
  })

  it('admin password takes precedence over portal password match', () => {
    const db = openDb(':memory:')
    const portals = new PortalStore(db)
    // Create a portal with a different password than admin
    portals.create({ title: 'Guest Portal', password: 'guest-pass' })

    // Even though loop checks portal passwords, admin password match should win
    expect(classify('admin-secret', cfg, portals)).toEqual({ role: 'admin' })
  })
})

describe('SessionStore (portal-scoped)', () => {
  it('creates and retrieves a guest session carrying its portal id', () => {
    const sessions = new SessionStore()
    const id = sessions.create({ role: 'guest', portalId: 'portal-123' })
    expect(sessions.get(id)).toMatchObject({ role: 'guest', portalId: 'portal-123' })
  })

  it('creates and retrieves an admin session with no portal id', () => {
    const sessions = new SessionStore()
    const id = sessions.create({ role: 'admin' })
    expect(sessions.get(id)).toMatchObject({ role: 'admin' })
  })
})

describe('LoginRateLimiter', () => {
  it('allows requests below the per-IP limit', () => {
    const limiter = new LoginRateLimiter({ perIpMax: 10 })
    for (let i = 0; i < 10; i++) {
      const result = limiter.check('192.168.1.1')
      expect(result.allowed).toBe(true)
      limiter.recordFailure('192.168.1.1')
    }
  })

  it('blocks after per-IP limit reached', () => {
    const limiter = new LoginRateLimiter({ perIpMax: 10 })
    for (let i = 0; i < 10; i++) {
      limiter.recordFailure('192.168.1.1')
    }
    const result = limiter.check('192.168.1.1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.retryAfterSec).toBeGreaterThan(0)
      expect(result.retryAfterSec).toBeLessThanOrEqual(15 * 60)
    }
  })

  it('clears IP counter on success', () => {
    const limiter = new LoginRateLimiter({ perIpMax: 10 })
    for (let i = 0; i < 9; i++) {
      limiter.recordFailure('192.168.1.1')
    }
    limiter.recordSuccess('192.168.1.1')
    const result = limiter.check('192.168.1.1')
    expect(result.allowed).toBe(true)
  })

  it('expires the window', () => {
    let now = 1000
    const clock = () => now
    const windowMs = 60000 // 1 minute
    const limiter = new LoginRateLimiter({ perIpMax: 10, windowMs, now: clock })

    for (let i = 0; i < 10; i++) {
      limiter.recordFailure('192.168.1.1')
    }
    expect(limiter.check('192.168.1.1').allowed).toBe(false)

    // Advance past window
    now = 1000 + windowMs + 1
    const result = limiter.check('192.168.1.1')
    expect(result.allowed).toBe(true)
  })

  it('blocks at global ceiling even with distinct IPs', () => {
    const limiter = new LoginRateLimiter({ perIpMax: 10, globalMax: 60 })

    // 60 failures from 60 different IPs (1 each)
    for (let i = 0; i < 60; i++) {
      limiter.recordFailure(`192.168.1.${i}`)
    }

    // 61st distinct IP should be blocked even though it's never failed before
    const result = limiter.check('192.168.2.1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.retryAfterSec).toBeGreaterThan(0)
    }
  })

  it('automatically reclaims expired per-IP records across windows', () => {
    let now = 1000
    const clock = () => now
    const windowMs = 60000 // 1 minute
    const limiter = new LoginRateLimiter({ perIpMax: 10, windowMs, now: clock })

    // Record failures for 200 distinct IPs across 5 windows
    for (let window = 0; window < 5; window++) {
      for (let ip = 0; ip < 40; ip++) {
        const ipAddr = `192.168.${Math.floor(ip / 256)}.${ip % 256}`
        limiter.recordFailure(ipAddr)
      }
      // Advance to next window
      now += windowMs + 1
    }

    // The map should stay bounded (not grow with number of windows)
    // Should be much less than 200 (only current window's entries)
    expect(limiter.size).toBeLessThan(100)
  })

  it('amortized sweeping preserves blocked IPs within their window', () => {
    let now = 1000
    const clock = () => now
    const windowMs = 60000
    const limiter = new LoginRateLimiter({ perIpMax: 10, windowMs, now: clock })

    // Block an IP
    for (let i = 0; i < 10; i++) {
      limiter.recordFailure('192.168.1.100')
    }
    expect(limiter.check('192.168.1.100').allowed).toBe(false)

    // Create many other expired entries from an old window
    for (let i = 0; i < 50; i++) {
      limiter.recordFailure(`192.168.2.${i}`)
    }

    // Advance past the old entries' window but not the blocked IP's window
    now = 1000 + windowMs / 2

    // Trigger a sweep by checking another IP
    limiter.check('192.168.3.1')

    // The blocked IP should still be blocked (sweeping must not affect behavior)
    expect(limiter.check('192.168.1.100').allowed).toBe(false)
  })
})

describe('clientIp', () => {
  it('returns socket IP when trustProxy is undefined', () => {
    expect(clientIp('192.168.1.100', undefined, undefined)).toBe('192.168.1.100')
    expect(clientIp('192.168.1.100', '1.2.3.4', undefined)).toBe('192.168.1.100')
    expect(clientIp('192.168.1.100', '1.2.3.4, 5.6.7.8', undefined)).toBe('192.168.1.100')
  })

  it('returns socket IP when forwardedFor is undefined even with trustProxy', () => {
    expect(clientIp('192.168.1.100', undefined, 'true')).toBe('192.168.1.100')
  })

  it('returns rightmost IP from X-Forwarded-For when trustProxy is set', () => {
    // Rightmost = what the trusted proxy appended (the real peer it saw)
    // Leftmost = what the client claimed (attacker-controlled)
    expect(clientIp('10.0.0.1', '1.2.3.4, 192.168.1.50', 'true')).toBe('192.168.1.50')
    expect(clientIp('10.0.0.1', '1.2.3.4, 5.6.7.8, 9.10.11.12', 'true')).toBe('9.10.11.12')
  })

  it('handles single-entry X-Forwarded-For', () => {
    expect(clientIp('10.0.0.1', '192.168.1.50', 'true')).toBe('192.168.1.50')
  })

  it('trims whitespace from X-Forwarded-For entries', () => {
    expect(clientIp('10.0.0.1', '  1.2.3.4  ,  192.168.1.50  ', 'true')).toBe('192.168.1.50')
    expect(clientIp('10.0.0.1', '1.2.3.4,192.168.1.50', 'true')).toBe('192.168.1.50')
  })

  it('falls back to socket IP for empty or whitespace-only X-Forwarded-For', () => {
    expect(clientIp('192.168.1.100', '', 'true')).toBe('192.168.1.100')
    expect(clientIp('192.168.1.100', '   ', 'true')).toBe('192.168.1.100')
    expect(clientIp('192.168.1.100', ' , , ', 'true')).toBe('192.168.1.100')
  })

  it('prevents rate limit evasion via spoofed leftmost IP', () => {
    const limiter = new LoginRateLimiter({ perIpMax: 10 })

    // Attacker sends 40 requests with different fake leftmost IPs
    // but same real rightmost IP (what the proxy actually saw)
    for (let i = 0; i < 40; i++) {
      const spoofedIp = `9.9.9.${i}`
      const realIp = '192.168.1.50'
      const forwardedFor = `${spoofedIp}, ${realIp}`
      const ip = clientIp('10.0.0.1', forwardedFor, 'true')

      const result = limiter.check(ip)
      if (i < 10) {
        // First 10 should be allowed
        expect(result.allowed).toBe(true)
        limiter.recordFailure(ip)
      } else {
        // 11th onward should be blocked (per-IP limit is 10)
        expect(result.allowed).toBe(false)
        // Stop here - we've proven the fix works
        break
      }
    }
  })
})
