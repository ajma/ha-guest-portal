import { z } from 'zod'

const schema = z
  .object({
    HA_BASE_URL: z.url().transform((s) => s.replace(/\/+$/, '')),
    HA_TOKEN: z.string().min(1),
    GUEST_PASSWORD: z.string().min(8),
    ADMIN_PASSWORD: z.string().min(8),
    PORT: z.coerce.number().int().positive().default(8080),
    DB_PATH: z.string().default('/data/portal.db'),
    TRUST_PROXY: z.string().optional(),
  })
  .refine((v) => v.GUEST_PASSWORD !== v.ADMIN_PASSWORD, {
    message: 'GUEST_PASSWORD and ADMIN_PASSWORD must differ',
  })

export type Config = {
  haBaseUrl: string
  haToken: string
  guestPassword: string
  adminPassword: string
  port: number
  dbPath: string
  trustProxy: string | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(env)
  if (!r.success) throw new Error(`Invalid configuration:\n${z.prettifyError(r.error)}`)
  const v = r.data
  return {
    haBaseUrl: v.HA_BASE_URL,
    haToken: v.HA_TOKEN,
    guestPassword: v.GUEST_PASSWORD,
    adminPassword: v.ADMIN_PASSWORD,
    port: v.PORT,
    dbPath: v.DB_PATH,
    trustProxy: v.TRUST_PROXY,
  }
}
