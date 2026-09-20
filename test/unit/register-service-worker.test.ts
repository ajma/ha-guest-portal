import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerServiceWorker } from '../../src/web/registerServiceWorker.ts'

/**
 * Registration is a progressive enhancement. Every branch here is really the
 * same assertion from a different angle: whatever the browser does with
 * `register()`, boot must survive it.
 */
describe('registerServiceWorker', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('registers when the browser supports it', () => {
    const register = vi.fn().mockResolvedValue({})
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    registerServiceWorker()

    expect(register).toHaveBeenCalledWith('/sw.js')
  })

  it('does nothing when the browser has no service worker support', () => {
    // Safari in a private window, and any insecure context. Must not throw.
    //
    // Honest note on what this does and does not pin: it pins the contract
    // callers depend on, not the `in navigator` line. Deleting that line leaves
    // this green, because `{}.serviceWorker.register` throws a TypeError that
    // the implementation's try/catch then swallows — the two are behaviourally
    // indistinguishable from outside, so no test can tell them apart. The
    // explicit check stays because "unsupported" is a condition to test for,
    // not an exception to catch.
    vi.stubGlobal('navigator', {})

    expect(() => {
      registerServiceWorker()
    }).not.toThrow()
  })

  it('swallows a failed registration rather than breaking boot', async () => {
    // Registration is a progressive enhancement. An insecure context rejects
    // here, and the app must still start.
    //
    // The listener is the whole test. Asserting only that `register` was
    // called is green against `void navigator.serviceWorker.register(...)`
    // with no handler at all — measured, not assumed: vitest does not fail
    // this run on the resulting unhandled rejection. So watch for it directly.
    //
    // And a hand-rolled stub rather than `vi.fn().mockRejectedValue()`: the
    // spy attaches its own continuation to the returned promise so it can
    // record a settled result, which marks the rejection handled and hides
    // exactly the defect this test exists to catch. Measured too — with the
    // spy, the no-`.catch()` mutant survives.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      let calls = 0
      const register = (): Promise<never> => {
        calls += 1
        return Promise.reject(new Error('insecure context'))
      }
      vi.stubGlobal('navigator', { serviceWorker: { register } })

      registerServiceWorker()

      // A macrotask, not just a microtask drain: Node decides a rejection is
      // unhandled only after the current turn's microtask checkpoint, so
      // awaiting promises alone would sample before the verdict is in.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(calls).toBe(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('does not throw when register() throws synchronously', () => {
    // Not hypothetical: a browser with a disabled-by-policy worker registry can
    // throw out of `register` rather than returning a rejected promise. The
    // `.catch()` in the implementation only covers the rejected-promise case,
    // so without a surrounding try this would take the whole module down —
    // and `main.tsx` calls it after `createRoot().render()`, meaning a throw
    // here surfaces as an error in the console of an app that otherwise looks
    // fine, on exactly the browsers we cannot test.
    const register = vi.fn().mockImplementation(() => {
      throw new Error('service workers are disabled')
    })
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    expect(() => {
      registerServiceWorker()
    }).not.toThrow()
  })
})
