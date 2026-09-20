import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemePicker } from '../../src/web/components/ThemePicker.tsx'
import * as api from '../../src/web/api.ts'
import { listThemes } from '../../src/web/themes/registry.ts'
import type { Theme } from '../../src/web/themes/types.ts'

vi.mock('../../src/web/api.ts')
vi.mock('../../src/web/themes/registry.ts', () => ({ listThemes: vi.fn() }))

// The real registry, kept for the one test that asserts the picker shows what
// is actually registered. Every other test runs against a two-theme stand-in:
// Phase 1 registers only `classic`, and a picker tested against a single
// already-selected option cannot tell "the owner chose this" from "the
// component saved on mount" or "the component hardcodes the first option".
const realRegistry = await vi.importActual<typeof import('../../src/web/themes/registry.ts')>(
  '../../src/web/themes/registry.ts',
)

function fakeTheme(id: string, name: string): Theme {
  return { id, name } as unknown as Theme
}

const TWO_THEMES = [fakeTheme('classic', 'Classic'), fakeTheme('tiles', 'Tiles')]

function mockStoredTheme(theme: string): void {
  vi.mocked(api.getAdminPortal).mockResolvedValue({
    ok: true,
    data: {
      enabled: true,
      integrationToken: 'a'.repeat(64),
      portalId: '11111111-1111-1111-1111-111111111111',
      theme: theme as 'classic',
      title: 'Guest Portal',
    },
  })
}

function radio(name: RegExp): HTMLInputElement {
  return screen.getByRole('radio', { name }) as HTMLInputElement
}

describe('ThemePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listThemes).mockReturnValue(TWO_THEMES)
    mockStoredTheme('classic')
    vi.mocked(api.putAdminTheme).mockResolvedValue({ ok: true, data: undefined })
  })

  afterEach(() => {
    cleanup()
  })

  it('exposes every registered theme as a radio in a radio group', async () => {
    vi.mocked(listThemes).mockReturnValue(realRegistry.listThemes())

    render(<ThemePicker />)

    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeTruthy())
    expect(screen.getAllByRole('radio')).toHaveLength(realRegistry.listThemes().length)
    for (const theme of realRegistry.listThemes()) {
      expect(screen.getByRole('radio', { name: new RegExp(theme.name, 'i') })).toBeTruthy()
    }
  })

  it('shows a preview image for every theme that has one captured', async () => {
    // Asserting only `classic` here is what let the previews silently drift:
    // the picker used to keep its own hand-written id -> image map, so a theme
    // could ship a captured baseline and still render "No preview captured"
    // with nothing failing. Drive this off the files on disk instead, so any
    // registered theme whose PNG exists must actually be shown one.
    const captured = realRegistry
      .listThemes()
      .filter((theme) => existsSync(`src/web/theme-previews/${theme.id}.png`))
    expect(captured.length).toBeGreaterThan(0)

    vi.mocked(listThemes).mockReturnValue(realRegistry.listThemes())

    render(<ThemePicker />)

    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeTruthy())
    for (const theme of captured) {
      const preview = screen.getByTestId(`theme-preview-${theme.id}`)
      expect(preview.tagName, `${theme.id} should render an image`).toBe('IMG')
      expect(preview.getAttribute('src')).toMatch(new RegExp(`${theme.id}.*\\.png$`))
    }
  })

  it('marks the stored theme as selected and the others as not', async () => {
    mockStoredTheme('tiles')

    render(<ThemePicker />)

    await waitFor(() => expect(radio(/tiles/i).checked).toBe(true))
    expect(radio(/classic/i).checked).toBe(false)
  })

  it('marks the selection in text, not by colour alone', async () => {
    mockStoredTheme('tiles')

    render(<ThemePicker />)

    await waitFor(() => expect(radio(/tiles/i).checked).toBe(true))
    // The marker sits in the option's label, which is also the radio's
    // accessible name — so a screen reader announces it too.
    expect(radio(/tiles/i).closest('label')?.textContent).toMatch(/selected/i)
    expect(radio(/classic/i).closest('label')?.textContent ?? '').not.toMatch(/selected/i)
  })

  it('does not write the theme back while merely loading it', async () => {
    render(<ThemePicker />)

    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeTruthy())
    expect(api.putAdminTheme).not.toHaveBeenCalled()
  })

  it('saves the theme the owner picks, without a separate confirm', async () => {
    render(<ThemePicker />)
    await waitFor(() => screen.getByRole('radiogroup'))

    await userEvent.click(radio(/tiles/i))

    expect(api.putAdminTheme).toHaveBeenCalledExactlyOnceWith('tiles')
    await waitFor(() => expect(radio(/tiles/i).checked).toBe(true))
  })

  it('does not resave the theme that is already selected', async () => {
    render(<ThemePicker />)
    await waitFor(() => screen.getByRole('radiogroup'))

    await userEvent.click(radio(/classic/i))

    expect(api.putAdminTheme).not.toHaveBeenCalled()
  })

  it('moves the selection with the arrow keys and saves it', async () => {
    render(<ThemePicker />)
    await waitFor(() => screen.getByRole('radiogroup'))

    radio(/classic/i).focus()
    await userEvent.keyboard('{ArrowRight}')

    expect(document.activeElement).toBe(radio(/tiles/i))
    await waitFor(() => expect(radio(/tiles/i).checked).toBe(true))
    expect(api.putAdminTheme).toHaveBeenCalledExactlyOnceWith('tiles')

    await userEvent.keyboard('{ArrowLeft}')

    expect(document.activeElement).toBe(radio(/classic/i))
    await waitFor(() => expect(radio(/classic/i).checked).toBe(true))
    expect(api.putAdminTheme).toHaveBeenLastCalledWith('classic')
  })

  it('puts every option in one native radio group', async () => {
    render(<ThemePicker />)
    await waitFor(() => screen.getByRole('radiogroup'))

    // Distinct names would make each option its own group, which costs the
    // single tab stop and the browser's own arrow-key handling.
    const names = new Set(screen.getAllByRole('radio').map((el) => el.getAttribute('name')))
    expect(names).toEqual(new Set(['portal-theme']))
  })

  it('reverts the visible selection when the save fails', async () => {
    vi.mocked(api.putAdminTheme).mockResolvedValue({ ok: false, status: 500 })

    render(<ThemePicker />)
    await waitFor(() => screen.getByRole('radiogroup'))

    await userEvent.click(radio(/tiles/i))

    await waitFor(() => expect(screen.getByTestId('theme-picker-error')).toBeTruthy())
    expect(radio(/classic/i).checked).toBe(true)
    expect(radio(/tiles/i).checked).toBe(false)
  })

  it('offers a retry when the initial load fails, and clears the error on success', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({ ok: false, status: 500 })

    render(<ThemePicker />)

    await waitFor(() => expect(screen.getByTestId('theme-picker-error')).toBeTruthy())
    expect(screen.queryByRole('radiogroup')).toBeNull()

    mockStoredTheme('tiles')
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(radio(/tiles/i).checked).toBe(true))
    expect(screen.queryByTestId('theme-picker-error')).toBeNull()
  })
})
