import { MIN_PORTAL_PASSWORD_LENGTH } from '@shared/api.js'

// Re-exported rather than redeclared: the canonical value lives beside the
// `PortalCreateRequest` / `PortalPutRequest` schemas that enforce it.
export { MIN_PORTAL_PASSWORD_LENGTH }

export const PASSWORD_RULE = `At least ${MIN_PORTAL_PASSWORD_LENGTH} characters`
