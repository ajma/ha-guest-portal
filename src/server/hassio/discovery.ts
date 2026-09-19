import { z } from 'zod'

/**
 * Must match the integration's `domain` in custom_components/ha_guest_portal/
 * manifest.json. Home Assistant uses the discovery service name directly as
 * the config-flow domain, so a mismatch fails silently.
 */
export const DISCOVERY_SERVICE = 'ha_guest_portal'

const DEFAULT_SUPERVISOR_URL = 'http://supervisor'
const TIMEOUT_MS = 10_000

export type DiscoveryOptions = {
  supervisorToken: string
  supervisorBaseUrl?: string
  portalId: string
  token: string
  port: number
}

const AddonInfoSchema = z.object({
  data: z.object({
    hostname: z.string(),
  }),
})

const DiscoveryListSchema = z.object({
  data: z.object({
    discovery: z.array(
      z.object({
        uuid: z.string(),
        service: z.string(),
      }),
    ),
  }),
})

/**
 * Announce this add-on to the Supervisor so Home Assistant opens a config flow
 * on the companion integration.
 *
 * Every failure is logged and swallowed: the portal must start even when the
 * Supervisor refuses. `/discovery*` needs no `hassio_api: true` in config.yaml.
 */
export async function publishDiscovery(opts: DiscoveryOptions): Promise<boolean> {
  const baseUrl = opts.supervisorBaseUrl ?? DEFAULT_SUPERVISOR_URL

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.supervisorToken}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }

  try {
    // 1. Our own hostname on the internal network.
    const infoResponse = await request('/addons/self/info')
    if (!infoResponse.ok) {
      console.error(`Discovery: /addons/self/info returned ${infoResponse.status}`)
      return false
    }
    const info = AddonInfoSchema.parse(await infoResponse.json())

    // 2. Remove any record we left behind before this restart, so a restart
    //    replaces rather than accumulates.
    const listResponse = await request('/discovery')
    if (listResponse.ok) {
      const list = DiscoveryListSchema.parse(await listResponse.json())
      const stale = list.data.discovery.filter((r) => r.service === DISCOVERY_SERVICE)

      for (const record of stale) {
        await request(`/discovery/${record.uuid}`, { method: 'DELETE' })
      }
    }

    // 3. Announce.
    const postResponse = await request('/discovery', {
      method: 'POST',
      body: JSON.stringify({
        service: DISCOVERY_SERVICE,
        config: {
          portalId: opts.portalId,
          host: info.data.hostname,
          port: opts.port,
          token: opts.token,
        },
      }),
    })

    if (!postResponse.ok) {
      console.error(`Discovery: POST /discovery returned ${postResponse.status}`)
      return false
    }

    console.log(`Discovery: announced ${DISCOVERY_SERVICE} to the Supervisor`)
    return true
  } catch (error) {
    // Strip the token from any error text before logging.
    const message =
      error instanceof Error ? error.message.replaceAll(opts.token, '[REDACTED]') : String(error)
    console.error(`Discovery: failed to announce (${message})`)
    return false
  }
}
