import { expect, test, type Page } from '@playwright/test'
import { listThemes } from '../../src/web/themes/registry.js'
import { AdminApi, seedPortal, startHarness, type SeededPortal, type TestHarness } from './harness.js'

let harness: TestHarness
let admin: AdminApi
let portal: SeededPortal

// One light, one cover and one lock — the three tile shapes a theme has to
// draw. The set is fixed and shared by every capture so the previews differ
// only by theme, which is the whole point of the picker showing them
// side by side.
const PREVIEW_DEVICES = [
  { entityId: 'light.porch', name: 'Porch Light', actions: ['turn_on', 'turn_off', 'toggle'] },
  {
    entityId: 'cover.garage_door',
    name: 'Garage Door',
    actions: ['open_cover', 'close_cover', 'stop_cover'],
  },
  { entityId: 'lock.front_door', name: 'Front Door Lock', actions: ['lock', 'unlock'] },
] as const

/**
 * The title is `Guest Portal` on purpose: it is the deployment default, it is
 * what the header in every stored baseline reads, and the preview is a picture
 * of a theme rather than of one deployment's naming. A portal called anything
 * else here would change every baseline for a reason that has nothing to do
 * with the themes.
 */
const PREVIEW_PORTAL_TITLE = 'Guest Portal'
const PREVIEW_PORTAL_PASSWORD = 'preview-portal-pw'

/**
 * Seeded through the API, not through edit mode's picker.
 *
 * What this spec captures is how a theme paints a fixed set of tiles; how an
 * owner puts them there is `portal.spec.ts`'s subject and is exercised in full
 * there. Driving the editor here would couple every preview to the editor's
 * affordances and re-run the same flow once per theme, for a picture that must
 * not vary with it. The portal and its theme are stored the same way, and for
 * the same reason.
 */
test.beforeAll(async () => {
  harness = await startHarness()
  admin = await AdminApi.login(harness.baseUrl)
  portal = await seedPortal(harness.baseUrl, {
    title: PREVIEW_PORTAL_TITLE,
    password: PREVIEW_PORTAL_PASSWORD,
    devices: PREVIEW_DEVICES.map((device, index) => ({
      entityId: device.entityId,
      label: device.name,
      allowedActions: [...device.actions],
      sortOrder: index,
    })),
    select: true,
  })
})

test.afterAll(async () => {
  if (harness) {
    await harness.cleanup()
  }
})

/**
 * The previews advertise what a GUEST sees. An owner's portal carries the
 * portal dropdown, Edit, Settings and the portal-settings accordion, none of
 * which belong to any theme — they would put the owner's chrome into a picture
 * shown to choose a look.
 *
 * The session is created over HTTP and the page then navigated, rather than
 * typing the password into the login form. The theme lands on <html> at
 * request time, resolved from the session's portal (see `themeAndTitleFor` in
 * src/server/app.ts), so the capture has to be a *navigation made as the
 * guest*. Logging in through the form leaves the document that was injected
 * for a logged-out visitor — the default theme — with the guest screen drawn
 * inside it, and every preview would silently capture that instead.
 */
async function loadAsGuest(page: Page, baseUrl: string): Promise<void> {
  const login = await page.request.post(`${baseUrl}/api/login`, {
    data: { password: PREVIEW_PORTAL_PASSWORD },
  })
  expect(login.status(), 'guest login for the preview portal was refused').toBe(200)
  await page.goto(baseUrl)
}

// The captured image is both the settings panel's preview and the visual
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

    // Store the theme on the portal through the real admin route and let the
    // server inject it. Setting document.documentElement.dataset.theme here
    // would be discarded by the navigation below, and every preview would
    // silently capture whichever theme the portal happened to be wearing.
    const stored = await admin.updatePortal(portal.id, { theme: id })
    expect(stored.theme, `PUT /api/admin/portals/:id did not store ${id}`).toBe(id)

    await page.setViewportSize({ width: 420, height: 380 })
    await loadAsGuest(page, baseUrl)

    // Prove the page under the camera is actually the theme being captured.
    // Without this a regression in the injection path would quietly re-capture
    // the wrong theme, and the screenshot would still pass.
    await expect(page.locator('html')).toHaveAttribute('data-theme', id)
    await expect(page.getByTestId('guest-screen')).toBeVisible()

    for (const device of PREVIEW_DEVICES) {
      await expect(page.getByText(device.name, { exact: true })).toBeVisible()
    }

    // These tolerances are the whole point of this spec, so they are tight.
    // The baseline IS the theme picker's preview image, and the claim above is
    // that a stale preview is a failing test. At Playwright's defaults it was
    // not: `threshold` is a per-pixel YIQ distance (default 0.2) and
    // maxDiffPixelRatio was 0.02, while a 36px icon circle is only ~0.6% of a
    // 420x380 frame. Repainting that circle from green to purple — about as
    // large a colour change as this UI can make — still passed, so every
    // colour-only change slipped through and the previews would silently rot.
    //
    // 0.001 is ~160px of a 159,600px frame, and it has to stay that tight.
    // The icon circle carrying a tile's state colour is only ~1,018px AND is
    // drawn as a 20% tint rather than a solid fill, so repainting it green to
    // purple moves far fewer pixels past `threshold` than its area suggests:
    // measured, 0.003 lets that change through undetected. The flakiness this
    // tightness used to cause came from text antialiasing, and is fixed at the
    // source by the deterministic font rendering flags in playwright.config.ts
    // rather than by raising the floor past the signal.
    await expect(page).toHaveScreenshot(`${id}.png`, {
      threshold: 0.1,
      maxDiffPixelRatio: 0.001,
    })
  })
}
