import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

describe('API client', () => {
  beforeEach(() => {
    // Mock fetch
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('error handling', () => {
    it('surfaces 401 errors distinctly', async () => {
      const { login } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await login('wrong')
      expect(result.ok).toBe(false)
      if (result.ok) return

      expect(result.status).toBe(401)
    })

    it('surfaces 403 errors distinctly', async () => {
      const { getCatalog } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await getCatalog()
      expect(result.ok).toBe(false)
      if (result.ok) return

      expect(result.status).toBe(403)
    })

    it('surfaces 429 errors with Retry-After header', async () => {
      const { login } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too Many Requests' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        }),
      )

      const result = await login('password')
      expect(result.ok).toBe(false)
      if (result.ok) return

      expect(result.status).toBe(429)
      if ('retryAfter' in result) {
        expect(result.retryAfter).toBe(60)
      } else {
        throw new Error('Expected retryAfter to be present')
      }
    })

    it('handles successful login', async () => {
      const { login } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'guest' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await login('correct')
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.data.role).toBe('guest')
    })

    it('handles getSession returning null for 401', async () => {
      const { getSession } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await getSession()
      expect(result).toBeNull()
    })

    it('handles getSession returning role for authenticated user', async () => {
      const { getSession } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ role: 'admin' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await getSession()
      expect(result).toEqual({ role: 'admin' })
    })

    it('omits retryAfter for non-numeric Retry-After header', async () => {
      const { login } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too Many Requests' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT',
          },
        }),
      )

      const result = await login('password')
      expect(result.ok).toBe(false)
      if (result.ok) return

      expect(result.status).toBe(429)
      expect('retryAfter' in result).toBe(false)
    })

    it('omits retryAfter for NaN Retry-After header', async () => {
      const { login } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too Many Requests' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': 'abc',
          },
        }),
      )

      const result = await login('password')
      expect(result.ok).toBe(false)
      if (result.ok) return

      expect(result.status).toBe(429)
      expect('retryAfter' in result).toBe(false)
    })

    it('calls unauthorized callback on 401', async () => {
      const { getDevices, setUnauthorizedCallback } = await import('../../src/web/api.js')

      const callback = vi.fn()
      setUnauthorizedCallback(callback)

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      await getDevices()
      expect(callback).toHaveBeenCalledOnce()

      setUnauthorizedCallback(null)
    })

    it('does not call unauthorized callback on non-401 errors', async () => {
      const { getDevices, setUnauthorizedCallback } = await import('../../src/web/api.js')

      const callback = vi.fn()
      setUnauthorizedCallback(callback)

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      await getDevices()
      expect(callback).not.toHaveBeenCalled()

      setUnauthorizedCallback(null)
    })
  })
})
