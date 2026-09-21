// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

describe('API client', () => {
  beforeEach(() => {
    // Mock fetch
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete document.documentElement.dataset.ingressBase
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
        new Response(
          JSON.stringify({
            role: 'guest',
            portalId: 'p1',
            portalTitle: 'Guest Portal',
            portalTheme: 'classic',
            portalEnabled: true,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )

      const result = await login('correct')
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.data.role).toBe('guest')
    })

    it('prefixes the request with the ingress base when the server wrote one', async () => {
      // The bug this whole module change exists for: under Supervisor ingress
      // the page lives at /api/hassio_ingress/<token>/, and a hardcoded
      // '/api/session' resolves against the browser's real origin instead of
      // that prefix, so it never reaches this add-on at all.
      document.documentElement.dataset.ingressBase = '/api/hassio_ingress/tok/'

      const { getSession } = await import('../../src/web/api.js')

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            role: 'guest',
            portalId: 'p1',
            portalTitle: 'Guest Portal',
            portalTheme: 'classic',
            portalEnabled: true,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )

      await getSession()

      expect(fetch).toHaveBeenCalledWith(
        '/api/hassio_ingress/tok/api/session',
        expect.anything(),
      )
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

  describe('portal management API', () => {
    it('getPortals fetches the portal list with the ingress-prefixed URL', async () => {
      document.documentElement.dataset.ingressBase = '/api/hassio_ingress/tok/'
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ portals: [], lastSelectedPortalId: null }), { status: 200 }),
      )
      vi.stubGlobal('fetch', mockFetch)

      const { getPortals } = await import('../../src/web/api.js')
      await getPortals()

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/hassio_ingress/tok/api/admin/portals',
        expect.anything(),
      )
    })

    it('createPortal posts title and password', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'x' }),
          { status: 200 },
        ),
      )
      vi.stubGlobal('fetch', mockFetch)

      const { createPortal } = await import('../../src/web/api.js')
      const result = await createPortal({ title: 'Timothy', password: 'a-secret' })

      expect(result.ok).toBe(true)
      const init = mockFetch.mock.calls[0]?.[1]
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({ title: 'Timothy', password: 'a-secret' })
    })

    it('getDevices appends portalId when given one', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ devices: [], stale: false }), { status: 200 }),
      )
      vi.stubGlobal('fetch', mockFetch)

      const { getDevices } = await import('../../src/web/api.js')
      await getDevices('portal-123')

      expect(mockFetch.mock.calls[0]?.[0]).toBe('/api/devices?portalId=portal-123')
    })

    it('getDevices omits portalId when not given one', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ devices: [], stale: false }), { status: 200 }),
      )
      vi.stubGlobal('fetch', mockFetch)

      const { getDevices } = await import('../../src/web/api.js')
      await getDevices()

      expect(mockFetch.mock.calls[0]?.[0]).toBe('/api/devices')
    })
  })
})
