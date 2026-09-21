import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `apiUrl`/`readBasePath` are the fix for a hardcoded-root-path bug: every
 * client-side network call in this app (`fetch('/api/...')`,
 * `new EventSource('/api/stream')`, `navigator.serviceWorker.register('/sw.js')`)
 * is a root-absolute path, which resolves against the browser's real origin
 * even under Supervisor ingress where the page itself lives at
 * `/api/hassio_ingress/<token>/`. `<base href>` does not help — it only
 * affects relative URLs. `apiUrl` is what makes these calls ingress-aware.
 *
 * `document` does not exist under plain Node, so each test stubs it directly
 * rather than switching the whole file's environment, matching how
 * register-service-worker.test.ts stubs `navigator`.
 */
describe('basePath', () => {
  function stubDataset(dataset: Record<string, string | undefined>): void {
    vi.stubGlobal('document', { documentElement: { dataset } })
  }

  beforeEach(() => {
    stubDataset({})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('readBasePath', () => {
    it('falls back to root when the attribute is absent', async () => {
      const { readBasePath } = await import('../../src/web/basePath.js')

      expect(readBasePath()).toBe('/')
    })

    it('returns the attribute value when the server wrote one', async () => {
      stubDataset({ ingressBase: '/api/hassio_ingress/tok/' })
      const { readBasePath } = await import('../../src/web/basePath.js')

      expect(readBasePath()).toBe('/api/hassio_ingress/tok/')
    })
  })

  describe('apiUrl', () => {
    it('leaves a path unchanged at the root, without a double slash', async () => {
      stubDataset({})
      const { apiUrl } = await import('../../src/web/basePath.js')

      expect(apiUrl('/api/session')).toBe('/api/session')
    })

    it('prefixes a path with the ingress base', async () => {
      stubDataset({ ingressBase: '/api/hassio_ingress/tok/' })
      const { apiUrl } = await import('../../src/web/basePath.js')

      expect(apiUrl('/api/session')).toBe('/api/hassio_ingress/tok/api/session')
    })

    it('joins a bare root path, such as the service worker script, the same way', async () => {
      stubDataset({ ingressBase: '/api/hassio_ingress/tok/' })
      const { apiUrl } = await import('../../src/web/basePath.js')

      expect(apiUrl('/sw.js')).toBe('/api/hassio_ingress/tok/sw.js')
    })

    it('does not double the slash when the base is missing its trailing slash', async () => {
      stubDataset({ ingressBase: '/api/hassio_ingress/tok' })
      const { apiUrl } = await import('../../src/web/basePath.js')

      expect(apiUrl('/api/session')).toBe('/api/hassio_ingress/tok/api/session')
    })
  })
})
