import { DEFAULT_PORTAL_TITLE } from '@shared/portalTitle.js'

/**
 * The server writes the title onto <html> in the same pass that writes the
 * theme, so the header is correct on first paint with no fetch. Guests need the
 * title and have no admin endpoints; injecting it avoids adding a public
 * settings route to serve one string.
 *
 * The value read back is the browser-decoded text, not the escaped source.
 * Escaping belongs at the injection point; here it would only double-escape
 * what React is already going to render as text.
 */
export function readPortalTitle(): string {
  const raw = document.documentElement.dataset.portalTitle
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORTAL_TITLE
  return raw
}
