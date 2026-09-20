import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRequestListener } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.ts'
import type { Config } from '../../src/server/config.ts'
import { HaClient } from '../../src/server/ha/client.ts'
import { LoginRateLimiter, SessionStore } from '../../src/server/http/auth.ts'
import type { Deps } from '../../src/server/http/routes-guest.ts'
import { SseHub } from '../../src/server/http/sse.ts'
import { AllowlistStore } from '../../src/server/store/allowlist.ts'
import { AuditLog } from '../../src/server/store/auditlog.ts'
import { openDb } from '../../src/server/store/db.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'

/**
 * The PWA's two root-level files have to be answered by static serving, ahead
 * of the SPA fallback (`app.ts:158` before `app.ts:161`). That ordering is
 * load-bearing and completely invisible to a status check: the fallback answers
 * *any* non-API path with index.html, so `/sw.js` returns 200 with a perfectly
 * healthy-looking HTML body even when the file does not exist at all. A worker
 * whose script is HTML fails to register, silently, and the offline screen
 * never appears.
 *
 * So every assertion here is about the body, and the last test is the control
 * that stops the other three from passing under a server that had stopped
 * falling back entirely.
 *
 * A temp `webRoot` rather than the real build output: `dist/web` may be stale
 * or absent, and writing stubs into it would clobber the built SPA for every
 * later consumer, including Playwright.
 */
const WEB_ROOT = mkdtempSync(join(tmpdir(), 'portal-pwa-'))

describe('PWA assets are served from the root', () => {
  let db: import('node:sqlite').DatabaseSync
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    writeFileSync(
      join(WEB_ROOT, 'index.html'),
      '<!DOCTYPE html>\n<html lang="en"><head></head><body></body></html>',
    )
    writeFileSync(join(WEB_ROOT, 'sw.js'), "const CACHE = 'portal-shell-v1'\n")
    writeFileSync(
      join(WEB_ROOT, 'manifest.webmanifest'),
      JSON.stringify({ name: 'Home Assistant Guest Portal' }),
    )
    mkdirSync(join(WEB_ROOT, 'icons'), { recursive: true })
    writeFileSync(join(WEB_ROOT, 'icons', 'icon-192.png'), 'not-really-a-png')

    db = openDb(':memory:')

    const cfg: Config = {
      haBaseUrl: 'http://127.0.0.1:1',
      haWsUrl: undefined,
      haToken: 'test-ha-token',
      guestPassword: 'guest-pass-12345678',
      adminPassword: 'admin-pass-87654321',
      port: 8080,
      ingressPort: undefined,
      dbPath: ':memory:',
      trustProxy: undefined,
      webRoot: WEB_ROOT,
    }

    const deps: Deps = {
      cfg,
      // Never started, so it opens no socket. Nothing on these paths calls it.
      ha: HaClient.create({ haBaseUrl: cfg.haBaseUrl, haToken: cfg.haToken }),
      allowlist: new AllowlistStore(db),
      audit: new AuditLog(db),
      settings: new SettingsStore(db),
      interactions: new InteractionStore(db),
      sessions: new SessionStore(),
      limiter: new LoginRateLimiter({ perIpMax: 10, windowMs: 60_000 }),
      hub: new SseHub(),
    }

    server = createServer(getRequestListener(createApp(deps).fetch))
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    db.close()
    rmSync(WEB_ROOT, { recursive: true, force: true })
  })

  it('serves the service worker itself, not the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/sw.js`)
    expect(res.status).toBe(200)

    const text = await res.text()
    // The SPA fallback answers any non-API path with index.html, so a status
    // check alone passes even when the file is missing entirely. Assert on the
    // body, and on the absence of the shell.
    expect(text).toContain('portal-shell-v1')
    expect(text).not.toContain('<!DOCTYPE')
  })

  it('serves the manifest as JSON, not the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/manifest.webmanifest`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { name: string }
    expect(body.name).toBe('Home Assistant Guest Portal')
  })

  it('serves an icon rather than the shell', async () => {
    const res = await fetch(`${baseUrl}/icons/icon-192.png`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('<!DOCTYPE')
  })

  it('still falls back to the shell for a path that is not a file', async () => {
    // The control: without it the three above would also pass if static
    // serving had swallowed everything, including routes that should fall back.
    const res = await fetch(`${baseUrl}/some/guest/route`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<!DOCTYPE')
  })

  it('leaves the worker at the root, where its scope covers the whole app', async () => {
    // A worker's scope is the directory it was served from, so `/sw.js` landing
    // under `/assets/` — the natural result of ever bundling it instead of
    // copying it verbatim out of `public/` — would control nothing but
    // `/assets/*` and quietly never see a navigation. The registration asks for
    // `/sw.js` (registerServiceWorker.ts), so the root path must be the one
    // that answers with the script.
    const res = await fetch(`${baseUrl}/sw.js`)
    expect(new URL(res.url).pathname).toBe('/sw.js')
    expect(res.headers.get('content-type')).toMatch(/javascript/)
  })
})
