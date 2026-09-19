import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'
import type { Role } from '../../shared/api.js'

export const SESSION_COOKIE = 'hagp_session'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000

type SessionData = {
  role: Role
  expiresAt: number
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>()
  private readonly ttlMs: number
  private readonly now: () => number
  private lastSweep: number

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? THIRTY_DAYS_MS
    this.now = opts?.now ?? (() => Date.now())
    this.lastSweep = this.now()
  }

  get size(): number {
    return this.sessions.size
  }

  create(role: Role): string {
    this.sweepIfNeeded()
    const id = randomBytes(32).toString('base64url')
    this.sessions.set(id, {
      role,
      expiresAt: this.now() + this.ttlMs,
    })
    return id
  }

  get(id: string): Role | undefined {
    this.sweepIfNeeded()
    const session = this.sessions.get(id)
    if (!session) return undefined

    if (this.now() > session.expiresAt) {
      this.sessions.delete(id)
      return undefined
    }

    // Refresh expiry (sliding window)
    session.expiresAt = this.now() + this.ttlMs
    return session.role
  }

  destroy(id: string): void {
    this.sessions.delete(id)
  }

  sweep(): void {
    const now = this.now()
    for (const [id, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(id)
      }
    }
    this.lastSweep = now
  }

  private sweepIfNeeded(): void {
    const now = this.now()
    // Sweep if it's been at least one TTL since last sweep
    if (now - this.lastSweep >= this.ttlMs) {
      this.sweep()
    }
  }
}

export function verifyPassword(supplied: string, expected: string): boolean {
  // Hash both sides to ensure constant length for timingSafeEqual
  const suppliedHash = createHash('sha256').update(supplied, 'utf8').digest()
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest()

  try {
    return timingSafeEqual(suppliedHash, expectedHash)
  } catch {
    // timingSafeEqual throws if buffers have different lengths,
    // but we've hashed both so they're always 32 bytes
    return false
  }
}

export function classify(supplied: string, cfg: Config): Role | null {
  // Check both passwords unconditionally to avoid timing leaks
  const isAdmin = verifyPassword(supplied, cfg.adminPassword)
  const isGuest = verifyPassword(supplied, cfg.guestPassword)

  if (isAdmin) return 'admin'
  if (isGuest) return 'guest'
  return null
}

type IpRecord = {
  count: number
  windowStart: number
}

export class LoginRateLimiter {
  private readonly perIpFailures = new Map<string, IpRecord>()
  private globalFailures = 0
  private globalWindowStart: number
  private lastSweep: number

  private readonly perIpMax: number
  private readonly globalMax: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(opts?: {
    perIpMax?: number
    globalMax?: number
    windowMs?: number
    now?: () => number
  }) {
    this.perIpMax = opts?.perIpMax ?? 10
    this.globalMax = opts?.globalMax ?? 60
    this.windowMs = opts?.windowMs ?? FIFTEEN_MINUTES_MS
    this.now = opts?.now ?? (() => Date.now())
    this.globalWindowStart = this.now()
    this.lastSweep = this.now()
  }

  get size(): number {
    return this.perIpFailures.size
  }

  check(ip: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    this.sweepIfNeeded()
    const now = this.now()

    // Check global ceiling
    if (now - this.globalWindowStart < this.windowMs) {
      if (this.globalFailures >= this.globalMax) {
        const retryAfterMs = this.windowMs - (now - this.globalWindowStart)
        return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) }
      }
    } else {
      // Window expired, reset global counter
      this.globalFailures = 0
      this.globalWindowStart = now
    }

    // Check per-IP limit
    const record = this.perIpFailures.get(ip)
    if (record) {
      if (now - record.windowStart < this.windowMs) {
        if (record.count >= this.perIpMax) {
          const retryAfterMs = this.windowMs - (now - record.windowStart)
          return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) }
        }
      } else {
        // Window expired, reset counter
        this.perIpFailures.delete(ip)
      }
    }

    return { allowed: true }
  }

  recordFailure(ip: string): void {
    this.sweepIfNeeded()
    const now = this.now()

    // Update global counter
    if (now - this.globalWindowStart >= this.windowMs) {
      this.globalFailures = 0
      this.globalWindowStart = now
    }
    this.globalFailures++

    // Update per-IP counter
    const record = this.perIpFailures.get(ip)
    if (record && now - record.windowStart < this.windowMs) {
      record.count++
    } else {
      this.perIpFailures.set(ip, { count: 1, windowStart: now })
    }
  }

  recordSuccess(ip: string): void {
    this.perIpFailures.delete(ip)
  }

  private sweepIfNeeded(): void {
    const now = this.now()
    // Sweep if it's been at least one window since last sweep
    if (now - this.lastSweep >= this.windowMs) {
      this.sweep()
    }
  }

  private sweep(): void {
    const now = this.now()
    for (const [ip, record] of this.perIpFailures.entries()) {
      if (now - record.windowStart >= this.windowMs) {
        this.perIpFailures.delete(ip)
      }
    }
    this.lastSweep = now
  }
}

export function clientIp(
  rawSocketIp: string,
  forwardedFor: string | undefined,
  trustProxy: string | undefined,
): string {
  // Only trust X-Forwarded-For if trustProxy is configured
  if (!trustProxy || !forwardedFor) {
    return rawSocketIp
  }

  // Parse X-Forwarded-For header and take the RIGHTMOST entry
  // Format: "client, proxy1, proxy2"
  // Each proxy appends to the right. The rightmost IP is what our trusted
  // proxy saw (the real peer). The leftmost is what the client claimed
  // (attacker-controlled). This assumes exactly one trusted proxy hop,
  // which is correct for this application (at most one reverse proxy on LAN).
  const ips = forwardedFor
    .split(',')
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0)

  if (ips.length === 0) {
    return rawSocketIp
  }

  return ips[ips.length - 1] ?? rawSocketIp
}
