import { z } from 'zod'

const schema = z
  .object({
    HA_BASE_URL: z.url().transform((s) => s.replace(/\/+$/, '')),
    HA_WS_URL: z.url().optional(),
    HA_TOKEN: z.string().min(1),
    GUEST_PASSWORD: z.string().min(8),
    ADMIN_PASSWORD: z.string().min(8),
    PORT: z.coerce.number().int().positive().default(8080),
    INGRESS_PORT: z.coerce.number().int().positive().optional(),
    DB_PATH: z.string().default('/data/portal.db'),
    TRUST_PROXY: z.string().optional(),
  })
  .refine((v) => v.GUEST_PASSWORD !== v.ADMIN_PASSWORD, {
    message: 'GUEST_PASSWORD and ADMIN_PASSWORD must differ',
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
  guestPassword: string
  adminPassword: string
  port: number
  ingressPort: number | undefined
  dbPath: string
  trustProxy: string | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(env)
  if (!r.success) throw new Error(`Invalid configuration:\n${z.prettifyError(r.error)}`)
  const v = r.data
  return {
    haBaseUrl: v.HA_BASE_URL,
    haWsUrl: v.HA_WS_URL,
    haToken: v.HA_TOKEN,
    guestPassword: v.GUEST_PASSWORD,
    adminPassword: v.ADMIN_PASSWORD,
    port: v.PORT,
    ingressPort: v.INGRESS_PORT,
    dbPath: v.DB_PATH,
    trustProxy: v.TRUST_PROXY,
  }
}
