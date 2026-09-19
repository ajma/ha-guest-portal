import type { CatalogEntry } from '../../shared/api.js'
import type { DeviceAction, SupportedDomain } from '../../shared/devices.js'
import type { Config } from '../config.js'
import { fetchCatalog } from './catalog.js'
import { HaConnection } from './connection.js'
import { type CachedState, StateCache, type StateChangeListener } from './states.js'

export type ActionResult = { ok: true } | { ok: false; status: number; message: string }

export class HaClient {
  private conn: HaConnection
  private cache: StateCache
  private baseUrl: string
  private token: string
  private started = false
  private listenerUnsubscribers: Array<() => void> = []

  private constructor(conn: HaConnection, cache: StateCache, baseUrl: string, token: string) {
    this.conn = conn
    this.cache = cache
    this.baseUrl = baseUrl
    this.token = token
  }

  static create(cfg: Pick<Config, 'haBaseUrl' | 'haToken'>): HaClient {
    const conn = new HaConnection({
      baseUrl: cfg.haBaseUrl,
      token: cfg.haToken,
    })

    const cache = new StateCache(conn)

    return new HaClient(conn, cache, cfg.haBaseUrl, cfg.haToken)
  }

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    this.conn.start()
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }
    this.started = false

    // Unregister all listeners
    for (const unsubscribe of this.listenerUnsubscribers) {
      unsubscribe()
    }
    this.listenerUnsubscribers = []

    try {
      await this.conn.stop()
    } catch {
      // Suppress all errors during stop - if the connection was never established,
      // there are no handles to clean up anyway. stop() must be idempotent.
    }
  }

  get stale(): boolean {
    return this.cache.stale
  }

  async getCatalog(): Promise<CatalogEntry[]> {
    return fetchCatalog(this.conn)
  }

  getStates(): ReadonlyMap<string, Readonly<CachedState>> {
    return this.cache.all()
  }

  async setWatchedEntities(ids: string[]): Promise<void> {
    return this.cache.setEntityIds(ids)
  }

  async callAction(
    domain: SupportedDomain,
    service: DeviceAction,
    entityId: string,
  ): Promise<ActionResult> {
    const url = `${this.baseUrl}/api/services/${domain}/${service}`

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ entity_id: entityId }),
        signal: AbortSignal.timeout(10000),
      })

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: `Service call failed with status ${response.status}`,
        }
      }

      return { ok: true }
    } catch (error) {
      // Network-level failure or timeout
      let message = 'Network error'
      if (error instanceof Error) {
        // Strip token from error message to prevent leakage
        message = error.message.replaceAll(this.token, '[REDACTED]')
      }

      return {
        ok: false,
        status: 503,
        message,
      }
    }
  }

  onChange(fn: StateChangeListener): () => void {
    const unsubscribe = this.cache.onChange(fn)
    this.listenerUnsubscribers.push(unsubscribe)
    return unsubscribe
  }

  onStaleChange(fn: (stale: boolean) => void): () => void {
    const unsubscribe = this.cache.onStaleChange(fn)
    this.listenerUnsubscribers.push(unsubscribe)
    return unsubscribe
  }
}
