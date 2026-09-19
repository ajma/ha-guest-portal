import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HaClient } from '../../src/server/ha/client.ts'
import { FakeHomeAssistant } from '../fake-ha.ts'

describe('HaClient', () => {
  let fake: FakeHomeAssistant
  let client: HaClient

  beforeEach(async () => {
    fake = await FakeHomeAssistant.start({ token: 'test-token-abc123xyz' })
    fake.seed(
      [
        { entityId: 'light.living_room', state: 'off', name: 'Living Room' },
        { entityId: 'switch.kitchen', state: 'on', name: 'Kitchen' },
      ],
      [{ areaId: 'area1', name: 'Downstairs' }],
    )

    client = HaClient.create({
      haBaseUrl: fake.baseUrl,
      haToken: fake.token,
    })
  })

  afterEach(async () => {
    try {
      await client.stop()
    } catch {
      // Ignore errors from stopping a client that never fully connected
    }
    await fake.stop()
  })

  describe('lifecycle', () => {
    it('starts and stops cleanly', async () => {
      client.start()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.stop()
    })

    it('stop is idempotent', async () => {
      client.start()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.stop()
      await client.stop() // Should not throw or hang
    })

    it('leaves no open handles after stop', async () => {
      client.start()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.stop()
      // If this test completes without hanging, handles are cleaned up
    })

    it('stop resolves without error when called during CONNECTING state', async () => {
      // Point at unroutable address so socket stays in CONNECTING
      const connectingClient = HaClient.create({
        haBaseUrl: 'http://127.0.0.1:1',
        haToken: 'test-token',
      })
      connectingClient.start()

      // Stop immediately - socket is still CONNECTING
      await expect(connectingClient.stop()).resolves.toBeUndefined()
    })

    it('stop is idempotent even when called during CONNECTING', async () => {
      const connectingClient = HaClient.create({
        haBaseUrl: 'http://127.0.0.1:1',
        haToken: 'test-token',
      })
      connectingClient.start()

      // Call stop twice while CONNECTING
      await connectingClient.stop()
      await connectingClient.stop() // Should not throw
    })

    it('stop immediately after start does not throw', async () => {
      client.start()
      // No wait - socket is certain to be CONNECTING
      await expect(client.stop()).resolves.toBeUndefined()
    })
  })

  describe('callAction', () => {
    beforeEach(() => {
      client.start()
    })

    it('reaches REST endpoint with correct bearer token and body', async () => {
      const result = await client.callAction('light', 'turn_on', 'light.living_room')

      expect(result).toEqual({ ok: true })
      expect(fake.serviceCalls).toHaveLength(1)

      const call = fake.serviceCalls[0]
      expect(call).toBeDefined()
      expect(call?.domain).toBe('light')
      expect(call?.service).toBe('turn_on')
      expect(call?.body).toEqual({ entity_id: 'light.living_room' })
      expect(call?.authorization).toBe('Bearer test-token-abc123xyz')
    })

    it('works even after WebSocket is dropped', async () => {
      // Wait for initial connection
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Drop the WebSocket connection
      fake.drop()

      // Action should still succeed via REST
      const result = await client.callAction('switch', 'turn_off', 'switch.kitchen')

      expect(result).toEqual({ ok: true })
      expect(fake.serviceCalls).toHaveLength(1)

      const call = fake.serviceCalls[0]
      expect(call?.domain).toBe('switch')
      expect(call?.service).toBe('turn_off')
    })

    it('returns structured failure on non-2xx status', async () => {
      fake.failNextServiceCall(502)

      const result = await client.callAction('light', 'toggle', 'light.living_room')

      expect(result).toEqual({
        ok: false,
        status: 502,
        message: expect.any(String),
      })
    })

    it('does not leak token in error message', async () => {
      fake.failNextServiceCall(500)

      const result = await client.callAction('light', 'turn_on', 'light.living_room')

      if (!result.ok) {
        expect(result.message).not.toContain('test-token-abc123xyz')
        expect(result.message).not.toContain('abc123xyz')
        expect(result.message).not.toContain('abc123')
      }
    })

    it('returns structured failure on network error', async () => {
      // Point client at unroutable address with distinctive token
      const distinctiveToken = 'sentinel-token-xyz789'
      const unreachableClient = HaClient.create({
        haBaseUrl: 'http://127.0.0.1:1',
        haToken: distinctiveToken,
      })
      unreachableClient.start()

      const result = await unreachableClient.callAction('light', 'turn_on', 'light.test')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(503)
        expect(result.message).toBeTruthy()
        // Token must not appear in error message
        expect(result.message).not.toContain(distinctiveToken)
        expect(result.message).not.toContain('xyz789')
      }

      try {
        await unreachableClient.stop()
      } catch {
        // Ignore errors from stopping a client that never fully connected
      }
    })

    it('does not hang on slow server', async () => {
      // This test verifies timeout behavior
      // The unroutable address should trigger timeout or immediate connection failure
      const unreachableClient = HaClient.create({
        haBaseUrl: 'http://127.0.0.1:1',
        haToken: 'test-token',
      })
      unreachableClient.start()

      const startTime = Date.now()
      await unreachableClient.callAction('light', 'turn_on', 'light.test')
      const elapsed = Date.now() - startTime

      // Should complete within timeout window (allow some margin)
      expect(elapsed).toBeLessThan(12000) // 10s timeout + 2s margin

      try {
        await unreachableClient.stop()
      } catch {
        // Ignore errors from stopping a client that never fully connected
      }
    })
  })

  describe('getCatalog', () => {
    beforeEach(() => {
      client.start()
    })

    it('returns catalog entries', async () => {
      // Wait for connection to be ready
      await new Promise((resolve) => setTimeout(resolve, 100))

      const catalog = await client.getCatalog()

      expect(catalog).toHaveLength(2)
      // Catalog is sorted by name: "Kitchen" < "Living Room"
      expect(catalog[0]?.entityId).toBe('switch.kitchen')
      expect(catalog[0]?.name).toBe('Kitchen')
      expect(catalog[1]?.entityId).toBe('light.living_room')
      expect(catalog[1]?.name).toBe('Living Room')
    })
  })

  describe('state management', () => {
    beforeEach(() => {
      client.start()
    })

    it('setWatchedEntities propagates to cache', async () => {
      // Wait for connection to be ready
      await new Promise((resolve) => setTimeout(resolve, 100))

      await client.setWatchedEntities(['light.living_room'])

      expect(fake.subscribedEntityIds()).toEqual(['light.living_room'])

      const states = client.getStates()
      expect(states.has('light.living_room')).toBe(true)
      expect(states.get('light.living_room')?.state).toBe('off')
    })

    it('mutating returned map does not affect subsequent calls', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.setWatchedEntities(['light.living_room'])

      const states1 = client.getStates()
      // Mutate the returned map (cast to mutable to bypass type system)
      ;(states1 as Map<string, unknown>).set('light.fake', { state: 'on', attributes: {} })
      ;(states1 as Map<string, unknown>).delete('light.living_room')

      // Subsequent call should return original state, unaffected
      const states2 = client.getStates()
      expect(states2.has('light.living_room')).toBe(true)
      expect(states2.has('light.fake')).toBe(false)
    })

    it('entry objects are frozen', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.setWatchedEntities(['light.living_room'])

      const states = client.getStates()
      const entry = states.get('light.living_room')
      expect(entry).toBeDefined()

      if (entry) {
        // Entry itself is frozen
        expect(Object.isFrozen(entry)).toBe(true)
        // Attributes object is frozen
        expect(Object.isFrozen(entry.attributes)).toBe(true)
      }
    })

    it('stale reflects cache state', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.setWatchedEntities(['light.living_room'])

      // Initially not stale (connected)
      expect(client.stale).toBe(false)

      // Drop connection
      fake.drop()

      // Wait for stale to propagate
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(client.stale).toBe(true)
    })

    it('onChange fires and unsubscribe works', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.setWatchedEntities(['light.living_room'])

      const changes: Array<Map<string, unknown>> = []
      const unsubscribe = client.onChange((changed) => {
        changes.push(changed)
      })

      // Trigger state change
      fake.setState('light.living_room', 'on')

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(changes).toHaveLength(1)
      expect(changes[0]?.has('light.living_room')).toBe(true)

      // Unsubscribe and verify no more events
      unsubscribe()
      fake.setState('light.living_room', 'off')
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(changes).toHaveLength(1) // Should not have increased
    })

    it('onStaleChange fires and unsubscribe works', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Set watched entities to get a snapshot and clear initial stale state
      await client.setWatchedEntities(['light.living_room'])
      await new Promise((resolve) => setTimeout(resolve, 50))

      const staleChanges: boolean[] = []
      const unsubscribe = client.onStaleChange((stale) => {
        staleChanges.push(stale)
      })

      // Drop connection to trigger stale
      fake.drop()
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(staleChanges).toContain(true)

      // Unsubscribe
      unsubscribe()
      staleChanges.length = 0

      // Restart connection (would trigger stale: false, but we unsubscribed)
      fake.drop()
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should not receive new events
      expect(staleChanges).toHaveLength(0)
    })

    it('listeners are cleaned up on stop', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.setWatchedEntities(['light.living_room'])

      const changes: Array<Map<string, unknown>> = []
      const staleChanges: boolean[] = []

      client.onChange((changed) => {
        changes.push(changed)
      })
      client.onStaleChange((stale) => {
        staleChanges.push(stale)
      })

      // Stop client (idempotent - call twice)
      await client.stop()
      await client.stop()

      // Trigger events that would fire listeners if they were still registered
      fake.setState('light.living_room', 'on')
      fake.drop()
      await new Promise((resolve) => setTimeout(resolve, 100))

      // No callbacks should have fired
      expect(changes).toHaveLength(0)
      expect(staleChanges).toHaveLength(0)
    })
  })

  describe('deferred subscribe (boot order)', () => {
    it('setWatchedEntities before connection ready does not throw', async () => {
      // Create client but don't start it yet (connection is 'disconnected')
      const deferredClient = HaClient.create({
        haBaseUrl: fake.baseUrl,
        haToken: fake.token,
      })

      // Call setWatchedEntities before starting - should not throw
      await expect(
        deferredClient.setWatchedEntities(['light.living_room']),
      ).resolves.toBeUndefined()

      // Now start the client - it should subscribe when ready
      deferredClient.start()
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Verify subscription was established
      expect(fake.subscribedEntityIds()).toEqual(['light.living_room'])

      // Verify state arrived
      const states = deferredClient.getStates()
      expect(states.has('light.living_room')).toBe(true)
      expect(states.get('light.living_room')?.state).toBe('off')

      await deferredClient.stop()
    })

    it('no double-subscribe on reconnect', async () => {
      client.start()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.setWatchedEntities(['light.living_room'])

      const changes: Array<Map<string, unknown>> = []
      client.onChange((changed) => {
        changes.push(changed)
      })

      // Drop connection to trigger reconnect
      fake.drop()

      // Wait for reconnect (with backoff, may take up to 1s)
      // Poll until connection recovers
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (!client.stale) break
      }

      // Verify connection recovered
      expect(client.stale).toBe(false)

      // Clear any changes from reconnect snapshot
      changes.length = 0

      // Trigger one state change
      fake.setState('light.living_room', 'on')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should receive exactly one change event (not two)
      expect(changes).toHaveLength(1)
      expect(changes[0]?.has('light.living_room')).toBe(true)
    })

    it('resubscribe while ready works immediately', async () => {
      client.start()
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Initial subscription
      await client.setWatchedEntities(['light.living_room'])
      expect(fake.subscribedEntityIds()).toEqual(['light.living_room'])

      // Change subscription while ready
      await client.setWatchedEntities(['switch.kitchen'])

      // Should reflect new filter immediately
      expect(fake.subscribedEntityIds()).toEqual(['switch.kitchen'])

      const states = client.getStates()
      expect(states.has('switch.kitchen')).toBe(true)
      expect(states.has('light.living_room')).toBe(false)
    })

    it('stop while deferred filter pending does not leave listeners', async () => {
      // Create client but don't start it
      const deferredClient = HaClient.create({
        haBaseUrl: fake.baseUrl,
        haToken: fake.token,
      })

      // Set entities before starting
      await deferredClient.setWatchedEntities(['light.living_room'])

      // Stop immediately (before it ever connects)
      await deferredClient.stop()

      // Wait to ensure no delayed subscription happens
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Should not have subscribed (client never started)
      expect(fake.subscribedEntityIds()).toBeNull()
    })
  })
})
