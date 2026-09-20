import { expect, test, type Page } from '@playwright/test'
import { listThemes } from '../../src/web/themes/registry.js'
import { startHarness, type TestHarness } from './harness.js'

let harness: TestHarness

test.beforeAll(async () => {
  harness = await startHarness()
})

test.afterAll(async () => {
  if (harness) {
    await harness.cleanup()
  }
})

// One light, one cover and one lock — the three tile shapes a theme has to
// draw. The set is fixed and shared by every capture so the previews differ
// only by theme, which is the whole point of the picker showing them
// side by side.
const PREVIEW_DEVICES = [
  { search: 'porch', name: 'Porch Light' },
  { search: 'garage', name: 'Garage Door' },
  { search: 'front door', name: 'Front Door Lock' },
] as const

async function seedPreviewDevices(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/admin`)
  await expect(page.getByPlaceholder(/search/i)).toBeVisible()

  for (const device of PREVIEW_DEVICES) {
    await page.getByPlaceholder(/search/i).fill(device.search)
    // The picker hides entities already on the allowlist, so a device seeded
    // by an earlier capture simply will not appear. Every theme after the
    // first therefore finds the set already in place.
    const option = page.getByText(device.name, { exact: true })
    if (await option.isVisible({ timeout: 1000 }).catch(() => false)) {
      await option.click()
    }
  }

  await page.getByRole('button', { name: /save/i }).click()
  await expect(page.getByText(/saved/i)).toBeVisible()
}

// The captured image is both the admin picker's preview and the visual
// regression baseline. Changing a theme's appearance fails this test until the
// snapshot is updated, which regenerates the preview — so a stale preview is a
// failing test rather than a matter of discipline.
//
// Iterating the REGISTRY, not THEME_IDS: an id with no registered theme falls
// back to classic, so capturing it would write classic's picture into
// `<that id>.png` and the picker would show a preview that is simply a lie.
// `test/unit/theme-previews.test.ts` owns the every-id-has-a-preview guard, and
// registering a theme without capturing it fails here too — the baseline is
// missing, so a plain (non-updating) run fails.
for (const theme of listThemes()) {
  const id = theme.id

  test(`preview: ${id}`, async ({ page }) => {
    const { baseUrl } = harness

    await page.goto(baseUrl)
    await page.getByLabel('Password').fill('test-admin-password')
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page).toHaveURL(`${baseUrl}/`)

    await seedPreviewDevices(page, baseUrl)

    // Store the theme through the real mechanism and let the server inject it.
    // Setting document.documentElement.dataset.theme here would be discarded by
    // the navigation below, and every preview would silently capture whichever
    // theme the server happened to be serving.
    const stored = await page.request.put(`${baseUrl}/api/admin/theme`, { data: { theme: id } })
    expect(stored.status(), `PUT /api/admin/theme rejected ${id}`).toBe(200)

    await page.setViewportSize({ width: 420, height: 320 })
    await page.goto(baseUrl)

    // Prove the page under the camera is actually the theme being captured.
    // Without this a regression in the injection path would quietly re-capture
    // the wrong theme, and the screenshot would still pass.
    await expect(page.locator('html')).toHaveAttribute('data-theme', id)

    for (const device of PREVIEW_DEVICES) {
      await expect(page.getByText(device.name, { exact: true })).toBeVisible()
    }

    await expect(page).toHaveScreenshot(`${id}.png`, { maxDiffPixelRatio: 0.02 })
  })
}
