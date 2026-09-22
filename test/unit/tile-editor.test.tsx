import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AllowlistRow } from '@shared/api.js'
import { TileEditor } from '../../src/web/components/TileEditor.tsx'
import type { AllowlistEditor } from '../../src/web/hooks/useAllowlistEditor.ts'

/**
 * MIGRATION MAP — `test/unit/admin-screen.test.tsx` (15 tests), deleted in Task 9.
 *
 * Landing here (per-device behaviour):
 *   1. 'action checkboxes offer only the actions legal for that entity domain'
 *        → 'offers only the actions legal for that entity domain'
 *   2. 'reorder up and down changes the order'
 *        → 'moves up and down' (the reordering itself is the hook's job and is
 *          covered by allowlist-editor.test.tsx; what belongs to this component
 *          is that each arrow asks for the right direction)
 *   3. 'remove button drops the row'
 *        → 'confirms before removing…' + 'removes once confirmed, and closes'
 *          (instant-save has no undo, so removal gained a confirmation step;
 *          the behaviour — Remove drops this device — is intact)
 *   7. '400 from putAllowlist surfaces validation message'
 *        → 'surfaces a failed save' (the message is now produced by the hook
 *          and shown in the editor that caused it, per the spec's error handling)
 *   9. 'editing label updates the device'
 *        → 'renames on blur' / 'renames on Enter' + 'shows the row label…' +
 *          'keeps what was typed…'
 *
 * Out of this component's scope (recorded so Task 9 can confirm each found a home):
 *   4. 'orphaned row is visibly flagged'                    → the grid, not one tile's editor
 *   5. '500 from getAllowlist renders explanatory message'  → page load (Task 8)
 *   6. 'Save calls putAllowlist and shows success'          → instant save; allowlist-editor.test.tsx
 *   8. 'adding entity via picker adds it to the list'       → ghost tile + picker (Tasks 7/8)
 *  10. 'clicking Retry after 500 error re-calls getAllowlist' → page load (Task 8)
 *  11. 'Save sends the actual displayed order and labels'   → allowlist-editor.test.tsx
 *  12. 're-fetches allowlist after successful save…'        → allowlist-editor.test.tsx
 *        'adopts the value the stream delivers once the save lands' — the Task 9
 *        audit found the mechanism real but UNPINNED, and ported it
 *  13-15. the three `beforeunload` tests                    → obsolete: instant save has no dirty state
 */

function editorStub(overrides: Partial<AllowlistEditor> = {}): AllowlistEditor {
  return {
    rows: [],
    pending: false,
    error: null,
    ready: true,
    loadFailed: false,
    orphaned: [],
    reload: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    toggleAction: vi.fn(),
    move: vi.fn(),
    dismissError: vi.fn(),
    ...overrides,
  }
}

const lightRow: AllowlistRow = {
  entityId: 'light.porch',
  label: 'Porch',
  allowedActions: ['turn_on'],
  sortOrder: 0,
}

afterEach(() => {
  cleanup()
})

describe('TileEditor', () => {
  it('shows the row label in the name field', () => {
    render(<TileEditor row={lightRow} editor={editorStub()} onClose={() => {}} />)

    const field = screen.getByLabelText(/name/i)
    expect(field instanceof HTMLInputElement && field.value).toBe('Porch')
  })

  // This replaces 'renames on input', which asserted `editor.rename` fired from
  // typing. That assertion encoded a defect: every keystroke was a full
  // allowlist PUT, so the server re-subscribed to Home Assistant and
  // broadcast a snapshot per character and guests watched the name spell
  // itself out. The name field commits on blur and on Enter, like
  // PortalTitleField; the three tests below pin that, including the negative.
  it('renames on blur', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    const field = screen.getByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'Porch Light')
    await userEvent.tab()

    expect(editor.rename).toHaveBeenCalledTimes(1)
    expect(editor.rename).toHaveBeenCalledWith('light.porch', 'Porch Light')
  })

  it('renames on Enter', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    const field = screen.getByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'Porch Light{Enter}')

    expect(editor.rename).toHaveBeenCalledTimes(1)
    expect(editor.rename).toHaveBeenCalledWith('light.porch', 'Porch Light')
  })

  it('does not rename while the owner is still typing', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    const field = screen.getByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'Porch Li')

    // Eight characters used to be eight PUTs and sixteen SSE frames.
    expect(editor.rename).not.toHaveBeenCalled()
  })

  it('does not write when focus leaves an unchanged name', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    const field = screen.getByLabelText(/name/i)
    await userEvent.click(field)
    await userEvent.tab()

    expect(editor.rename).not.toHaveBeenCalled()
  })

  // Migrated from admin-screen 'editing label updates the device': the field has
  // to keep what the owner typed. The row prop does not change here (the stub is
  // inert), so an editor that echoed `row.label` straight back would lose it.
  it('keeps what was typed in the name field', async () => {
    render(<TileEditor row={lightRow} editor={editorStub()} onClose={() => {}} />)

    const field = screen.getByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'New Label')

    expect(field instanceof HTMLInputElement && field.value).toBe('New Label')
  })

  it('offers every action the domain supports, checked to match the row', () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    const on = screen.getByRole('checkbox', { name: /turn_on/i })
    const off = screen.getByRole('checkbox', { name: /turn_off/i })
    expect(on instanceof HTMLInputElement && on.checked).toBe(true)
    expect(off instanceof HTMLInputElement && off.checked).toBe(false)
  })

  // Migrated unchanged in meaning from admin-screen 'action checkboxes offer
  // only the actions legal for that entity domain'.
  it('offers only the actions legal for that entity domain', () => {
    const coverRow: AllowlistRow = {
      entityId: 'cover.garage',
      label: 'Garage',
      allowedActions: ['open_cover'],
      sortOrder: 0,
    }
    render(<TileEditor row={coverRow} editor={editorStub()} onClose={() => {}} />)

    expect(screen.getByRole('checkbox', { name: /open_cover/i })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /close_cover/i })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /stop_cover/i })).toBeTruthy()

    expect(screen.queryByRole('checkbox', { name: /turn_on/i })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /turn_off/i })).toBeNull()
  })

  it('toggles an action', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('checkbox', { name: /turn_off/i }))

    expect(editor.toggleAction).toHaveBeenCalledWith('light.porch', 'turn_off')
  })

  it('moves up and down', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /move up/i }))
    expect(editor.move).toHaveBeenCalledWith('light.porch', -1)

    await userEvent.click(screen.getByRole('button', { name: /move down/i }))
    expect(editor.move).toHaveBeenCalledWith('light.porch', 1)
  })

  it('confirms before removing, and does not remove if declined', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }))
    // Removal is the one destructive edit and there is no save step to undo it.
    expect(editor.remove).not.toHaveBeenCalled()
    expect(screen.getByText(/remove porch\?/i)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(editor.remove).not.toHaveBeenCalled()
  })

  it('removes once confirmed, and closes', async () => {
    const editor = editorStub()
    const onClose = vi.fn()
    render(<TileEditor row={lightRow} editor={editor} onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }))
    await userEvent.click(screen.getByRole('button', { name: /yes, remove/i }))

    expect(editor.remove).toHaveBeenCalledWith('light.porch')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes without removing when the close affordance is used', async () => {
    const editor = editorStub()
    const onClose = vi.fn()
    render(<TileEditor row={lightRow} editor={editor} onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: /close/i }))

    expect(onClose).toHaveBeenCalled()
    expect(editor.remove).not.toHaveBeenCalled()
  })

  // An entity whose domain this app does not support has no actions to offer.
  // It can still be named and removed, and must not crash the editor.
  it('offers no action checkboxes for a domain the portal cannot operate, but still reorders', () => {
    const exoticRow: AllowlistRow = {
      entityId: 'vacuum.roomba',
      label: 'Roomba',
      allowedActions: [],
      sortOrder: 0,
    }
    render(<TileEditor row={exoticRow} editor={editorStub()} onClose={() => {}} />)

    expect(screen.getByLabelText(/name/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^remove$/i })).toBeTruthy()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    // Reordering is domain-independent: an entity whose domain the portal
    // cannot actuate still has a position in the grid the owner may want to
    // change. Only the action checkboxes have nothing to offer.
    expect(screen.getByRole('button', { name: /move up/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /move down/i })).toBeTruthy()
  })

  it('surfaces a failed save', () => {
    render(
      <TileEditor
        row={lightRow}
        editor={editorStub({ error: 'Could not save that change' })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/could not save that change/i)).toBeTruthy()
  })

  it('shows no error when the editor has none', () => {
    render(<TileEditor row={lightRow} editor={editorStub()} onClose={() => {}} />)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    const src = readFileSync('src/web/components/TileEditor.tsx', 'utf-8')
    expect(src).not.toMatch(
      /\b(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate|zinc)-\d{2,3}\b/,
    )
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
    // Named colours were the one hole every scan but Task 7's left open.
    // `'white'` is as untokenised as `#fff`, and is what EntityPicker
    // actually shipped.
    expect(src).not.toMatch(/['"](?:white|black)['"]/)
  })
})
