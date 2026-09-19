import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { FakeHomeAssistant } from '../fake-ha.ts'
import { HaConnection } from '../../src/server/ha/connection.ts'
import { StateCache } from '../../src/server/ha/states.ts'

describe('StateCache', () => {
  let fake: FakeHomeAssistant
  let conn: HaConnection
  let cache: StateCache

  beforeEach(async () => {
    fake = await FakeHomeAssistant.start()
    fake.seed(
      [
        {
          entityId: 'light.porch',
          name: 'Porch Light',
          state: 'off',
          attributes: { brightness: 0 },
        },
        {
          entityId: 'light.garage',
          name: 'Garage Light',
          state: 'on',
          attributes: { brightness: 255, color_mode: 'brightness' },
        },
      ],
      [{ areaId: 'outdoor', name: 'Outdoor' }],
    )

    conn = new HaConnection({ baseUrl: fake.baseUrl, token: fake.token })
    cache = new StateCache(conn)
  })

  afterEach(async () => {
    await conn.stop()
    await fake.stop()
  })

  test('initial snapshot populates the cache', async () => {
    conn.start()
    await waitForReady(conn)

    await cache.setEntityIds(['light.porch', 'light.garage'])

    const porch = cache.get('light.porch')
    const garage = cache.get('light.garage')

    expect(porch).toEqual({
      state: 'off',
      attributes: { brightness: 0 },
      lastUpdated: expect.any(Number),
    })

    expect(garage).toEqual({
      state: 'on',
      attributes: { brightness: 255, color_mode: 'brightness' },
      lastUpdated: expect.any(Number),
    })
  })

  test('+ with only s changes state and leaves attributes intact', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const before = cache.get('light.porch')
    expect(before?.attributes).toEqual({ brightness: 0 })

    // Change state but not attributes
    fake.setState('light.porch', 'on')
    await wait(50)

    const after = cache.get('light.porch')
    expect(after?.state).toBe('on')
    expect(after?.attributes).toEqual({ brightness: 0 }) // Attributes intact
  })

  test('+ with an a sub-key merges attributes without dropping existing ones', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.garage'])

    const before = cache.get('light.garage')
    expect(before?.attributes).toEqual({ brightness: 255, color_mode: 'brightness' })

    // Add a new attribute while keeping existing ones
    fake.setState('light.garage', 'on', {
      brightness: 255,
      color_mode: 'brightness',
      effect: 'rainbow',
    })
    await wait(50)

    const after = cache.get('light.garage')
    expect(after?.attributes).toEqual({
      brightness: 255,
      color_mode: 'brightness',
      effect: 'rainbow',
    })
  })

  test('- with a: [brightness] deletes only that attribute', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.garage'])

    const before = cache.get('light.garage')
    expect(before?.attributes).toEqual({ brightness: 255, color_mode: 'brightness' })

    // Remove brightness attribute but keep color_mode
    fake.setState('light.garage', 'on', { color_mode: 'brightness' })
    await wait(50)

    const after = cache.get('light.garage')
    expect(after?.attributes).toEqual({ color_mode: 'brightness' })
    expect(after?.attributes).not.toHaveProperty('brightness')
  })

  test('r frame removes the entity', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    expect(cache.get('light.porch')).toBeDefined()

    fake.removeEntity('light.porch')
    await wait(50)

    expect(cache.get('light.porch')).toBeUndefined()
  })

  test('c for entity with no prior snapshot is ignored', async () => {
    conn.start()
    await waitForReady(conn)

    // Subscribe to only one light
    await cache.setEntityIds(['light.porch'])

    // Verify garage is not in cache
    expect(cache.get('light.garage')).toBeUndefined()

    // Update garage (which is not in our subscription)
    fake.setState('light.garage', 'off')
    await wait(50)

    // Should still be undefined - delta ignored
    expect(cache.get('light.garage')).toBeUndefined()
    expect(cache.all().size).toBe(1)
  })

  test('drop() sets stale true, fires onStaleChange, and retains values', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    expect(cache.stale).toBe(false)

    const staleChanges: boolean[] = []
    cache.onStaleChange((stale) => {
      staleChanges.push(stale)
    })

    const before = cache.get('light.porch')
    expect(before).toBeDefined()

    fake.drop()
    await waitForDisconnected(conn)

    // Cache should be stale
    expect(cache.stale).toBe(true)
    expect(staleChanges).toEqual([true])

    // But values should be retained
    const after = cache.get('light.porch')
    expect(after).toEqual(before)
  })

  test('reconnect clears stale and replaces cache from fresh snapshot', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch', 'light.garage'])

    expect(cache.stale).toBe(false)

    fake.drop()
    await waitForDisconnected(conn)
    expect(cache.stale).toBe(true)

    const staleChanges: boolean[] = []
    cache.onStaleChange((stale) => {
      staleChanges.push(stale)
    })

    // Reconnect
    await waitForReady(conn)
    await wait(100) // Allow snapshot to be processed

    // Should no longer be stale
    expect(cache.stale).toBe(false)
    expect(staleChanges).toContain(false)

    // Cache should be refreshed
    expect(cache.get('light.porch')).toBeDefined()
    expect(cache.get('light.garage')).toBeDefined()
  })

  test('entity present before drop but absent from post-reconnect snapshot is removed', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch', 'light.garage'])

    expect(cache.get('light.porch')).toBeDefined()
    expect(cache.get('light.garage')).toBeDefined()

    fake.drop()
    await waitForDisconnected(conn)

    // Remove garage from fake HA
    fake.seed(
      [
        {
          entityId: 'light.porch',
          name: 'Porch Light',
          state: 'off',
          attributes: { brightness: 0 },
        },
      ],
      [{ areaId: 'outdoor', name: 'Outdoor' }],
    )

    await waitForReady(conn)
    await wait(100) // Allow snapshot to be processed

    // Porch should still exist, garage should be gone
    expect(cache.get('light.porch')).toBeDefined()
    expect(cache.get('light.garage')).toBeUndefined()
  })

  test('state change while disconnected is reflected after reconnect', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const before = cache.get('light.porch')
    expect(before?.state).toBe('off')

    fake.drop()
    await waitForDisconnected(conn)

    // Change state while disconnected
    fake.seed(
      [
        {
          entityId: 'light.porch',
          name: 'Porch Light',
          state: 'on',
          attributes: { brightness: 255 },
        },
      ],
      [{ areaId: 'outdoor', name: 'Outdoor' }],
    )

    await waitForReady(conn)
    await wait(100) // Allow snapshot to be processed

    const after = cache.get('light.porch')
    expect(after?.state).toBe('on')
    expect(after?.attributes).toEqual({ brightness: 255 })
  })

  test('setEntityIds causes a real resubscribe', async () => {
    conn.start()
    await waitForReady(conn)

    await cache.setEntityIds(['light.porch'])
    expect(fake.subscribedEntityIds()).toEqual(['light.porch'])

    await cache.setEntityIds(['light.porch', 'light.garage'])
    expect(fake.subscribedEntityIds()).toEqual(['light.porch', 'light.garage'])
  })

  test('setEntityIds fires onChange with the new snapshot', async () => {
    conn.start()
    await waitForReady(conn)

    const changes: Array<Map<string, unknown>> = []
    cache.onChange((changed) => {
      changes.push(new Map(changed))
    })

    await cache.setEntityIds(['light.porch', 'light.garage'])

    expect(changes.length).toBe(1)
    expect(changes[0]?.size).toBe(2)
    expect(changes[0]?.has('light.porch')).toBe(true)
    expect(changes[0]?.has('light.garage')).toBe(true)
  })

  test('onChange receives only changed entities, not the whole cache', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch', 'light.garage'])

    const changes: Array<Map<string, unknown>> = []
    cache.onChange((changed) => {
      changes.push(new Map(changed))
    })

    // Change only porch
    fake.setState('light.porch', 'on')
    await wait(50)

    expect(changes.length).toBe(1)
    expect(changes[0]?.size).toBe(1)
    expect(changes[0]?.has('light.porch')).toBe(true)
    expect(changes[0]?.has('light.garage')).toBe(false)
  })

  test('throwing listener does not prevent other listeners from running', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const calls: number[] = []

    cache.onChange(() => {
      calls.push(1)
      throw new Error('First listener throws')
    })

    cache.onChange(() => {
      calls.push(2)
    })

    cache.onChange(() => {
      calls.push(3)
    })

    fake.setState('light.porch', 'on')
    await wait(50)

    // All three listeners should have been called despite the first throwing
    expect(calls).toEqual([1, 2, 3])
  })

  test('unsubscribing a listener twice is safe', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const calls: number[] = []
    const unsubscribe = cache.onChange(() => {
      calls.push(1)
    })

    fake.setState('light.porch', 'on')
    await wait(50)
    expect(calls).toEqual([1])

    unsubscribe()
    unsubscribe() // Second call should be safe

    fake.setState('light.porch', 'off')
    await wait(50)
    expect(calls).toEqual([1]) // No new call
  })

  test('all() cannot be mutated by caller to corrupt the cache', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const snapshot = cache.all()
    // TypeScript prevents this, but test runtime behavior
    ;(snapshot as Map<string, unknown>).clear()

    // Cache should be unaffected
    expect(cache.get('light.porch')).toBeDefined()
    expect(cache.all().size).toBe(1)
  })

  test('all() returns a new Map each time', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const first = cache.all()
    const second = cache.all()

    expect(first).not.toBe(second) // Different object
    expect(first).toEqual(second) // But same content
  })

  test('lastUpdated is set from lc when present', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const state = cache.get('light.porch')
    expect(state?.lastUpdated).toBeGreaterThan(0)
  })

  test('lastUpdated is updated from lu when only attributes change', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.garage'])

    const before = cache.get('light.garage')
    const beforeTime = before?.lastUpdated

    // Change only attributes, not state (lu will be sent, not lc)
    fake.setState('light.garage', 'on', { brightness: 128, color_mode: 'brightness' })
    await wait(50)

    const after = cache.get('light.garage')
    expect(after?.lastUpdated).toBeGreaterThan(beforeTime ?? 0)
  })

  test('mutating attributes from get() does not change the cache', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const retrieved = cache.get('light.porch')
    expect(retrieved?.attributes.brightness).toBe(0)

    // Try to corrupt via mutation (should throw due to Object.freeze)
    // TypeScript prevents this, but test runtime behavior
    expect(() => {
      if (retrieved) {
        ;(retrieved.attributes as Record<string, unknown>).brightness = 999
      }
    }).toThrow(/Cannot assign to read only property/)

    // Cache should be unchanged
    const fromCache = cache.get('light.porch')
    expect(fromCache?.attributes.brightness).toBe(0)
  })

  test('mutating attributes from all() does not change the cache', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch'])

    const allStates = cache.all()
    const retrieved = allStates.get('light.porch')
    expect(retrieved?.attributes.brightness).toBe(0)

    // Try to corrupt via mutation (should throw due to Object.freeze)
    // TypeScript prevents this, but test runtime behavior
    expect(() => {
      if (retrieved) {
        ;(retrieved.attributes as Record<string, unknown>).brightness = 999
      }
    }).toThrow(/Cannot assign to read only property/)

    // Cache should be unchanged
    const fromCache = cache.get('light.porch')
    expect(fromCache?.attributes.brightness).toBe(0)
  })

  test('delete and set on all() map do not affect cache', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch', 'light.garage'])

    const allStates = cache.all()

    // Try to corrupt via map operations
    // TypeScript prevents this, but test runtime behavior
    ;(allStates as Map<string, unknown>).delete('light.porch')
    ;(allStates as Map<string, unknown>).set('light.fake', {
      state: 'fake',
      attributes: {},
      lastUpdated: 12345,
    })

    // Cache should be unchanged
    expect(cache.get('light.porch')).toBeDefined()
    expect(cache.get('light.garage')).toBeDefined()
    expect(cache.get('light.fake')).toBeUndefined()
    expect(cache.all().size).toBe(2)
  })

  test('after a merge, previously handed-out attribute object is not retroactively changed', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.garage'])

    const before = cache.get('light.garage')
    const beforeAttrs = before?.attributes
    expect(beforeAttrs).toEqual({ brightness: 255, color_mode: 'brightness' })

    // Merge in a new attribute
    fake.setState('light.garage', 'on', {
      brightness: 255,
      color_mode: 'brightness',
      effect: 'rainbow',
    })
    await wait(50)

    // The old object should NOT have been mutated
    expect(beforeAttrs).toEqual({ brightness: 255, color_mode: 'brightness' })
    expect(beforeAttrs).not.toHaveProperty('effect')

    // But the new object should have all three
    const after = cache.get('light.garage')
    expect(after?.attributes).toEqual({
      brightness: 255,
      color_mode: 'brightness',
      effect: 'rainbow',
    })
  })

  test('mixed frame (a + c) while stale does not clear stale flag', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch', 'light.garage'])

    expect(cache.stale).toBe(false)

    const staleChanges: boolean[] = []
    cache.onStaleChange((stale) => {
      staleChanges.push(stale)
    })

    // Drop connection to set stale
    fake.drop()
    await waitForDisconnected(conn)
    expect(cache.stale).toBe(true)
    expect(staleChanges).toEqual([true])

    // While stale, manually inject a mixed frame (a + c)
    // This simulates a batched event arriving during reconnect before the pure snapshot
    // Access private method via type assertion for testing
    const cacheAny = cache as unknown as {
      handleEvent: (event: { a?: Record<string, unknown>; c?: Record<string, unknown> }) => void
    }

    const mixedEvent = {
      a: {
        'light.porch': {
          s: 'on',
          a: { brightness: 100 },
          lc: Date.now() / 1000,
        },
      },
      c: {
        'light.garage': {
          '+': {
            s: 'off',
          },
        },
      },
    }

    cacheAny.handleEvent(mixedEvent)
    await wait(10)

    // Stale should STILL be true - mixed frames don't clear stale
    expect(cache.stale).toBe(true)
    // Should not have fired onStaleChange(false)
    expect(staleChanges).toEqual([true]) // Still only the initial true
  })

  test('pure snapshot (only a) while stale clears stale flag', async () => {
    conn.start()
    await waitForReady(conn)
    await cache.setEntityIds(['light.porch', 'light.garage'])

    expect(cache.stale).toBe(false)

    const staleChanges: boolean[] = []
    cache.onStaleChange((stale) => {
      staleChanges.push(stale)
    })

    // Drop connection
    fake.drop()
    await waitForDisconnected(conn)
    expect(cache.stale).toBe(true)

    // Reconnect - will get automatic pure snapshot
    await waitForReady(conn)
    await wait(100) // Allow snapshot to be processed

    // Pure snapshot should clear stale
    expect(cache.stale).toBe(false)
    expect(staleChanges).toEqual([true, false])
  })

  test('concurrent setEntityIds serializes and uses last filter', async () => {
    conn.start()
    await waitForReady(conn)

    // Fire two setEntityIds without awaiting the first
    const promise1 = cache.setEntityIds(['light.porch'])
    const promise2 = cache.setEntityIds(['light.garage'])

    // Await both
    await Promise.all([promise1, promise2])

    // Should have the second filter active
    expect(fake.subscribedEntityIds()).toEqual(['light.garage'])

    // Set up change listener
    const changes: string[] = []
    cache.onChange((changed) => {
      for (const entityId of changed.keys()) {
        changes.push(entityId)
      }
    })

    // Update an entity from the FIRST filter (not in second)
    fake.setState('light.porch', 'on')
    await wait(50)

    // Should NOT have received a change event (proves no orphaned subscription)
    expect(changes).toEqual([])

    // Update an entity from the SECOND filter
    fake.setState('light.garage', 'off')
    await wait(50)

    // Should receive this change
    expect(changes).toEqual(['light.garage'])
  })
})

function waitForReady(conn: HaConnection): Promise<void> {
  return new Promise((resolve) => {
    if (conn.status === 'ready') {
      resolve()
      return
    }
    const unsubscribe = conn.onStatus((status) => {
      if (status === 'ready') {
        unsubscribe()
        resolve()
      }
    })
  })
}

function waitForDisconnected(conn: HaConnection): Promise<void> {
  return new Promise((resolve) => {
    if (conn.status === 'disconnected') {
      resolve()
      return
    }
    const unsubscribe = conn.onStatus((status) => {
      if (status === 'disconnected') {
        unsubscribe()
        resolve()
      }
    })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
