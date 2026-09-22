import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRequestListener } from '@hono/node-server'
import { createServer } from 'node:http'
import type { HttpBindings } from '@hono/node-server'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { PortalStore } from '../../src/server/store/portals.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'
import { DEFAULT_THEME_ID } from '../../src/shared/themes.ts'

/**
 * The base href is the *other* owner-influenced string written into index.html,
 * and until now it had no coverage at all: reverting its injection to the
 * pre-fix form — a string replacement, no escaping —
 *
 *   .replace(/(<head[^>]*>)/i, `$1\n    <base href="${normalizedBase}">`)
 *
 * passed every test in the suite. The title's own escaping is pinned in
 * routes-guest.test.ts; this file is the same guarantee for the value beside it.
 *
 * Reaching it needs two things the other integration tests do not set up: the
 * value comes from the `x-ingress-path` header, which is only trusted when
 * ingress is configured AND the request appears to come from the Supervisor at
 * 172.30.32.2. The ingress server binds to loopback under test, so a real
 * socket always reports 127.0.0.1 and is rejected with a 403 long before any
 * HTML is rendered.
 *
 * So the app is driven through `app.fetch(request, env)` instead of over a
 * socket. `c.env.incoming.socket.remoteAddress` is the only part of the node
 * bindings the request path reads, and supplying it directly is what makes the
 * Supervisor-only branch reachable.
 */
const WEB_ROOT = mkdtempSync(join(tmpdir(), 'portal-basehref-'))
const INDEX = join(WEB_ROOT, 'index.html')

const SUPERVISOR = '172.30.32.2'

/** Just enough of the node bindings for the request path; nothing else is read. */
function envFrom(remoteAddress: string): HttpBindings {
  return { incoming: { socket: { remoteAddress } } } as unknown as HttpBindings
}

describe('Base href injection', () => {
  afterAll(() => {
    rmSync(WEB_ROOT, { recursive: true, force: true })
  })

  let db: import('node:sqlite').DatabaseSync
  let settings: SettingsStore
  let portals: PortalStore
  let deps: Deps
  let server: Server
  let baseUrl: string

  // Logs a guest in against a portal's password and returns the Set-Cookie
  // header value, matching routes-guest.test.ts's convention.
  async function loginAs(password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const cookie = res.headers.get('set-cookie')
    if (!cookie) throw new Error(`login with password ${password} did not set a cookie`)
    return cookie
  }

  beforeEach(async () => {
    writeFileSync(
      INDEX,
      '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <title>t</title>\n  </head>\n  <body></body>\n</html>',
    )

    db = openDb(':memory:')
    settings = new SettingsStore(db)
    portals = new PortalStore(db)

    const cfg: Config = {
      haBaseUrl: 'http://127.0.0.1:1',
      haWsUrl: undefined,
      haToken: 'test-ha-token',
      adminPassword: 'admin-pass-87654321',
      port: 8080,
      // Ingress on: without it `baseHrefFor` ignores the header outright and
      // every case below would read '/'.
      ingressPort: 8099,
      dbPath: ':memory:',
      trustProxy: undefined,
      webRoot: WEB_ROOT,
    }

    deps = {
      cfg,
      // Never started, so it opens no socket. Nothing on the HTML path calls it.
      ha: HaClient.create({ haBaseUrl: cfg.haBaseUrl, haToken: cfg.haToken }),
      allowlist: new AllowlistStore(db),
      audit: new AuditLog(db),
      settings,
      interactions: new InteractionStore(db),
      portals,
      sessions: new SessionStore(),
      limiter: new LoginRateLimiter({ perIpMax: 10, windowMs: 60_000 }),
      hub: new SseHub(),
    }

    // A real listening server, needed only by the session/theme tests below:
    // they log in over HTTP and rely on a real cookie round-trip, unlike the
    // existing ingress-path tests which drive `app.fetch` directly so they can
    // spoof `remoteAddress` via `envFrom`. A real socket always reports
    // 127.0.0.1, which is exactly the "not the Supervisor" case those tests
    // want anyway.
    server = createServer(getRequestListener(createApp(deps).fetch))
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  })

  async function get(path: string, ingressPath?: string, from = SUPERVISOR): Promise<string> {
    const headers = ingressPath === undefined ? {} : { 'x-ingress-path': ingressPath }
    const res = await createApp(deps).fetch(
      new Request(`http://localhost${path}`, { headers }),
      envFrom(from),
    )
    return await res.text()
  }

  it('injects the ingress path the Supervisor supplied', async () => {
    // The ordinary case, and the reason the header is trusted at all: every
    // asset URL in the page resolves against this.
    const html = await get('/', '/api/hassio_ingress/abc123')

    expect(html).toContain('<base href="/api/hassio_ingress/abc123/">')
    // The client's own fetch/EventSource/service-worker calls are
    // root-absolute paths that <base href> cannot help with (it only affects
    // relative URLs), so the same value also has to reach the client as a
    // data attribute for `apiUrl`/`readBasePath` (src/web/basePath.ts) to read.
    expect(html).toContain('data-ingress-base="/api/hassio_ingress/abc123/"')
  })

  it('ignores the header on a request that is not from the Supervisor', async () => {
    const html = await get('/', '/api/hassio_ingress/abc123', '127.0.0.1')

    expect(html).toContain('<base href="/">')
    expect(html).not.toContain('abc123')
    expect(html).toContain('data-ingress-base="/"')
  })

  it('escapes a base href that would otherwise break out of the attribute', async () => {
    // The header is not owner-supplied, but it is request-supplied, and it is
    // written into a double-quoted attribute exactly as the title is. Without
    // escapeHtml the closing quote lands in the document and the rest of the
    // header is parsed as further attributes on <base> — and then as markup.
    const html = await get('/', '/x"><script>alert(1)</script>')

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    // Necessary but not sufficient on its own: dropping only the quote
    // replacement still escapes the tag while closing the attribute early. The
    // whole expected value is what proves the attribute survived intact.
    expect(html).toContain('<base href="/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/">')
    expect(html).toContain(
      'data-ingress-base="/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/"',
    )
  })

  it('escapes an ampersand in the base href', async () => {
    const html = await get('/', '/a&b')

    expect(html).toContain('<base href="/a&amp;b/">')
    // Not escaped at all, and double-escaped, are different bugs with the same
    // symptom in a toContain-only test.
    expect(html).not.toContain('href="/a&b')
    expect(html).not.toContain('&amp;amp;')
  })

  it('treats $-sequences in the base href as text, not replacement patterns', async () => {
    // `String.prototype.replace` expands `$&`, `` $` `` and `$'` inside a
    // *string* replacement, and escaping does not defuse them: `$&` escapes to
    // `$&amp;`, which still begins `$&`. Only a function replacer disables the
    // expansion. Without one, `` $` `` splices everything before the matched
    // <head> — the doctype and the <html> tag — into the attribute.
    const html = await get('/', "/$& $` $' x")

    expect(html).toContain('<base href="/$&amp; $` $&#39; x/">')
    expect(html).not.toMatch(/<base href="[^"]*<(head|html|!DOCTYPE)/i)
  })

  it('injects the same base href on a deep link', async () => {
    // The SPA fallback renders index.html for any non-API path, so the
    // injection has to be identical there or a refreshed deep link boots with
    // every asset URL wrong.
    const html = await get('/some/deep/link', '/api/hassio_ingress/abc123')

    expect(html).toContain('<base href="/api/hassio_ingress/abc123/">')
  })

  it('renders a neutral theme with no session cookie', async () => {
    const res = await fetch(baseUrl)
    const html = await res.text()
    expect(html).toContain(`data-theme="${DEFAULT_THEME_ID}"`)
    expect(html).not.toContain('data-portal-title')
  })

  it("renders the guest's own portal theme when their session cookie is valid", async () => {
    const portal = portals.create({ title: 'Timothy', password: 'timothy-theme-pass' })
    portals.update(portal.id, { theme: 'tiles' })
    const cookie = await loginAs('timothy-theme-pass')

    const res = await fetch(baseUrl, { headers: { cookie } })
    const html = await res.text()
    expect(html).toContain('data-theme="tiles"')
    expect(html).toContain('<title>Timothy</title>')
  })

  it('escapes a hostile portal title rather than emitting it raw', async () => {
    // The title is owner-supplied text written into the <title> element. This
    // is the only injection surface `renderIndexHtml` adds beyond the base
    // href already covered above.
    portals.create({ title: '"><script>alert(1)</script>', password: 'hostile-title-pass' })
    const cookie = await loginAs('hostile-title-pass')

    const res = await fetch(baseUrl, { headers: { cookie } })
    const html = await res.text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
  })

  it('escapes an ampersand in the portal title before the escapes it introduces itself', async () => {
    // Ordering matters and is invisible in a title made only of tags: escape
    // `&` last and every `&` this function emits gets re-escaped, so the
    // header renders `&quot;` as literal text instead of a quote.
    portals.create({ title: 'Tom & Jerry\'s "Place"', password: 'ampersand-title-pass' })
    const cookie = await loginAs('ampersand-title-pass')

    const res = await fetch(baseUrl, { headers: { cookie } })
    const html = await res.text()
    expect(html).toContain('<title>Tom &amp; Jerry&#39;s &quot;Place&quot;</title>')
    expect(html).not.toContain('Tom & Jerry')
    expect(html).not.toContain('&amp;quot;')
  })

  it('treats $-sequences in the portal title as text, not replacement patterns', async () => {
    // `String.prototype.replace` expands `$&`, `` $` `` and `$'` inside a
    // *string* replacement, and escaping does not defuse them: `$&` escapes
    // to `$&amp;`, which still begins `$&`. Only a function replacer disables
    // the expansion — without one, `` $` `` would splice everything before
    // the matched <title> tag — the doctype, <html>, and <head> — into the
    // title text.
    portals.create({ title: '$& $` Bay', password: 'dollar-title-pass' })
    const cookie = await loginAs('dollar-title-pass')

    const res = await fetch(baseUrl, { headers: { cookie } })
    const html = await res.text()
    expect(html).toContain('<title>$&amp; $` Bay</title>')
    expect(html).not.toMatch(/<title>[^<]*<(head|html|!DOCTYPE)/i)
  })
})
