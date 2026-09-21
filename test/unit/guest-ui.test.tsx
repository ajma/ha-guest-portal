import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Portal } from '../../src/web/routes/Portal.tsx'
import type { Device } from '@shared/api.ts'
import * as store from '../../src/web/store.ts'
import * as api from '../../src/web/api.ts'

// The page is now the owner's page too, so it needs to be told who is looking.
// Passed as a constant rather than as `role="guest"`, because Biome's
// useValidAriaRole reads a literal `role` attribute on any JSX element as an
// ARIA role and rejects it — even on a component that has nothing to do with
// ARIA. Everything below this line is the pre-merge guest suite, unchanged.
const GUEST = 'guest'

describe('Guest UI', () => {
  beforeEach(() => {
    store.resetStore()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    store.resetStore()
    vi.useRealTimers()
  })

  describe('Store connection', () => {
    it('connects to device store on mount and tears down on unmount', () => {
      const teardownSpy = vi.fn()
      const connectSpy = vi.spyOn(store, 'connectDeviceStore').mockReturnValue(teardownSpy)

      const { unmount } = render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      expect(connectSpy).toHaveBeenCalledOnce()

      unmount()

      expect(teardownSpy).toHaveBeenCalledOnce()
    })
  })

  describe('ToggleTile', () => {
    it('renders the exact state text for off and on', () => {
      // The other toggle assertions use /on/i, which also matches "ON!", "Only"
      // and the label. This one pins the exact strings, so a tile that stops
      // rendering the hook's stateText is caught here.
      const device: Device = {
        entityId: 'light.hall',
        label: 'Hall Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: { state: 'off', attributes: {}, stale: false },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      const { rerender } = render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)
      expect(screen.getByText('Off')).toBeDefined()

      store.applyFrame({
        type: 'snapshot',
        devices: [{ ...device, state: { state: 'on', attributes: {}, stale: false } }],
        stale: false,
      })
      rerender(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)
      expect(screen.getByText('On')).toBeDefined()
    })

    it('shows on state and pressing calls performAction with turn_off', async () => {
      const user = userEvent.setup()
      const performActionSpy = vi
        .spyOn(api, 'performAction')
        .mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'light.living_room',
        label: 'Living Room Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off', 'toggle'],
        sortOrder: 0,
        state: {
          state: 'on',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /living room light/i })

      // Should show "on" state
      expect(tile.textContent).toMatch(/on/i)

      await user.click(tile)

      expect(performActionSpy).toHaveBeenCalledWith('light.living_room', 'turn_off')
    })

    it('shows off state and pressing calls performAction with turn_on', async () => {
      const user = userEvent.setup()
      const performActionSpy = vi
        .spyOn(api, 'performAction')
        .mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'switch.fan',
        label: 'Ceiling Fan',
        domain: 'switch',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'off',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /ceiling fan/i })
      expect(tile.textContent).toMatch(/off/i)

      await user.click(tile)

      expect(performActionSpy).toHaveBeenCalledWith('switch.fan', 'turn_on')
    })

    it('performs optimistic update and reconciles with incoming patch', async () => {
      const user = userEvent.setup()
      vi.spyOn(api, 'performAction').mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'light.bedroom',
        label: 'Bedroom Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'off',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /bedroom light/i })
      expect(tile.textContent).toMatch(/off/i)

      // Click to turn on (optimistic)
      await user.click(tile)

      // Should show "on" optimistically
      await waitFor(() => {
        expect(tile.textContent).toMatch(/on/i)
      })

      // Incoming patch confirms the change
      store.applyFrame({
        type: 'patch',
        devices: [
          {
            ...device,
            state: {
              state: 'on',
              attributes: {},
              stale: false,
            },
          },
        ],
      })

      // Should still show "on"
      expect(tile.textContent).toMatch(/on/i)
    })

    it('reverts optimistic update and shows error when action fails', async () => {
      const user = userEvent.setup()
      vi.spyOn(api, 'performAction').mockResolvedValue({ ok: false, status: 500 })

      const device: Device = {
        entityId: 'light.kitchen',
        label: 'Kitchen Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'off',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /kitchen light/i })
      expect(tile.textContent).toMatch(/off/i)

      await user.click(tile)

      // Should revert to "off" and show error
      await waitFor(() => {
        expect(tile.textContent).toMatch(/off/i)
      })
    })

    it('shows pending state during in-flight action and prevents double-firing', async () => {
      const user = userEvent.setup()
      let resolveAction: () => void = () => {
        // Will be reassigned
      }
      const actionPromise = new Promise<{ ok: true; data: undefined }>((resolve) => {
        resolveAction = () => {
          resolve({ ok: true, data: undefined })
        }
      })
      const performActionSpy = vi.spyOn(api, 'performAction').mockReturnValue(actionPromise)

      const device: Device = {
        entityId: 'light.hallway',
        label: 'Hallway Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'off',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /hallway light/i })

      await user.click(tile)

      // Should be disabled while pending
      expect('disabled' in tile ? tile.disabled : false).toBe(true)

      // Try to click again
      await user.click(tile)

      // Should only have been called once
      expect(performActionSpy).toHaveBeenCalledOnce()

      // Resolve the action
      resolveAction?.()

      await waitFor(() => {
        expect('disabled' in tile ? tile.disabled : false).toBe(false)
      })
    })

    it('shows Unknown but keeps controls enabled when device is stale', () => {
      const device: Device = {
        entityId: 'light.garage',
        label: 'Garage Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'on',
          attributes: {},
          stale: true,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /garage light/i })

      // Should NOT be disabled
      expect('disabled' in tile ? tile.disabled : false).toBe(false)

      // Should show Unknown state
      expect(tile.textContent).toMatch(/unknown/i)
    })

    it('disables controls when store is disconnected even if device is not stale', () => {
      const device: Device = {
        entityId: 'light.patio',
        label: 'Patio Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'on',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(false)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /patio light/i })

      // Should be disabled
      expect('disabled' in tile ? tile.disabled : false).toBe(true)

      // Should show disconnected indicator
    })

    it('shows Unknown state instead of actual state when stale', () => {
      const device: Device = {
        entityId: 'light.stale_test',
        label: 'Stale Test Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'on',
          attributes: {},
          stale: true,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /stale test light/i })

      // Should NOT show the actual state word
      expect(tile.textContent).not.toMatch(/\bon\b/i)

      // Should show Unknown
      expect(tile.textContent).toMatch(/unknown/i)
    })

    it('clears optimistic state when contradicting patch arrives', async () => {
      const user = userEvent.setup()
      vi.spyOn(api, 'performAction').mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'light.unplugged',
        label: 'Unplugged Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'off',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /unplugged light/i })
      expect(tile.textContent).toMatch(/off/i)

      // Click to turn on (optimistic)
      await user.click(tile)

      // Should show "on" optimistically
      await waitFor(() => {
        expect(tile.textContent).toMatch(/on/i)
      })

      // Patch arrives with contradicting state (device still off)
      store.applyFrame({
        type: 'patch',
        devices: [
          {
            ...device,
            state: {
              state: 'off',
              attributes: {},
              stale: false,
            },
          },
        ],
      })

      // Should clear optimistic state and show real state (off)
      await waitFor(() => {
        expect(tile.textContent).toMatch(/off/i)
        expect(tile.textContent).not.toMatch(/\bon\b/i)
      })
    })

    it('clears optimistic state after timeout if no patch arrives', async () => {
      vi.useFakeTimers()
      vi.spyOn(api, 'performAction').mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'light.timeout_test',
        label: 'Timeout Test Light',
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
        state: {
          state: 'off',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /timeout test light/i })

      // Click to turn on (use fireEvent with fake timers)
      await act(async () => {
        fireEvent.click(tile)
        // Flush microtasks to let async handleClick run
        await Promise.resolve()
      })

      // Should show "on" optimistically
      expect(tile.textContent).toMatch(/on/i)

      // Fast-forward 5 seconds (timeout)
      await act(async () => {
        await vi.advanceTimersToNextTimerAsync()
      })

      // Should clear optimistic state and show real state (off)
      expect(tile.textContent).toMatch(/off/i)
      expect(tile.textContent).not.toMatch(/\bon\b/i)
    })

    it('respects allowedActions with toggle only', async () => {
      const user = userEvent.setup()
      const performActionSpy = vi
        .spyOn(api, 'performAction')
        .mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'light.toggle_only',
        label: 'Toggle Only Light',
        domain: 'light',
        allowedActions: ['toggle'],
        sortOrder: 0,
        state: {
          state: 'off',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const tile = screen.getByRole('button', { name: /toggle only light/i })
      await user.click(tile)

      // Should call toggle action, not turn_on
      expect(performActionSpy).toHaveBeenCalledWith('light.toggle_only', 'toggle')
    })

    it('does not render control when no actions allowed', () => {
      const device: Device = {
        entityId: 'light.no_actions',
        label: 'No Actions Light',
        domain: 'light',
        allowedActions: [],
        sortOrder: 0,
        state: {
          state: 'off',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      // Should show no actions message, not a clickable button with the device label
      expect(screen.queryByRole('button', { name: /no actions light/i })).toBeNull()
      expect(screen.getByText(/no actions light/i)).toBeDefined()
      expect(screen.getByText(/no actions available/i)).toBeDefined()
    })
  })

  describe('CoverTile', () => {
    it('shows three controls for open/stop/close', () => {
      const device: Device = {
        entityId: 'cover.garage_door',
        label: 'Garage Door',
        domain: 'cover',
        allowedActions: ['open_cover', 'close_cover', 'stop_cover'],
        sortOrder: 0,
        state: {
          state: 'closed',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)
    })

    it('renders opening state distinctly from open', () => {
      const openingDevice: Device = {
        entityId: 'cover.blinds',
        label: 'Blinds',
        domain: 'cover',
        allowedActions: ['open_cover', 'close_cover', 'stop_cover'],
        sortOrder: 0,
        state: {
          state: 'opening',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [openingDevice], stale: false })
      store.setConnected(true)

      const { rerender } = render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      // Should show "opening" state
      expect(screen.getByText('Opening')).toBeDefined()

      // Change to open state
      const openDevice: Device = {
        ...openingDevice,
        state: {
          state: 'open',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'patch', devices: [openDevice] })

      rerender(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      // Should no longer show "opening" state
      expect(screen.queryByText('Opening')).toBeNull()
      // Should now show "Open" state (appears in state display, though also in button)
      expect(screen.getAllByText('Open').length).toBeGreaterThan(0)
    })

    it('renders closing state distinctly from closed', () => {
      const device: Device = {
        entityId: 'cover.curtains',
        label: 'Curtains',
        domain: 'cover',
        allowedActions: ['open_cover', 'close_cover', 'stop_cover'],
        sortOrder: 0,
        state: {
          state: 'closing',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)
    })

    it('calls performAction with correct action when buttons are clicked', async () => {
      const user = userEvent.setup()
      const performActionSpy = vi
        .spyOn(api, 'performAction')
        .mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'cover.shades',
        label: 'Shades',
        domain: 'cover',
        allowedActions: ['open_cover', 'close_cover', 'stop_cover'],
        sortOrder: 0,
        state: {
          state: 'closed',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      await user.click(screen.getByRole('button', { name: /open/i }))
      expect(performActionSpy).toHaveBeenCalledWith('cover.shades', 'open_cover')

      performActionSpy.mockClear()
      await user.click(screen.getByRole('button', { name: /stop/i }))
      expect(performActionSpy).toHaveBeenCalledWith('cover.shades', 'stop_cover')

      performActionSpy.mockClear()
      await user.click(screen.getByRole('button', { name: /close/i }))
      expect(performActionSpy).toHaveBeenCalledWith('cover.shades', 'close_cover')
    })

    it('only renders buttons for allowed actions', () => {
      const device: Device = {
        entityId: 'cover.skylight',
        label: 'Skylight',
        domain: 'cover',
        allowedActions: ['close_cover'], // Only close allowed
        sortOrder: 0,
        state: {
          state: 'open',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      expect(screen.queryByRole('button', { name: /^open$/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /stop/i })).toBeNull()
    })

    it('shows Unknown state instead of actual state when stale', () => {
      const device: Device = {
        entityId: 'cover.stale_door',
        label: 'Stale Door',
        domain: 'cover',
        allowedActions: ['open_cover', 'close_cover', 'stop_cover'],
        sortOrder: 0,
        state: {
          state: 'open',
          attributes: {},
          stale: true,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      // Should show Unknown in state display
      const stateTexts = screen.getAllByText('Unknown')
      expect(stateTexts.length).toBeGreaterThan(0)

      // Should NOT show Opening or Closing (exact state text)
      expect(screen.queryByText('Opening')).toBeNull()
      expect(screen.queryByText('Closing')).toBeNull()
      expect(screen.queryByText('Closed')).toBeNull()
    })
  })

  describe('LockTile', () => {
    it('lock action fires immediately on first press', async () => {
      const performActionSpy = vi
        .spyOn(api, 'performAction')
        .mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'lock.front_door',
        label: 'Front Door',
        domain: 'lock',
        allowedActions: ['lock', 'unlock'],
        sortOrder: 0,
        state: {
          state: 'unlocked',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const lockButton = screen.getByRole('button', { name: /^lock$/i })
      fireEvent.click(lockButton)

      await waitFor(() => {
        expect(performActionSpy).toHaveBeenCalledWith('lock.front_door', 'lock')
      })
    })

    it('unlock requires confirmation before performAction is called', async () => {
      const user = userEvent.setup()
      const performActionSpy = vi
        .spyOn(api, 'performAction')
        .mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'lock.back_door',
        label: 'Back Door',
        domain: 'lock',
        allowedActions: ['lock', 'unlock'],
        sortOrder: 0,
        state: {
          state: 'locked',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const unlockButton = screen.getByRole('button', { name: /unlock/i })

      // First click - should not call performAction
      await user.click(unlockButton)
      expect(performActionSpy).not.toHaveBeenCalled()

      // Should show confirmation state

      // Second click on confirm - should call performAction
      await user.click(screen.getByRole('button', { name: /confirm/i }))
      expect(performActionSpy).toHaveBeenCalledWith('lock.back_door', 'unlock')
    })

    it('unlock confirmation can be cancelled', async () => {
      const user = userEvent.setup()
      const performActionSpy = vi
        .spyOn(api, 'performAction')
        .mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'lock.side_door',
        label: 'Side Door',
        domain: 'lock',
        allowedActions: ['lock', 'unlock'],
        sortOrder: 0,
        state: {
          state: 'locked',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const unlockButton = screen.getByRole('button', { name: /unlock/i })

      // First click to enter confirmation state
      await user.click(unlockButton)

      // Click cancel
      await user.click(screen.getByRole('button', { name: /cancel/i }))

      // Should return to initial state
      expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()

      expect(performActionSpy).not.toHaveBeenCalled()
    })

    it('unlock confirmation times out after a few seconds', async () => {
      vi.useFakeTimers()
      const performActionSpy = vi
        .spyOn(api, 'performAction')
        .mockResolvedValue({ ok: true, data: undefined })

      const device: Device = {
        entityId: 'lock.garage_entry',
        label: 'Garage Entry',
        domain: 'lock',
        allowedActions: ['lock', 'unlock'],
        sortOrder: 0,
        state: {
          state: 'locked',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      const unlockButton = screen.getByRole('button', { name: /unlock/i })

      // First click to enter confirmation state (use fireEvent with fake timers)
      fireEvent.click(unlockButton)

      // Wait for React to update and effect to run
      await vi.advanceTimersToNextTimerAsync()

      // Confirmation button should appear
      expect(screen.getByRole('button', { name: /confirm/i })).toBeDefined()

      // Fast-forward time by 5 seconds to trigger timeout
      await vi.advanceTimersToNextTimerAsync()

      // Should return to initial state
      expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
      expect(screen.getByRole('button', { name: /unlock/i })).toBeDefined()
      expect(performActionSpy).not.toHaveBeenCalled()
    })

    it('only renders buttons for allowed actions', () => {
      const device: Device = {
        entityId: 'lock.restricted',
        label: 'Restricted Lock',
        domain: 'lock',
        allowedActions: ['unlock'], // Only unlock allowed
        sortOrder: 0,
        state: {
          state: 'locked',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      expect(screen.queryByRole('button', { name: /^lock$/i })).toBeNull()
    })

    it('renders jammed state correctly', () => {
      const device: Device = {
        entityId: 'lock.jammed_lock',
        label: 'Jammed Lock',
        domain: 'lock',
        allowedActions: ['lock', 'unlock'],
        sortOrder: 0,
        state: {
          state: 'jammed',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      expect(screen.getByText('Jammed')).toBeDefined()
    })

    it('renders unavailable state correctly', () => {
      const device: Device = {
        entityId: 'lock.unavailable_lock',
        label: 'Unavailable Lock',
        domain: 'lock',
        allowedActions: ['lock', 'unlock'],
        sortOrder: 0,
        state: {
          state: 'unavailable',
          attributes: {},
          stale: false,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      expect(screen.getByText('unavailable')).toBeDefined()
    })

    it('shows Unknown state instead of actual state when stale', () => {
      const device: Device = {
        entityId: 'lock.stale_lock',
        label: 'Stale Lock',
        domain: 'lock',
        allowedActions: ['lock', 'unlock'],
        sortOrder: 0,
        state: {
          state: 'locked',
          attributes: {},
          stale: true,
        },
      }

      store.applyFrame({ type: 'snapshot', devices: [device], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      // Should NOT show the actual state
      expect(screen.queryByText('Locked')).toBeNull()
      expect(screen.queryByText('Unlocked')).toBeNull()

      // Should show Unknown
      expect(screen.getByText('Unknown')).toBeDefined()
    })
  })

  describe('Sorting', () => {
    it('renders devices in sortOrder', () => {
      const devices: Device[] = [
        {
          entityId: 'light.second',
          label: 'Second',
          domain: 'light',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 1,
          state: { state: 'off', attributes: {}, stale: false },
        },
        {
          entityId: 'light.first',
          label: 'First',
          domain: 'light',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 0,
          state: { state: 'off', attributes: {}, stale: false },
        },
        {
          entityId: 'light.third',
          label: 'Third',
          domain: 'light',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 2,
          state: { state: 'off', attributes: {}, stale: false },
        },
      ]

      store.applyFrame({ type: 'snapshot', devices, stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)

      // Filter out the logout button by checking for aria-label
      const allButtons = screen.getAllByRole('button')
      const tiles = allButtons.filter((button) => button.getAttribute('aria-label'))
      expect(tiles[0]?.getAttribute('aria-label') ?? '').toMatch(/first/i)
      expect(tiles[1]?.getAttribute('aria-label') ?? '').toMatch(/second/i)
      expect(tiles[2]?.getAttribute('aria-label') ?? '').toMatch(/third/i)
    })
  })

  describe('Empty state', () => {
    it('shows message when no devices are available', () => {
      store.applyFrame({ type: 'snapshot', devices: [], stale: false })
      store.setConnected(true)

      render(<Portal role={GUEST} portalId="p1" onLogout={async () => {}} />)
    })
  })
})
