import { describe, expect, it } from 'vitest'
import { requestPathname } from '../../src/server/runtime.ts'

describe('requestPathname', () => {
  it('extracts pathname with no query or hash', () => {
    expect(requestPathname('/foo/bar')).toBe('/foo/bar')
  })

  it('extracts pathname with query string', () => {
    expect(requestPathname('/foo?a=1&b=2')).toBe('/foo')
  })

  it('extracts pathname with fragment', () => {
    expect(requestPathname('/foo#section')).toBe('/foo')
  })

  it('extracts pathname with both query and fragment', () => {
    expect(requestPathname('/foo?a=1#section')).toBe('/foo')
  })

  it('extracts pathname with hash before query', () => {
    // This is the discriminating case: naive "cut at ? else #" gives "/a#f"
    expect(requestPathname('/a#f?b=c')).toBe('/a')
  })

  it('handles protocol-relative URLs like //', () => {
    expect(requestPathname('//')).toBe('//')
  })

  it('handles undefined as /', () => {
    expect(requestPathname(undefined)).toBe('/')
  })

  it('handles root path', () => {
    expect(requestPathname('/')).toBe('/')
  })

  it('handles empty string as empty', () => {
    expect(requestPathname('')).toBe('')
  })
})
