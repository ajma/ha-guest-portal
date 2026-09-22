/**
 * The shortest password the server will store for a portal, mirrored from
 * `PortalCreateRequest` / `PortalPutRequest` in `src/shared/api.ts`.
 *
 * It belongs beside those schemas, the way `MAX_PORTAL_TITLE_LENGTH` does in
 * `src/shared/portalTitle.ts`, so the rule is one number for both halves. Kept
 * here for now, because a client that cannot name the rule can only offer an
 * owner the server's bare 400 and no way to act on it.
 */
export const MIN_PORTAL_PASSWORD_LENGTH = 8

export const PASSWORD_RULE = `At least ${MIN_PORTAL_PASSWORD_LENGTH} characters`
