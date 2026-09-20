// The name shown in the portal header and the browser tab. Owner-configurable,
// guest-visible. It lives here because the server validates, persists and
// injects it while the web reads it back out of the document.
//
// Normalising and escaping are deliberately separate. This module decides what
// a title *is*; the HTML injection point decides how to render one safely. If
// this stripped markup, the injection point would look safe without being safe,
// and the next person to add a render site would inherit the gap.
export const DEFAULT_PORTAL_TITLE = 'Guest Portal'

/** Long enough for "The Old Rectory Coach House", short enough for a phone header. */
export const MAX_PORTAL_TITLE_LENGTH = 60

export function normalizePortalTitle(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return DEFAULT_PORTAL_TITLE
  return trimmed.slice(0, MAX_PORTAL_TITLE_LENGTH)
}
