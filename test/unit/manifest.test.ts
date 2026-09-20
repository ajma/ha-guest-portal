import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The fields a browser actually requires before it will offer to install.
// Asserting the file merely parses would pass for `{}`.
describe('web app manifest', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf-8')) as {
    name: string
    short_name: string
    start_url: string
    display: string
    background_color: string
    theme_color: string
    icons: { src: string; sizes: string; type: string; purpose?: string }[]
  }

  it('names the app', () => {
    expect(manifest.name.length).toBeGreaterThan(0)
    // Home screens truncate around 12 characters.
    expect(manifest.short_name.length).toBeLessThanOrEqual(12)
  })

  it('opens standalone at the root', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
  })

  it('declares the icon sizes installability requires', () => {
    const sizes = manifest.icons.map((i) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
  })

  it('declares a maskable icon, so Android does not letterbox it', () => {
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true)
  })

  it('points every icon at a file that exists', () => {
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      // `src` is site-relative; the files live under public/.
      expect(existsSync(`public${icon.src}`), icon.src).toBe(true)
    }
  })

  it('links the manifest and an apple-touch-icon from the document head', () => {
    // iOS ignores the manifest's icons and uses apple-touch-icon only.
    const html = readFileSync('index.html', 'utf-8')
    expect(html).toMatch(/<link[^>]+rel="manifest"/)
    expect(html).toMatch(/<link[^>]+rel="apple-touch-icon"/)
    expect(html).toMatch(/<meta[^>]+name="theme-color"/)
  })
})
