// test/unit/devices.test.ts
import { describe, expect, it } from 'vitest'
import { DOMAIN_ACTIONS, isSupportedEntity, parseDomain, validateAction } from '../../src/shared/devices.ts'

const allow = (m: Record<string, string[]>) => new Map(Object.entries(m))

describe('parseDomain', () => {
  it('extracts a supported domain', () => expect(parseDomain('light.porch')).toBe('light'))
  it('returns null for an unsupported domain', () => expect(parseDomain('climate.hall')).toBeNull())
  it('returns null for a malformed id', () => expect(parseDomain('nodot')).toBeNull())
  it('returns null for an empty object id', () => expect(parseDomain('light.')).toBeNull())
})

describe('validateAction — exhaustive domain x action matrix', () => {
  const allDomains = Object.keys(DOMAIN_ACTIONS) as (keyof typeof DOMAIN_ACTIONS)[]
  const allActions = [...new Set(allDomains.flatMap((d) => [...DOMAIN_ACTIONS[d]]))]

  for (const domain of allDomains) {
    for (const action of allActions) {
      const entityId = `${domain}.thing`
      const legal = (DOMAIN_ACTIONS[domain] as readonly string[]).includes(action)
      it(`${legal ? 'permits' : 'rejects'} ${action} on ${domain}`, () => {
        const r = validateAction(entityId, action, allow({ [entityId]: allActions }))
        expect(r.ok).toBe(legal)
        if (!r.ok && !legal) expect(r.reason).toBe('action_not_valid_for_domain')
      })
    }
  }
})

describe('validateAction — gates', () => {
  it('rejects an entity absent from the allowlist', () => {
    const r = validateAction('light.porch', 'turn_on', allow({ 'light.other': ['turn_on'] }))
    expect(r).toEqual({ ok: false, reason: 'not_allowlisted' })
  })

  it('rejects an unsupported domain even when allowlisted', () => {
    const r = validateAction('climate.hall', 'turn_on', allow({ 'climate.hall': ['turn_on'] }))
    expect(r).toEqual({ ok: false, reason: 'unsupported_domain' })
  })

  it('rejects an action the row does not permit', () => {
    const r = validateAction('lock.front', 'lock', allow({ 'lock.front': ['unlock'] }))
    expect(r).toEqual({ ok: false, reason: 'action_not_permitted' })
  })

  it('permits unlock while lock is withheld', () => {
    expect(validateAction('lock.front', 'unlock', allow({ 'lock.front': ['unlock'] })))
      .toEqual({ ok: true, domain: 'lock', service: 'unlock' })
  })

  it('cannot aim a lock service at an entity exposed as a light', () => {
    const r = validateAction('light.porch', 'unlock', allow({ 'light.porch': ['unlock'] }))
    expect(r).toEqual({ ok: false, reason: 'action_not_valid_for_domain' })
  })

  it('rejects an entity id carrying a service separator', () => {
    const r = validateAction('light.porch/../lock/unlock', 'turn_on', allow({ 'light.porch/../lock/unlock': ['turn_on'] }))
    expect(r.ok).toBe(false)
  })
})

describe('validateAction — prototype pollution defense', () => {
  it('parseDomain rejects __proto__', () => {
    expect(parseDomain('__proto__.x')).toBeNull()
  })

  it('parseDomain rejects constructor', () => {
    expect(parseDomain('constructor.x')).toBeNull()
  })

  it('isSupportedEntity rejects constructor', () => {
    expect(isSupportedEntity('constructor.x')).toBe(false)
  })

  it('isSupportedEntity rejects __proto__', () => {
    expect(isSupportedEntity('__proto__.x')).toBe(false)
  })

  it('validateAction rejects __proto__ without throwing', () => {
    const r = validateAction('__proto__.x', 'turn_on', allow({ '__proto__.x': ['turn_on'] }))
    expect(r).toEqual({ ok: false, reason: 'unsupported_domain' })
  })

  it('validateAction rejects constructor without throwing', () => {
    const r = validateAction('constructor.x', 'turn_on', allow({ 'constructor.x': ['turn_on'] }))
    expect(r).toEqual({ ok: false, reason: 'unsupported_domain' })
  })

  it('parseDomain rejects all Object.prototype properties', () => {
    const prototypeKeys = [
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__defineGetter__',
      '__lookupGetter__',
    ]
    for (const key of prototypeKeys) {
      expect(parseDomain(`${key}.x`)).toBeNull()
    }
  })
})

describe('validateAction — edge cases that must deny cleanly', () => {
  const edgeCases = [
    'light.porch/../../lock/unlock',
    'light.porch/unlock',
    'lock.front\n',
    ' lock.front',
    'LIGHT.PORCH',
    'light.porch%2F..%2Flock',
    'light..porch',
    '.porch',
    'light.',
    'light.porch?x=1',
    'light.porch#f',
    'light.por ch',
  ]

  for (const entityId of edgeCases) {
    it(`denies cleanly for: ${JSON.stringify(entityId)}`, () => {
      const r = validateAction(entityId, 'turn_on', allow({ [entityId]: ['turn_on'] }))
      expect(r.ok).toBe(false)
    })
  }
})
