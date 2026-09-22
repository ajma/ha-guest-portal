import { z } from 'zod'
import { verifyPassword } from './http/auth.js'

const schema = z
  .object({
    HA_BASE_URL: z.url().transform((s) => s.replace(/\/+$/, '')),
    HA_WS_URL: z.url().optional(),
    HA_TOKEN: z.string().min(1),
    ADMIN_PASSWORD: z.string().min(8).optional(),
    PORT: z.coerce.number().int().positive().default(9123),
    INGRESS_PORT: z.coerce.number().int().positive().optional(),
    DB_PATH: z.string().default('/data/portal.db'),
    TRUST_PROXY: z.string().optional(),
  })
  .refine(
    (v) => {
      const url = new URL(v.HA_BASE_URL)
      return !url.hostname.endsWith('.local')
    },
    {
      message:
        'mDNS hostnames (.local) do not resolve inside containers. Use a LAN IP address instead.',
    },
  )

export type Config = {
  haBaseUrl: string
  haWsUrl: string | undefined
  haToken: string
  adminPassword: string | undefined
  port: number
  ingressPort: number | undefined
  dbPath: string
  trustProxy: string | undefined
  /**
   * Directory the built SPA is served from. Defaults to the build output.
   *
   * This exists so tests can point the static root at a scratch directory.
   * They need a known index.html to assert against, and when the root was
   * hardcoded the only way to get one was to write into dist/web — which
   * clobbered the real build for everything downstream, Playwright included.
   */
  webRoot?: string
}

/**
 * Fail fast when no admin path can ever exist.
 *
 * Admin is reachable two ways: through the ingress server (add-on mode) or by
 * logging in with ADMIN_PASSWORD. With neither, the deployment starts but no
 * credential can ever authenticate as admin - and since a fresh database has
 * zero portals, nothing can create the first one either.
 */
export function assertAdminAccessPossible(cfg: Config): void {
  if (cfg.ingressPort === undefined && cfg.adminPassword === undefined) {
    throw new Error(
      'No admin access is possible: set ADMIN_PASSWORD (at least 8 characters), or run as a Home Assistant add-on so admin is reachable via ingress. Without one of these, no portal can ever be created.',
    )
  }
}

/**
 * Fail fast when the admin password is also some portal's password.
 *
 * `classify` tries the admin password before any portal's and returns on the
 * first match, so a collision does not merely make that portal unreachable —
 * it hands that portal's guests an admin session over every portal in the
 * deployment. The create and update routes already answer 409 for the same
 * collision, so the only way to reach this state is to point ADMIN_PASSWORD
 * at a password a portal already had.
 *
 * Refusing to start is the fail-closed choice, and a recoverable one: the
 * owner changes ADMIN_PASSWORD in the add-on options, which is Home
 * Assistant's own UI rather than anything this add-on has to be running to
 * serve. Starting anyway would mean knowingly serving the escalation.
 */
export function assertNoAdminPasswordCollision(
  cfg: Config,
  portals: ReadonlyArray<{ id: string; title: string; password: string }>,
): void {
  const adminPassword = cfg.adminPassword
  if (adminPassword === undefined) return

  const colliding = portals.filter((p) => verifyPassword(p.password, adminPassword))
  if (colliding.length === 0) return

  const names = colliding.map((p) => `"${p.title}" (${p.id})`).join(', ')
  throw new Error(
    `ADMIN_PASSWORD is also the guest password for ${names}. A guest of that portal would be logged in as admin over every portal. Change ADMIN_PASSWORD, or change that portal's password.`,
  )
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(env)
  if (!r.success) throw new Error(`Invalid configuration:\n${z.prettifyError(r.error)}`)
  const v = r.data
  return {
    haBaseUrl: v.HA_BASE_URL,
    haWsUrl: v.HA_WS_URL,
    haToken: v.HA_TOKEN,
    adminPassword: v.ADMIN_PASSWORD,
    port: v.PORT,
    ingressPort: v.INGRESS_PORT,
    dbPath: v.DB_PATH,
    trustProxy: v.TRUST_PROXY,
  }
}
