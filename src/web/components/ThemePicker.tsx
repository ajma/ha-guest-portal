/// <reference types="vite/client" />
import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { isThemeId, type ThemeId } from '@shared/themes.js'
import * as api from '../api.js'
import { listThemes } from '../themes/registry.js'

// The previews are the Playwright baselines captured by
// test/e2e/theme-previews.spec.ts — changing a theme's appearance fails that
// test until the image is regenerated, so what the owner sees here cannot
// drift from what a guest gets. A theme with no captured preview shows a
// placeholder rather than a broken image; `test/unit/theme-previews.test.ts`
// is what makes that a temporary state.
//
// Discovered by glob rather than listed. A hand-written map here was a second
// registry: adding a theme meant editing its folder, the theme registry AND
// this file, and forgetting the third silently showed "No preview captured"
// next to a theme that had one — with nothing failing. Globbing means the
// captured file IS the registration.
const PREVIEWS: Partial<Record<ThemeId, string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../theme-previews/*.png', {
      eager: true,
      query: '?url',
      import: 'default',
    }),
  )
    .map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -'.png'.length), url] as const)
    .filter(([id]) => isThemeId(id)),
)

const errorStyle = { marginTop: '8px', color: '#d9534f', fontSize: '13px' } as const

export function ThemePicker(): ReactElement {
  const [selected, setSelected] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const themes = listThemes()

  const load = useCallback(async (): Promise<void> => {
    const result = await api.getAdminPortal()
    if (!result.ok) {
      setError('Failed to load the theme')
      return
    }
    setError(null)
    setSelected(result.data.theme)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function choose(id: string): Promise<void> {
    // Re-picking the current theme is not a change. Writing it anyway would
    // make the save indistinguishable from a save-on-mount.
    if (!isThemeId(id) || id === selected || saving) return

    const previous = selected

    // Apply immediately, as PortalToggle does: a selection that waits for a
    // round trip reads as a dead control. Revert if the server refuses.
    setSelected(id)
    setSaving(true)
    setError(null)

    const result = await api.putAdminTheme(id)
    setSaving(false)

    if (!result.ok) {
      setSelected(previous)
      setError('Failed to change the theme. Try again.')
    }
  }

  if (!loaded) {
    if (error !== null) {
      return (
        <section data-testid="theme-picker-section" style={{ marginBottom: '24px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Theme</h2>
          <p data-testid="theme-picker-error" style={{ color: '#d9534f', fontWeight: 500 }}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => {
              void load()
            }}
            style={{
              marginTop: '12px',
              padding: '8px 16px',
              fontSize: '14px',
              cursor: 'pointer',
              backgroundColor: '#5cb85c',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
            }}
          >
            Retry
          </button>
        </section>
      )
    }
    return <section data-testid="theme-picker-section">Loading theme...</section>
  }

  return (
    <section data-testid="theme-picker-section" style={{ marginBottom: '24px' }}>
      <h2
        id="theme-picker-label"
        style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}
      >
        Theme
      </h2>
      <p style={{ fontSize: '13px', color: '#666', marginBottom: '12px' }}>
        How the guest portal looks. Takes effect on the guest's next page load.
      </p>

      {/*
        Arrow-key navigation is the browser's, not ours: same-name radios are
        already one group with one tab stop and selection-follows-focus. A
        hand-rolled keydown handler here was deleted because it only
        reimplemented that, and `test/unit/theme-picker.test.tsx` covers the
        behaviour either way.
      */}
      <div
        role="radiogroup"
        aria-labelledby="theme-picker-label"
        style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}
      >
        {themes.map((theme) => {
          const isSelected = theme.id === selected
          const preview = PREVIEWS[theme.id]

          return (
            // A label wrapping a real radio, not a div with role="radio": the
            // whole card is then clickable for free, and the browser supplies
            // the group's roving tab stop.
            <label
              key={theme.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: '6px',
                width: '180px',
                padding: '8px',
                cursor: saving ? 'wait' : 'pointer',
                backgroundColor: 'white',
                // Thickness as well as colour: the selected state must not be
                // colour-alone, and the '✓ Selected' text below carries it for
                // anyone who sees neither.
                border: isSelected ? '3px solid #2f6fdb' : '1px solid #ccc',
                borderRadius: '6px',
              }}
            >
              {preview ? (
                <img
                  data-testid={`theme-preview-${theme.id}`}
                  src={preview}
                  alt=""
                  style={{
                    width: '100%',
                    borderRadius: '4px',
                    border: '1px solid #e5e5e5',
                    display: 'block',
                  }}
                />
              ) : (
                <span
                  data-testid={`theme-preview-missing-${theme.id}`}
                  style={{
                    display: 'block',
                    padding: '24px 0',
                    textAlign: 'center',
                    fontSize: '12px',
                    color: '#666',
                    backgroundColor: '#f5f5f5',
                    borderRadius: '4px',
                  }}
                >
                  No preview captured
                </span>
              )}
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="radio"
                  // One shared name is what makes these a single group: without
                  // it the browser gives each radio its own group, and neither
                  // the arrow keys nor the single tab stop behave.
                  name="portal-theme"
                  value={theme.id}
                  checked={isSelected}
                  aria-busy={saving && isSelected}
                  onChange={() => {
                    void choose(theme.id)
                  }}
                />
                <span style={{ fontSize: '14px', fontWeight: 600 }}>{theme.name}</span>
              </span>
              <span style={{ fontSize: '12px', color: isSelected ? '#2f6fdb' : '#666' }}>
                {isSelected ? '✓ Selected' : ' '}
              </span>
            </label>
          )
        })}
      </div>

      {error !== null && (
        <div data-testid="theme-picker-error" style={errorStyle}>
          {error}
        </div>
      )}
    </section>
  )
}
