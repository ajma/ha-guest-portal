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

/**
 * Put a freshly saved title back where the server put the original.
 *
 * The attribute is written by the server once, at page load. Without this, an
 * owner who renames the portal from the settings panel is editing a value the
 * rest of their own page cannot see: the header still reads from the stale
 * attribute, and the browser tab still shows the old name until a reload.
 *
 * Guests needing a reload is by design — they have no settings panel and no
 * endpoint to poll. The owner, on the page they are editing, is not.
 *
 * This writes the *normalised* value, the one the server stored, so a cleared
 * field visibly snaps back to the default rather than blanking the header.
 * Nothing re-renders as a result of this call: React does not observe DOM
 * attributes, so the caller also tells its parent.
 */
export function writePortalTitle(title: string): void {
  document.documentElement.dataset.portalTitle = title
  document.title = title
}
