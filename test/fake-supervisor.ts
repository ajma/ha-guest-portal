import { createServer, type Server } from 'node:http'

export type DiscoveryRecord = {
  uuid: string
  addon: string
  service: string
  config: Record<string, unknown>
}

/**
 * Minimal stand-in for the Home Assistant Supervisor, covering only the
 * endpoints the add-on's discovery publication touches.
 */
export class FakeSupervisor {
  private server: Server
  private records: DiscoveryRecord[] = []
  private nextUuid = 1

  readonly token = 'fake-supervisor-token'
  readonly addonHostname = 'local-ha-guest-portal'
  readonly requests: Array<{ method: string; path: string }> = []

  /** Set to a status code to make every request fail with it. */
  failWith: number | null = null

  private constructor(server: Server) {
    this.server = server
  }

  static async start(): Promise<FakeSupervisor> {
    let instance: FakeSupervisor

    const server = createServer((req, res) => {
      instance.handle(req, res)
    })

    instance = new FakeSupervisor(server)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })

    return instance
  }

  get baseUrl(): string {
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('FakeSupervisor is not listening on a port')
    }
    return `http://127.0.0.1:${address.port}`
  }

  get discoveries(): DiscoveryRecord[] {
    return this.records
  }

  private handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    this.requests.push({ method: req.method ?? 'GET', path })

    if (this.failWith !== null) {
      res.writeHead(this.failWith, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result: 'error' }))
      return
    }

    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end()
      return
    }

    const json = (status: number, data: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    if (req.method === 'GET' && path === '/addons/self/info') {
      json(200, { result: 'ok', data: { hostname: this.addonHostname, version: '0.2.0' } })
      return
    }

    if (req.method === 'GET' && path === '/discovery') {
      json(200, { result: 'ok', data: { discovery: this.records } })
      return
    }

    if (req.method === 'DELETE' && path.startsWith('/discovery/')) {
      const uuid = path.slice('/discovery/'.length)
      this.records = this.records.filter((r) => r.uuid !== uuid)
      json(200, { result: 'ok' })
      return
    }

    if (req.method === 'POST' && path === '/discovery') {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        const body = JSON.parse(raw) as { service: string; config: Record<string, unknown> }
        const uuid = `uuid-${this.nextUuid++}`
        this.records.push({
          uuid,
          addon: 'local_ha_guest_portal',
          service: body.service,
          config: body.config,
        })
        json(200, { result: 'ok', data: { uuid } })
      })
      return
    }

    res.writeHead(404).end()
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }
}
