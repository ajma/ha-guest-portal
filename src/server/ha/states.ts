import type { HaConnection } from './connection.js'
import type { EntityEvent } from './schemas.js'

export type CachedState = {
  state: string
  attributes: Record<string, unknown>
  lastUpdated: number
}

type ReadonlyCachedState = {
  readonly state: string
  readonly attributes: Readonly<Record<string, unknown>>
  readonly lastUpdated: number
}

export type StateChangeListener = (changed: Map<string, CachedState>) => void

export class StateCache {
  private cache = new Map<string, CachedState>()
  private stale_ = false
  private changeListeners = new Set<StateChangeListener>()
  private staleListeners = new Set<(stale: boolean) => void>()
  private conn: HaConnection
  private unsubscribeFromEvents: (() => Promise<void>) | null = null
  private pendingSetEntityIds: Promise<void> = Promise.resolve()
  private desiredEntityIds: string[] | null = null

  constructor(conn: HaConnection) {
    this.conn = conn

    // Listen to connection status changes (lifetime of StateCache)
    conn.onStatus((status) => {
      this.handleStatusChange(status)
    })
  }

  get stale(): boolean {
    return this.stale_
  }

  get(entityId: string): Readonly<ReadonlyCachedState> | undefined {
    return this.cache.get(entityId)
  }

  all(): ReadonlyMap<string, Readonly<ReadonlyCachedState>> {
    // Return a new Map to prevent mutation
    return new Map(this.cache)
  }

  async setEntityIds(ids: string[]): Promise<void> {
    // Serialize setEntityIds calls to prevent orphaned subscriptions
    // Chain this operation onto any pending operation
    const operation = this.pendingSetEntityIds.then(async () => {
      // Record desired entity IDs (even if not ready yet)
      this.desiredEntityIds = ids

      // Unsubscribe from old subscription
      if (this.unsubscribeFromEvents) {
        await this.unsubscribeFromEvents()
        this.unsubscribeFromEvents = null
      }

      // Subscribe only if connection is ready
      // If not ready, handleStatusChange will subscribe when it becomes ready
      if (this.conn.status === 'ready') {
        const result = await this.conn.subscribe(
          {
            type: 'subscribe_entities',
            entity_ids: ids,
          },
          (event) => {
            this.handleEvent(event)
          },
        )

        this.unsubscribeFromEvents = result.unsubscribe
      }
    })

    this.pendingSetEntityIds = operation
    return operation
  }

  onChange(fn: StateChangeListener): () => void {
    this.changeListeners.add(fn)

    let unsubscribed = false
    return () => {
      if (!unsubscribed) {
        this.changeListeners.delete(fn)
        unsubscribed = true
      }
    }
  }

  onStaleChange(fn: (stale: boolean) => void): () => void {
    this.staleListeners.add(fn)

    let unsubscribed = false
    return () => {
      if (!unsubscribed) {
        this.staleListeners.delete(fn)
        unsubscribed = true
      }
    }
  }

  private handleEvent(event: EntityEvent): void {
    const changed = new Map<string, CachedState>()

    // Handle added entities (event-level "a" means ADDED ENTITIES)
    if (event.a) {
      const addedEntities = event.a
      for (const [entityId, compressedState] of Object.entries(addedEntities)) {
        // Within compressedState, "a" means ATTRIBUTES
        const state = compressedState.s ?? ''
        const attributes = compressedState.a ?? {}
        const lastUpdated = compressedState.lc ?? compressedState.lu ?? 0

        // Freeze attributes to prevent mutation
        Object.freeze(attributes)

        const cached: CachedState = {
          state,
          attributes,
          lastUpdated,
        }

        // Freeze the state object to prevent mutation
        Object.freeze(cached)

        this.cache.set(entityId, cached)
        changed.set(entityId, cached)
      }

      // If this is a fresh snapshot (only "a" present, no "c" or "r"),
      // remove entities not in the snapshot and clear stale
      if (!event.c && !event.r) {
        const snapshotIds = new Set(Object.keys(addedEntities))
        for (const entityId of this.cache.keys()) {
          if (!snapshotIds.has(entityId)) {
            this.cache.delete(entityId)
          }
        }

        // Pure snapshot clears stale - mixed frames do not
        if (this.stale_) {
          this.stale_ = false
          this.notifyStaleListeners(false)
        }
      }
    }

    // Handle changed entities
    if (event.c) {
      const changedEntities = event.c
      for (const [entityId, delta] of Object.entries(changedEntities)) {
        const existing = this.cache.get(entityId)
        if (!existing) {
          // Never apply a delta for an entity with no snapshot yet
          continue
        }

        // Start with existing state
        let newState = existing.state
        const newAttributes = { ...existing.attributes }
        let newLastUpdated = existing.lastUpdated

        // Apply additions/updates (delta "+" contains a CompressedState)
        if (delta['+']) {
          const plus = delta['+']

          // Update state if present
          if (plus.s !== undefined) {
            newState = plus.s
          }

          // Merge attributes (within "+", "a" means ATTRIBUTES)
          if (plus.a) {
            for (const [key, value] of Object.entries(plus.a)) {
              newAttributes[key] = value
            }
          }

          // Update timestamp
          if (plus.lc !== undefined) {
            newLastUpdated = plus.lc
          } else if (plus.lu !== undefined) {
            newLastUpdated = plus.lu
          }
        }

        // Apply removals (delta "-" has "a" as an array of attribute NAMES)
        if (delta['-']?.a) {
          const attributeNamesToRemove = delta['-'].a
          for (const attrName of attributeNamesToRemove) {
            delete newAttributes[attrName]
          }
        }

        // Freeze attributes to prevent mutation
        Object.freeze(newAttributes)

        const cached: CachedState = {
          state: newState,
          attributes: newAttributes,
          lastUpdated: newLastUpdated,
        }

        // Freeze the state object to prevent mutation
        Object.freeze(cached)

        this.cache.set(entityId, cached)
        changed.set(entityId, cached)
      }
    }

    // Handle removed entities
    if (event.r) {
      for (const entityId of event.r) {
        this.cache.delete(entityId)
      }
    }

    // Notify listeners if anything changed
    if (changed.size > 0) {
      this.notifyChangeListeners(changed)
    }
  }

  private handleStatusChange(status: 'connecting' | 'ready' | 'disconnected'): void {
    if (status === 'disconnected' && !this.stale_) {
      this.stale_ = true
      this.notifyStaleListeners(true)
    }

    // If becoming ready and we have desired IDs but no active subscription, subscribe now
    // This handles the case where setEntityIds was called before the connection was ready
    // On reconnect, unsubscribeFromEvents remains set, so we won't double-subscribe
    if (
      status === 'ready' &&
      this.desiredEntityIds !== null &&
      this.unsubscribeFromEvents === null
    ) {
      // Chain onto pendingSetEntityIds to maintain serialization
      this.pendingSetEntityIds = this.pendingSetEntityIds.then(async () => {
        // Re-check conditions (they may have changed while waiting)
        if (
          this.conn.status === 'ready' &&
          this.desiredEntityIds !== null &&
          this.unsubscribeFromEvents === null
        ) {
          const result = await this.conn.subscribe(
            {
              type: 'subscribe_entities',
              entity_ids: this.desiredEntityIds,
            },
            (event) => {
              this.handleEvent(event)
            },
          )

          this.unsubscribeFromEvents = result.unsubscribe
        }
      })
    }
  }

  private notifyChangeListeners(changed: Map<string, CachedState>): void {
    for (const listener of this.changeListeners) {
      try {
        listener(changed)
      } catch {
        // Swallow errors to prevent one listener from breaking others
      }
    }
  }

  private notifyStaleListeners(stale: boolean): void {
    for (const listener of this.staleListeners) {
      try {
        listener(stale)
      } catch {
        // Swallow errors to prevent one listener from breaking others
      }
    }
  }
}
