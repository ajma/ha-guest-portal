import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CatalogEntry, Device } from '@shared/api.js'
import { Portal } from '../../src/web/routes/Portal.tsx'
import * as api from '../../src/web/api.ts'
import * as store from '../../src/web/store.ts'

vi.mock('../../src/web/api.ts')

/**
 * MIGRATION MAP — the two `admin-screen.test.tsx` cases the Task 6 audit routed
 * to "page load (Task 8)", plus the orphaned case the audit found had no home
 * anywhere in the spec:
 *
 *   4. 'orphaned row is visibly flagged'
 *        → 'flags an orphaned device in edit mode' (+ the two negative cases:
 *          a healthy device is not flagged, and nothing is flagged in normal
 *          mode — the owner-only, edit-mode-only scope Admin.tsx had)
 *   5. '500 from getAllowlist renders explanatory message'
 *        → 'says so when the orphan check fails'
 *  10. 'clicking Retry after 500 error re-calls getAllowlist'
 *        → 'retries the orphan check'
 *
 * The rest of the allowlist load Admin.tsx did on mount has no successor by
 * design: the grid comes from the SSE stream, so the only thing left to fetch is
 * `orphaned`, which the stream cannot carry.
 */

function light(entityId: string, label: string, sortOrder: number): Device {
  return {
    entityId,
    label,
    domain: 'light',
    allowedActions: ['turn_on', 'turn_off'],
    sortOrder,
    state: { state: 'off', attributes: {}, stale: false },
  }
}

const PORCH = light('light.porch', 'Porch', 0)
const KITCHEN = light('light.kitchen', 'Kitchen', 1)

const CATALOG: CatalogEntry[] = [
  {
    entityId: 'switch.heater',
    name: 'Heater',
    area: 'Hall',
    domain: 'switch',
    supported: true,
    icon: null,
  },
  {
    entityId: 'light.porch',
    name: 'Porch',
    area: 'Outside',
    domain: 'light',
    supported: true,
    icon: null,
  },
]

function seed(devices: Device[] = [PORCH, KITCHEN]): void {
  store.applyFrame({ type: 'snapshot', devices, stale: false })
  store.setConnected(true)
}

function renderPortal(role: 'admin' | 'guest'): void {
  render(<Portal role={role} onLogout={async () => {}} />)
}

/** The header's Edit button, by its accessible name — 'Done' once edit is on. */
function editButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Edit' })
}

async function enterEditMode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(editButton())
  await screen.findByRole('button', { name: 'Done' })
}

describe('Portal page', () => {
  beforeEach(() => {
    store.resetStore()
    vi.clearAllMocks()
    // The real connector opens an EventSource the test environment cannot
    // complete, and reports the stream as disconnected — which renders every
    // tile disabled and would make "a tap actuates" untestable. `seed()`
    // supplies the snapshot that stream would have delivered.
    vi.spyOn(store, 'connectDeviceStore').mockReturnValue(() => {})
    vi.mocked(api.performAction).mockResolvedValue({ ok: true, data: undefined })
    vi.mocked(api.putAllowlist).mockResolvedValue({ ok: true, data: undefined })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: CATALOG })
    vi.mocked(api.getAllowlist).mockResolvedValue({
      ok: true,
      data: { devices: [], orphaned: [] },
    })
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
        theme: 'classic',
        title: 'Guest Portal',
      },
    })
    vi.mocked(api.putAdminTheme).mockResolvedValue({ ok: true, data: undefined })
    vi.mocked(api.putAdminPortal).mockResolvedValue({ ok: true, data: undefined })
    vi.mocked(api.putAdminTitle).mockResolvedValue({ ok: true, data: undefined })
  })

  afterEach(() => {
    cleanup()
    store.resetStore()
    vi.restoreAllMocks()
    document.documentElement.removeAttribute('data-portal-title')
  })

  describe('Who sees the owner controls', () => {
    // Kills: headerActions built unconditionally.
    it('shows a guest neither Edit nor Settings', () => {
      seed()
      renderPortal('guest')

      // Log out proves the header rendered at all, so "no buttons anywhere"
      // cannot pass this.
      expect(screen.getByRole('button', { name: /log out/i })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /^settings$/i })).toBeNull()

      // The three assertions above cannot tell absent from hidden: Testing
      // Library leaves `display: none` out of the accessibility tree, so a page
      // that built `headerActions` for everyone and hid it from guests with one
      // CSS declaration passes every one of them. `hidden: true` puts those
      // nodes back in scope.
      expect(screen.queryByRole('button', { name: /^edit$/i, hidden: true })).toBeNull()
      expect(screen.queryByRole('button', { name: /^settings$/i, hidden: true })).toBeNull()
      // And in the markup rather than the tree, because a hidden control is one
      // stylesheet away from being an operable one.
      expect(document.body.textContent).not.toContain('Settings')
    })

    // Kills: headerActions never built, or never handed to the Shell.
    it('shows an owner Edit and Settings', () => {
      seed()
      renderPortal('admin')

      expect(editButton()).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    })

    // Kills: an unconditional orphan fetch, which would 403 for every guest.
    it('asks no admin endpoint on a guest page', async () => {
      seed()
      renderPortal('guest')

      await waitFor(() => expect(screen.getByRole('button', { name: /log out/i })).toBeTruthy())
      expect(api.getAllowlist).not.toHaveBeenCalled()
      expect(api.getCatalog).not.toHaveBeenCalled()
    })
  })

  describe('The header title', () => {
    // Kills: a Shell title hardcoded in the page rather than read from the
    // injected attribute.
    it('shows the injected portal title', () => {
      document.documentElement.dataset.portalTitle = 'Beach House'
      seed()
      renderPortal('guest')

      expect(screen.getByRole('heading', { name: 'Beach House' })).toBeTruthy()
    })

    // Kills: a Shell title read from the injected attribute during render, as
    // this page did. The attribute is written once by the server, so the owner
    // renamed the portal in the panel and their own header kept the old name
    // until they reloaded — the exact indirection this restructure removes.
    // Guests still need a reload, by design; the owner editing the page does
    // not.
    it('moves the header when the owner saves a new name, with no reload', async () => {
      const user = userEvent.setup()
      document.documentElement.dataset.portalTitle = 'Guest Portal'
      seed()
      renderPortal('admin')

      // Level 1 specifically: the settings panel itself contains an h2 reading
      // 'Guest Portal' (the kill switch's section heading), so an unqualified
      // heading query cannot tell the page header from it.
      expect(screen.getByRole('heading', { level: 1, name: 'Guest Portal' })).toBeTruthy()

      await user.click(screen.getByRole('button', { name: 'Settings' }))
      const field = await screen.findByLabelText(/portal name/i)
      await user.clear(field)
      await user.type(field, 'Beach House')
      await user.tab()

      expect(await screen.findByRole('heading', { level: 1, name: 'Beach House' })).toBeTruthy()
      expect(screen.queryByRole('heading', { level: 1, name: 'Guest Portal' })).toBeNull()
    })
  })

  describe('Edit mode', () => {
    // Kills: a tap in edit mode still reaching the tile. Without the assertion
    // on performAction, a page that both actuates AND opens the editor passes.
    it('opens the tapped device editor instead of actuating it', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)

      await user.click(screen.getByRole('button', { name: 'Porch' }))

      expect(screen.getByRole('heading', { name: 'Porch' })).toBeTruthy()
      expect(api.performAction).not.toHaveBeenCalled()
    })

    // Kills: intercepting the tap in every mode, which would make the portal
    // unusable for the owner as a portal.
    it('still actuates on tap in normal mode', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')

      await user.click(screen.getByRole('button', { name: 'Porch' }))

      expect(api.performAction).toHaveBeenCalledWith('light.porch', 'turn_on')
      expect(screen.queryByRole('heading', { name: 'Porch' })).toBeNull()
    })

    // Kills: an editor opened for the wrong row (e.g. keyed by grid position).
    it('opens the editor for the device that was tapped', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)

      await user.click(screen.getByRole('button', { name: 'Kitchen' }))

      expect(screen.getByRole('heading', { name: 'Kitchen' })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Porch' })).toBeNull()
    })

    // Kills: an edit mode that looks exactly like normal mode. The spec calls
    // the visual distinction load-bearing, because the same gesture now does
    // something else.
    it('announces itself while it is on', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')

      expect(screen.queryByRole('status')).toBeNull()

      await enterEditMode(user)
      expect(screen.getByRole('status').textContent ?? '').toMatch(/edit mode/i)

      await user.click(screen.getByRole('button', { name: 'Done' }))
      expect(screen.queryByRole('status')).toBeNull()
    })

    // Kills: a ghost tile rendered in every mode, or never.
    it('shows the ghost Add device tile only in edit mode', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')

      expect(screen.queryByRole('button', { name: /add device/i })).toBeNull()

      await enterEditMode(user)
      expect(screen.getByRole('button', { name: /add device/i })).toBeTruthy()

      await user.click(screen.getByRole('button', { name: 'Done' }))
      expect(screen.queryByRole('button', { name: /add device/i })).toBeNull()
    })

    // Kills: the picker expanding inside its grid cell, which is what it used
    // to do. A cell is one column wide — half a phone screen under `tiles` —
    // and a search box above a scrolling list of every entity in the house does
    // not fit in it. The other two overlays already sat over the page; this one
    // did not.
    it('opens the picker over the page, not inside the grid cell', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)

      const ghost = screen.getByRole('button', { name: /add device/i })
      await user.click(ghost)

      const search = await screen.findByRole('combobox')

      // Not a descendant of the grid cell the ghost button lives in.
      const ghostCell = ghost.closest('div')
      expect(ghostCell).not.toBeNull()
      expect(ghostCell?.contains(search)).toBe(false)

      // That alone is not enough, and an earlier version of this test stopped
      // there: the overlay is pushed as its own entry in the Shell's children,
      // so without being lifted out of the flow it is simply a *different* grid
      // cell — one column wide, which is the bug. Pin the lift.
      const backdrop = search.closest('[data-testid="picker-overlay"]')
      expect(backdrop).not.toBeNull()
      expect((backdrop as HTMLElement | null)?.style.position).toBe('fixed')
    })

    // Kills: `height: 100%` on the picker's inner box. With the result list set
    // to `flex: 1 1 auto` that does not merely allow a tall dialog, it forces
    // one — a search matching a single entity rendered as ~700px of empty
    // white. The dialog must be free to size to its content and merely *able*
    // to grow, which is the difference between max-height and height.
    it('sizes the picker to its content rather than the viewport', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)
      await user.click(screen.getByRole('button', { name: /add device/i }))
      const search = await screen.findByRole('combobox')

      const inner = screen.getByTestId('picker-overlay').firstElementChild as HTMLElement
      expect(inner.style.height).toBe('')
      expect(inner.style.maxHeight).toBe('100%')

      // And a floor, so narrowing to a single match does not collapse the list
      // to one row that jumps taller again on the next keystroke. One match is
      // the case that exposed the original bug.
      await user.type(search, 'Heater')
      await screen.findByRole('option', { name: /heater/i })

      // Asserted as a real pixel floor rather than "not empty": React writes
      // `minHeight: 0` out as the string '0', so a not-''/not-'0px' check
      // passes against exactly the mutation it is supposed to catch.
      const floor = screen.getByRole('listbox').style.minHeight
      expect(floor).not.toMatch(/^0(px)?$/)
      expect(floor).toMatch(/\b[1-9]\d*px\b/)
    })

    // Kills: settings sharing the tile editor's 520px box. The theme picker
    // lays three previews side by side, so at that width each thumbnail is
    // about 155px across — too small to tell the themes apart, which is the
    // only thing that control is for. Asserts the relationship rather than the
    // number, so re-tuning the width later does not break this.
    it('gives settings a wider dialog than the tile editor', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')

      async function overlayMaxWidth(testId: string): Promise<number> {
        const inner = (await screen.findByTestId(testId)).firstElementChild as HTMLElement
        return Number.parseInt(inner.style.maxWidth, 10)
      }

      await user.click(screen.getByRole('button', { name: 'Settings' }))
      const settingsWidth = await overlayMaxWidth('settings-overlay')
      await user.click(screen.getByRole('button', { name: 'Settings' }))

      await enterEditMode(user)
      await user.click(screen.getByRole('button', { name: 'Porch' }))
      const editorWidth = await overlayMaxWidth('editor-overlay')

      expect(settingsWidth).toBeGreaterThan(editorWidth)
    })

    // Kills: leaving edit mode keeping `editingId`, which reopens the last
    // editor the next time the owner enters edit mode.
    it('forgets the open editor when edit mode is left', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)
      await user.click(screen.getByRole('button', { name: 'Porch' }))
      expect(screen.getByRole('heading', { name: 'Porch' })).toBeTruthy()

      await user.click(screen.getByRole('button', { name: 'Done' }))
      await enterEditMode(user)

      expect(screen.queryByRole('heading', { name: 'Porch' })).toBeNull()
    })
  })

  describe('A device that disappears underneath the editor', () => {
    // Kills: an editor holding the row object it was opened with. The owner
    // would go on editing a device another session removed, and the next
    // mutation would resurrect it.
    it('closes the editor when the device leaves the store', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)
      await user.click(screen.getByRole('button', { name: 'Porch' }))
      expect(screen.getByRole('heading', { name: 'Porch' })).toBeTruthy()

      // The snapshot another session's removal broadcasts.
      act(() => {
        store.applyFrame({ type: 'snapshot', devices: [KITCHEN], stale: false })
      })

      expect(screen.queryByRole('heading', { name: 'Porch' })).toBeNull()
      // Still on the page, still in edit mode — the editor closed, not the app.
      expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    })

    // Kills: closing the editor on every incoming frame, which would satisfy
    // the case above while making the editor unusable on a live stream.
    it('keeps the editor open when an unrelated device changes', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)
      await user.click(screen.getByRole('button', { name: 'Porch' }))

      act(() => {
        store.applyFrame({
          type: 'patch',
          devices: [{ ...KITCHEN, state: { state: 'on', attributes: {}, stale: false } }],
        })
      })

      expect(screen.getByRole('heading', { name: 'Porch' })).toBeTruthy()
    })
  })

  describe('Overlay exclusivity', () => {
    // Kills: two booleans kept in step by hand, which lets both overlays stack.
    it('closes edit mode when Settings opens, and the reverse', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')

      await enterEditMode(user)
      expect(screen.getByRole('button', { name: /add device/i })).toBeTruthy()

      await user.click(screen.getByRole('button', { name: 'Settings' }))
      expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /add device/i })).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()

      await enterEditMode(user)
      expect(screen.getByRole('button', { name: /add device/i })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull()
    })

    // Kills: a Settings button that only ever opens the panel, leaving the
    // owner no way back to the portal from the header.
    it('closes the settings panel from its own Close button', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')

      await user.click(screen.getByRole('button', { name: 'Settings' }))
      await user.click(await screen.findByRole('button', { name: /close/i }))

      expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull()
    })
  })

  describe('The ghost tile', () => {
    // Kills: a ghost tile that never fetches, or one that renders lookalike
    // markup instead of the real picker.
    it('adds the chosen device, with every action for its domain allowed', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)

      await user.click(screen.getByRole('button', { name: /add device/i }))
      const search = await screen.findByRole('combobox')
      await user.type(search, 'Heater')
      await user.click(await screen.findByRole('option', { name: /heater/i }))

      // A new device arrives usable immediately, not inert until the owner
      // manually checks boxes in the tile editor.
      expect(api.putAllowlist).toHaveBeenCalledWith([
        {
          entityId: 'light.porch',
          label: 'Porch',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 0,
        },
        {
          entityId: 'light.kitchen',
          label: 'Kitchen',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 1,
        },
        {
          entityId: 'switch.heater',
          label: 'Heater',
          allowedActions: ['turn_on', 'turn_off', 'toggle'],
          sortOrder: 2,
        },
      ])
    })

    // Kills: an empty `exclude`, which offers the owner devices already on the
    // page and produces a duplicate entry.
    it('does not offer a device already on the page', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)

      await user.click(screen.getByRole('button', { name: /add device/i }))
      const search = await screen.findByRole('combobox')
      await user.type(search, 'Porch')

      expect(screen.queryByRole('option')).toBeNull()
    })

    // Kills: swallowing a catalog failure, which leaves the owner staring at an
    // empty picker with no idea why.
    it('says so when the catalog cannot be loaded, and retries', async () => {
      const user = userEvent.setup()
      vi.mocked(api.getCatalog).mockRejectedValueOnce(new Error('offline'))
      seed()
      renderPortal('admin')
      await enterEditMode(user)

      await user.click(screen.getByRole('button', { name: /add device/i }))
      expect(await screen.findByText(/could not load the device list/i)).toBeTruthy()

      await user.click(screen.getByRole('button', { name: /retry/i }))

      expect(await screen.findByRole('combobox')).toBeTruthy()
      expect(api.getCatalog).toHaveBeenCalledTimes(2)
    })
  })

  describe('Orphaned devices', () => {
    beforeEach(() => {
      vi.mocked(api.getAllowlist).mockResolvedValue({
        ok: true,
        data: { devices: [], orphaned: ['light.porch'] },
      })
    })

    // Kills: fetching `orphaned` and never rendering it — the exact way this
    // behaviour would have been lost when admin-screen.test.tsx is deleted.
    it('flags an orphaned device in edit mode', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)

      const flag = await screen.findByText(/orphaned/i)
      expect(flag.textContent ?? '').toMatch(/renamed or removed/i)
    })

    // Kills: flagging every tile, which would tell the owner nothing.
    it('flags only the orphaned device', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)
      await screen.findByText(/orphaned/i)

      expect(screen.getAllByText(/orphaned/i)).toHaveLength(1)
      const flagged = screen.getByText(/orphaned/i).closest('[data-entity-id]')
      expect(flagged?.getAttribute('data-entity-id')).toBe('light.porch')
    })

    // Kills: flagging in normal mode too. Admin.tsx flagged orphans on the
    // owner's screen only, and a guest must not see maintenance state.
    it('does not flag anything outside edit mode', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)
      await screen.findByText(/orphaned/i)

      await user.click(screen.getByRole('button', { name: 'Done' }))

      expect(screen.queryByText(/orphaned/i)).toBeNull()
    })

    // Kills: an orphaned tile that cannot be opened — removing it is the
    // remedy, so it has to stay editable.
    it('still opens the editor for an orphaned device', async () => {
      const user = userEvent.setup()
      seed()
      renderPortal('admin')
      await enterEditMode(user)
      await screen.findByText(/orphaned/i)

      await user.click(screen.getByRole('button', { name: 'Porch' }))

      expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy()
    })

    // Kills: a bare `void getAllowlist()`. A network-level rejection there is
    // unhandled, and the owner is told nothing.
    it('says so when the orphan check fails', async () => {
      const user = userEvent.setup()
      vi.mocked(api.getAllowlist).mockRejectedValue(new Error('offline'))
      seed()
      renderPortal('admin')
      await enterEditMode(user)

      expect(await screen.findByText(/could not check for orphaned devices/i)).toBeTruthy()
    })

    // Kills: a dead-end error with no way back, which is what Admin.tsx's Retry
    // existed to avoid.
    it('retries the orphan check', async () => {
      const user = userEvent.setup()
      vi.mocked(api.getAllowlist).mockRejectedValueOnce(new Error('offline'))
      seed()
      renderPortal('admin')
      await enterEditMode(user)
      await screen.findByText(/could not check for orphaned devices/i)

      await user.click(screen.getByRole('button', { name: /retry/i }))

      expect(await screen.findByText(/orphaned/i)).toBeTruthy()
      expect(api.getAllowlist).toHaveBeenCalledTimes(2)
    })
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    // The page's own chrome (header buttons, the edit-mode banner, the orphan
    // flag) sits inside a themed Shell; a literal here would be visible in
    // every theme but one.
    //
    // EntityPicker is scanned here rather than in `entity-picker.test.tsx`
    // because this page is what mounts it: it renders inside `pickerBody()` →
    // `<section style={panel}>`, which sets `color: var(--text)`. A row
    // hardcoded to `white` therefore put light-grey device names on a white
    // background in every dark theme — invisible to a test that only asks what
    // the picker does.
    for (const path of ['src/web/routes/Portal.tsx', 'src/web/components/EntityPicker.tsx']) {
      const src = readFileSync(path, 'utf-8')
      expect(src, path).not.toMatch(
        /\b(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate|zinc)-\d{2,3}\b/,
      )
      expect(src, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, path).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
      expect(src, path).not.toMatch(/['"](?:white|black)['"]/)
    }
  })
})
