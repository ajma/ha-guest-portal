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
        new Response(JSON.stringify({ role: 'guest', portalEnabled: true }), {
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
        new Response(JSON.stringify({ role: 'admin', portalEnabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await getSession()
      expect(result).toEqual({ role: 'admin', portalEnabled: true })
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

  describe('admin portal API', () => {
    it('fetches portal state', async () => {
      const { getAdminPortal } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: false,
            integrationToken: 'a'.repeat(64),
            portalId: '11111111-1111-1111-1111-111111111111',
            theme: 'classic',
            title: 'Guest Portal',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )

      const result = await getAdminPortal()

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.enabled).toBe(false)
    })

    it('reports a failed portal fetch', async () => {
      const { getAdminPortal } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await getAdminPortal()

      expect(result.ok).toBe(false)
    })

    it('puts a new enabled value', async () => {
      const { putAdminPortal } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await putAdminPortal(false)

      expect(result.ok).toBe(true)
    })

    it('reports a failed put', async () => {
      const { putAdminPortal } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const result = await putAdminPortal(false)

      expect(result.ok).toBe(false)
    })

    it('calls unauthorized callback on 401', async () => {
      const { putAdminPortal, setUnauthorizedCallback } = await import('../../src/web/api.js')

      const callback = vi.fn()
      setUnauthorizedCallback(callback)

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      await putAdminPortal(false)
      expect(callback).toHaveBeenCalledOnce()

      setUnauthorizedCallback(null)
    })

    it('does not call unauthorized callback on non-401 errors', async () => {
      const { putAdminPortal, setUnauthorizedCallback } = await import('../../src/web/api.js')

      const callback = vi.fn()
      setUnauthorizedCallback(callback)

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      await putAdminPortal(false)
      expect(callback).not.toHaveBeenCalled()

      setUnauthorizedCallback(null)
    })
  })
})
