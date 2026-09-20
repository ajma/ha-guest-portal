import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PORTAL_TITLE } from '../../src/shared/portalTitle.ts'
import { readPortalTitle, writePortalTitle } from '../../src/web/portalTitle.ts'

// Separate from `portal-title.test.ts` on purpose: `test/unit/**/*.test.ts`
// runs under the `node` project, where `document` does not exist. Only `.tsx`
// files get happy-dom.
describe('readPortalTitle', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-portal-title')
  })

  it('reads the title the server injected', () => {
    document.documentElement.dataset.portalTitle = 'Beach House'
    expect(readPortalTitle()).toBe('Beach House')
  })

  it('falls back to the default when the attribute is absent', () => {
    expect(readPortalTitle()).toBe(DEFAULT_PORTAL_TITLE)
  })

  it('falls back when the attribute is present but blank', () => {
    // An attribute injected from a hand-edited database row can be whitespace.
    // Returning it would render an invisible header rather than a name.
    document.documentElement.dataset.portalTitle = '   '
    expect(readPortalTitle()).toBe(DEFAULT_PORTAL_TITLE)
  })

  it('returns the browser-decoded text verbatim, without escaping again', () => {
    // The server escapes on the way into the HTML; the parser decodes on the
    // way out, so this sees the original characters. Escaping here too would
    // show a guest the literal text `&lt;b&gt;` in the header — React already
    // renders this value as text, which is where the safety comes from.
    document.documentElement.setAttribute('data-portal-title', '<b>Tom & "Jerry"</b>')
    expect(readPortalTitle()).toBe('<b>Tom & "Jerry"</b>')
  })
})

describe('writePortalTitle', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-portal-title')
    document.title = ''
  })

  it('updates the attribute the server injected', () => {
    // The server writes this once, at page load. An owner renaming the portal
    // has no reload, so nothing else would ever correct it.
    document.documentElement.dataset.portalTitle = 'Guest Portal'

    writePortalTitle('Beach House')

    expect(readPortalTitle()).toBe('Beach House')
  })

  it('updates the browser tab as well as the attribute', () => {
    // The <title> element is server-rendered too, and is just as stale.
    writePortalTitle('Beach House')

    expect(document.title).toBe('Beach House')
  })
})
