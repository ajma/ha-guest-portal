import { describe, expect, it } from 'vitest'
import { appPath } from '../../src/web/path.ts'

describe('appPath', () => {
  it('returns the full pathname when base is /', () => {
    expect(appPath('http://host/', 'http://host/admin')).toBe('/admin')
    expect(appPath('http://host/', 'http://host/')).toBe('/')
    expect(appPath('http://host/', 'http://host/path/to/page')).toBe('/path/to/page')
  })

  it('strips the base prefix when present', () => {
    expect(
      appPath(
        'http://host/api/hassio_ingress/TOKEN/',
        'http://host/api/hassio_ingress/TOKEN/admin',
      ),
    ).toBe('/admin')
    expect(
      appPath('http://host/api/hassio_ingress/TOKEN/', 'http://host/api/hassio_ingress/TOKEN/'),
    ).toBe('/')
    expect(
      appPath(
        'http://host/api/hassio_ingress/TOKEN/',
        'http://host/api/hassio_ingress/TOKEN/path/to/page',
      ),
    ).toBe('/path/to/page')
  })

  it('handles base without trailing slash', () => {
    expect(appPath('http://host/prefix', 'http://host/prefix/admin')).toBe('/admin')
    expect(appPath('http://host/prefix', 'http://host/prefix/')).toBe('/')
  })

  it('returns the path unchanged if it does not start with the base', () => {
    expect(appPath('http://host/prefix', 'http://host/other/path')).toBe('/other/path')
    expect(appPath('http://host/api/ingress', 'http://host/admin')).toBe('/admin')
  })

  it('handles trailing slashes in base consistently', () => {
    expect(appPath('http://host/base/', 'http://host/base/admin')).toBe('/admin')
    expect(appPath('http://host/base//', 'http://host/base/admin')).toBe('/admin')
  })

  it('returns / when base is stripped and path was exactly the base', () => {
    expect(appPath('http://host/base', 'http://host/base')).toBe('/')
    expect(appPath('http://host/base/', 'http://host/base/')).toBe('/')
  })

  it('handles complex base paths', () => {
    expect(
      appPath(
        'http://host/api/hassio_ingress/abc-123-def/',
        'http://host/api/hassio_ingress/abc-123-def/admin',
      ),
    ).toBe('/admin')
  })
})
