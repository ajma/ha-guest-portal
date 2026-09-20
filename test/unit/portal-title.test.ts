import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PORTAL_TITLE,
  MAX_PORTAL_TITLE_LENGTH,
  normalizePortalTitle,
} from '../../src/shared/portalTitle.ts'

describe('normalizePortalTitle', () => {
  it('keeps an ordinary title unchanged', () => {
    expect(normalizePortalTitle('Beach House')).toBe('Beach House')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizePortalTitle('  Beach House  ')).toBe('Beach House')
  })

  it('falls back to the default when cleared', () => {
    // Clearing the field should restore the default rather than render an
    // empty header, which would look broken rather than intentional.
    expect(normalizePortalTitle('')).toBe(DEFAULT_PORTAL_TITLE)
    expect(normalizePortalTitle('   ')).toBe(DEFAULT_PORTAL_TITLE)
  })

  it('truncates rather than rejecting an over-long title', () => {
    const long = 'x'.repeat(MAX_PORTAL_TITLE_LENGTH + 20)
    expect(normalizePortalTitle(long)).toHaveLength(MAX_PORTAL_TITLE_LENGTH)
  })

  it('leaves markup alone — escaping is the renderer’s job, not this one’s', () => {
    // Normalising must not silently strip characters; the injection point
    // escapes. Stripping here would hide the need to escape there.
    expect(normalizePortalTitle('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
  })
})
