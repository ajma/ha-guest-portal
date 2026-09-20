import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_PORTAL_TITLE, MAX_PORTAL_TITLE_LENGTH } from '@shared/portalTitle.js'
import { SettingsPanel } from '../../src/web/components/SettingsPanel.tsx'
import * as api from '../../src/web/api.ts'

vi.mock('../../src/web/api.ts')

// The kill switch is a native checkbox inside its own label; querying it by
// role and accessible name proves the real control is mounted, not just some
// element carrying its test id.
function killSwitch(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: /guests can log in/i }) as HTMLInputElement
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    vi.mocked(api.putAdminTitle).mockResolvedValue({ ok: true, data: undefined })
    vi.mocked(api.putAdminTheme).mockResolvedValue({ ok: true, data: undefined })
    vi.mocked(api.putAdminPortal).mockResolvedValue({ ok: true, data: undefined })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    document.documentElement.removeAttribute('data-portal-title')
    document.title = ''
  })

  it('holds the theme picker, the kill switch and the title field', async () => {
    render(<SettingsPanel onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeTruthy())
    expect(screen.getByLabelText(/portal name/i)).toBeTruthy()
    expect(killSwitch()).toBeTruthy()
  })

  it('wires each control to its own endpoint', async () => {
    // The inventory test above proves the controls are present; this proves the
    // panel mounted the live components rather than lookalike markup.
    render(<SettingsPanel onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeTruthy())

    await userEvent.click(killSwitch())
    expect(api.putAdminPortal).toHaveBeenCalledWith(false)

    await userEvent.click(screen.getByRole('radio', { name: /tiles/i }))
    expect(api.putAdminTheme).toHaveBeenCalledWith('tiles')
  })

  it('saves a new title', async () => {
    render(<SettingsPanel onClose={() => {}} />)
    const field = await screen.findByLabelText(/portal name/i)

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House')
    await userEvent.tab()

    await waitFor(() => expect(api.putAdminTitle).toHaveBeenCalledWith('Beach House'))
  })

  it('writes the saved name back over the one the server injected', async () => {
    // The server writes this attribute once, at page load; it is where the rest
    // of the page — the header, and a later remount — reads the title from.
    document.documentElement.dataset.portalTitle = 'Guest Portal'
    render(<SettingsPanel onClose={() => {}} />)
    const field = await screen.findByLabelText(/portal name/i)

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House')
    await userEvent.tab()

    await waitFor(() => expect(document.documentElement.dataset.portalTitle).toBe('Beach House'))
    // The <title> element is server-rendered too, and just as stale.
    expect(document.title).toBe('Beach House')
  })

  it('tells the page around it what was saved', async () => {
    // An attribute write does not re-render React, so the write above cannot
    // move the header on its own.
    const onTitleChange = vi.fn()
    render(<SettingsPanel onClose={() => {}} onTitleChange={onTitleChange} />)
    const field = await screen.findByLabelText(/portal name/i)

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House')
    await userEvent.tab()

    await waitFor(() => expect(onTitleChange).toHaveBeenCalledWith('Beach House'))
  })

  it('reports the normalised name the server stored, not the raw input', async () => {
    const onTitleChange = vi.fn()
    render(<SettingsPanel onClose={() => {}} onTitleChange={onTitleChange} />)
    const field = await screen.findByLabelText(/portal name/i)

    // Clearing the field stores the default. A header showing a blank name
    // would disagree with what the server serves guests.
    await userEvent.clear(field)
    await userEvent.tab()

    await waitFor(() => expect(onTitleChange).toHaveBeenCalledWith(DEFAULT_PORTAL_TITLE))
    expect(document.documentElement.dataset.portalTitle).toBe(DEFAULT_PORTAL_TITLE)
  })

  it('leaves the injected name alone when the save fails', async () => {
    vi.mocked(api.putAdminTitle).mockResolvedValue({ ok: false, status: 500 })
    document.documentElement.dataset.portalTitle = 'Guest Portal'
    const onTitleChange = vi.fn()
    render(<SettingsPanel onClose={() => {}} onTitleChange={onTitleChange} />)
    const field = await screen.findByLabelText(/portal name/i)

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House')
    await userEvent.tab()

    await waitFor(() => expect(screen.getByTestId('portal-title-error')).toBeTruthy())
    // A header that moved on a failed save is worse than one that never moves:
    // it says the rename took when the server refused it.
    expect(document.documentElement.dataset.portalTitle).toBe('Guest Portal')
    expect(onTitleChange).not.toHaveBeenCalled()
  })

  it('saves the title on Enter, without leaving the field', async () => {
    render(<SettingsPanel onClose={() => {}} />)
    const field = await screen.findByLabelText(/portal name/i)

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House{Enter}')

    await waitFor(() => expect(api.putAdminTitle).toHaveBeenCalledWith('Beach House'))
    expect(document.activeElement).toBe(field)
  })

  it('does not save the title on every keystroke', async () => {
    render(<SettingsPanel onClose={() => {}} />)
    const field = await screen.findByLabelText(/portal name/i)

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach')

    // A PUT per character would hammer the server and race itself.
    expect(api.putAdminTitle).not.toHaveBeenCalled()
  })

  it('does not save a title the owner left unchanged', async () => {
    render(<SettingsPanel onClose={() => {}} />)
    const field = await screen.findByLabelText(/portal name/i)

    // Focus and leave, then type the stored value back and leave again. Neither
    // is a change, and a write on every blur is indistinguishable from a write
    // on a real edit in the test above.
    await userEvent.click(field)
    await userEvent.tab()
    await userEvent.clear(field)
    await userEvent.type(field, 'Guest Portal')
    await userEvent.tab()

    expect(api.putAdminTitle).not.toHaveBeenCalled()
  })

  it('shows the stored title rather than the injected one once loaded', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
        theme: 'classic',
        title: 'Beach House',
      },
    })
    render(<SettingsPanel onClose={() => {}} />)

    const field = (await screen.findByLabelText(/portal name/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('Beach House'))
  })

  it('reverts the field and reports when the save fails', async () => {
    vi.mocked(api.putAdminTitle).mockResolvedValue({ ok: false, status: 500 })
    render(<SettingsPanel onClose={() => {}} />)
    const field = (await screen.findByLabelText(/portal name/i)) as HTMLInputElement

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House')
    await userEvent.tab()

    await waitFor(() => expect(screen.getByTestId('portal-title-error')).toBeTruthy())
    expect(field.value).toBe('Guest Portal')
  })

  it('reports a network failure instead of leaking it', async () => {
    // No function in src/web/api.ts guards fetch, so a rejection here is a real
    // possibility. Unhandled, it reverts the field with no explanation.
    vi.mocked(api.putAdminTitle).mockRejectedValue(new Error('offline'))
    render(<SettingsPanel onClose={() => {}} />)
    const field = (await screen.findByLabelText(/portal name/i)) as HTMLInputElement

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House')
    await userEvent.tab()

    await waitFor(() => expect(screen.getByTestId('portal-title-error')).toBeTruthy())
    expect(field.value).toBe('Guest Portal')
  })

  // The same rejection PortalTitleField already guards against, on the other
  // two controls. They live here rather than in theme-picker.test.tsx and
  // portal-toggle-ui.test.tsx so the assertion runs against the real components
  // as the panel mounts them.
  it('reverts the theme and stays usable when the network drops', async () => {
    vi.mocked(api.putAdminTheme).mockRejectedValueOnce(new Error('offline'))
    render(<SettingsPanel onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeTruthy())

    await userEvent.click(screen.getByRole('radio', { name: /tiles/i }))

    await waitFor(() => expect(screen.getByTestId('theme-picker-error')).toBeTruthy())
    // Unreverted, the owner sees the new theme selected while the server still
    // serves the old one to guests.
    expect((screen.getByRole('radio', { name: /classic/i }) as HTMLInputElement).checked).toBe(true)

    // And the picker is not wedged: without the catch, `saving` stays true and
    // `choose` returns at its own guard forever, so this second pick would
    // never reach the api at all.
    await userEvent.click(screen.getByRole('radio', { name: /tiles/i }))
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: /tiles/i }) as HTMLInputElement).checked).toBe(
        true,
      ),
    )
    expect(api.putAdminTheme).toHaveBeenCalledTimes(2)
  })

  it('reverts the kill switch and stays usable when the network drops', async () => {
    vi.mocked(api.putAdminPortal).mockRejectedValueOnce(new Error('offline'))
    render(<SettingsPanel onClose={() => {}} />)
    await waitFor(() => expect(killSwitch()).toBeTruthy())

    await userEvent.click(killSwitch())

    await waitFor(() => expect(screen.getByTestId('portal-toggle-error')).toBeTruthy())
    // The worst instance of this bug: unreverted, the owner is told guests are
    // blocked while the server still has the portal on and guests are still
    // logging in. `killSwitch()` matches on the 'guests can log in' label, so
    // finding it at all is the revert.
    expect(killSwitch().checked).toBe(true)
    expect(screen.queryByTestId('portal-disabled-banner')).toBeNull()
    // The checkbox is `disabled={saving}`, so a stuck `saving` is also a dead
    // kill switch.
    expect(killSwitch().disabled).toBe(false)

    await userEvent.click(killSwitch())
    await waitFor(() => expect(screen.getByTestId('portal-disabled-banner')).toBeTruthy())
    expect(api.putAdminPortal).toHaveBeenCalledTimes(2)
  })

  it('caps the field at the length the server accepts', async () => {
    // Over-long titles are a 400, which would surface as a mysterious failed
    // save; the field refuses the extra characters instead.
    render(<SettingsPanel onClose={() => {}} />)
    const field = (await screen.findByLabelText(/portal name/i)) as HTMLInputElement

    expect(field.maxLength).toBe(MAX_PORTAL_TITLE_LENGTH)
  })

  it('closes', async () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} />)
    await userEvent.click(await screen.findByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    // ThemePicker and PortalToggle are scanned here too: this task converts
    // them, and nothing else in the suite would notice a literal creeping back.
    for (const f of ['SettingsPanel', 'PortalTitleField', 'ThemePicker', 'PortalToggle']) {
      const src = readFileSync(`src/web/components/${f}.tsx`, 'utf-8')
      expect(src, f).not.toMatch(
        /\b(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate|zinc)-\d{2,3}\b/,
      )
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, f).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
      // The two converted components used named colours as well as hex.
      expect(src, f).not.toMatch(/['"](?:white|black)['"]/)
    }
  })
})
