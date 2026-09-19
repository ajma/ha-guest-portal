import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeSupervisor } from '../fake-supervisor.ts'
import { DISCOVERY_SERVICE, publishDiscovery } from '../../src/server/hassio/discovery.ts'

describe('Supervisor discovery', () => {
  let supervisor: FakeSupervisor

  beforeEach(async () => {
    supervisor = await FakeSupervisor.start()
  })

  afterEach(async () => {
    await supervisor.stop()
  })

  function options() {
    return {
      supervisorToken: supervisor.token,
      supervisorBaseUrl: supervisor.baseUrl,
      portalId: '11111111-1111-1111-1111-111111111111',
      token: 'a'.repeat(64),
      port: 8080,
    }
  }

  it('publishes a discovery record', async () => {
    const ok = await publishDiscovery(options())

    expect(ok).toBe(true)
    expect(supervisor.discoveries).toHaveLength(1)
    expect(supervisor.discoveries[0]?.service).toBe(DISCOVERY_SERVICE)
  })

  it('publishes the connection details the integration needs', async () => {
    await publishDiscovery(options())

    expect(supervisor.discoveries[0]?.config).toEqual({
      portalId: '11111111-1111-1111-1111-111111111111',
      host: supervisor.addonHostname,
      port: 8080,
      token: 'a'.repeat(64),
    })
  })

  it('replaces its own record rather than duplicating on restart', async () => {
    await publishDiscovery(options())
    await publishDiscovery(options())

    expect(supervisor.discoveries).toHaveLength(1)
  })

  it('leaves other services alone', async () => {
    await publishDiscovery(options())
    supervisor.discoveries.push({
      uuid: 'other',
      addon: 'x',
      service: 'mqtt',
      config: {},
    })

    await publishDiscovery(options())

    expect(supervisor.discoveries.map((r) => r.service).sort()).toEqual([DISCOVERY_SERVICE, 'mqtt'])
  })

  it('returns false rather than throwing when the Supervisor errors', async () => {
    supervisor.failWith = 500

    await expect(publishDiscovery(options())).resolves.toBe(false)
  })

  it('returns false rather than throwing when the Supervisor is unreachable', async () => {
    const opts = options()
    await supervisor.stop()

    await expect(publishDiscovery(opts)).resolves.toBe(false)
  })
})
