import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  ADMIN_PASSWORD,
  seedPortal,
  startHarness,
  startHarnessBootOrder,
  type SeededPortal,
  type TestHarness,
} from './harness.js'

/**
 * The themed tiles carry no palette classes — every colour resolves from a CSS
 * custom property. These read the colour actually painted, so the assertions
 * track `tokens.ts` rather than restating it.
 *
 * classic follows Home Assistant's tile card: the state colour goes on the icon
 * circle, not on the card, and it is chosen per (domain, state) rather than
 * from one global accent — an active light is amber, not the blue `--accent`.
 * The circle is a layer of that colour at 20% behind a full-strength glyph, so
 * the layer's background-color is the token exactly and the fade is its own
 * opacity.
 */
async function tokenRgb(tile: Locator, token: string): Promise<string> {
  const hex = await tile.evaluate(
    (el, name) => getComputedStyle(el).getPropertyValue(name).trim(),
    token,
  )
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

async function iconCircleBg(tile: Locator): Promise<string> {
  return tile
    .locator('[data-testid="tile-icon-bg"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
}

async function iconCircleOpacity(tile: Locator): Promise<string> {
  return tile.locator('[data-testid="tile-icon-bg"]').evaluate((el) => getComputedStyle(el).opacity)
}

let harness: TestHarness
let portal: SeededPortal

/**
 * The portal every test below works in. A deployment now starts with none at
 * all, so one has to exist before an owner has anything to edit or a guest has
 * anything to log into.
 *
 * Seeded over the admin API rather than by driving the create-portal screen:
 * that screen is its own test ('first run', below) and a failure in it should
 * fail one test rather than every test in the file. `select` is what the
 * dropdown writes when an owner picks a portal, and it is what decides which
 * portal's theme the server injects for an admin — without it the owner's own
 * page would render in the neutral default.
 */
const PORTAL_TITLE = 'Guest Portal'
const GUEST_PASSWORD = 'guest-portal-pw'

test.beforeAll(async () => {
  harness = await startHarness()
  portal = await seedPortal(harness.baseUrl, {
    title: PORTAL_TITLE,
    password: GUEST_PASSWORD,
    select: true,
  })
})

test.afterAll(async () => {
  if (harness) {
    await harness.cleanup()
  }
})

async function loginAsAdmin(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl)
  await page.getByLabel('Password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()

  // Wait for redirect to guest page after successful login
  await expect(page).toHaveURL(`${baseUrl}/`)
}

/**
 * The create-portal screen, filled in and submitted. `exact` on the password
 * field: the screen also carries a "Show password" button, whose accessible
 * name contains the label text.
 */
async function createPortalThroughUi(
  page: Page,
  input: { title: string; password: string },
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Create a portal' })).toBeVisible()
  await page.getByLabel('Portal name').fill(input.title)
  await page.getByLabel('Password', { exact: true }).fill(input.password)
  await page.getByRole('button', { name: 'Create portal' }).click()

  // The owner lands on the new portal itself: the header stops being a bare
  // deployment title and becomes the portal dropdown, with the editing chrome
  // beside it.
  await expect(page.getByRole('combobox', { name: 'Portal' })).toHaveValue(/.+/)
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
}

/**
 * The per-portal settings accordion under the header. Title, theme, password,
 * the enabled switch and Delete all live in here now — there is no deployment
 * page holding one global copy of any of them.
 */
async function openPortalSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Portal settings/ }).click()
  await expect(page.getByLabel('Portal name')).toBeVisible()
}

/**
 * The accordion's enabled switch, whose label states the current answer.
 *
 * Clicked rather than `check`/`uncheck`ed: it is a controlled checkbox that
 * does not move until the server has taken the change, and Playwright's
 * check/uncheck read the state back immediately, call the click a no-op and
 * click again — which would put it straight back.
 */
function enabledToggle(page: Page): Locator {
  return page.getByRole('checkbox', { name: /guests (can log in|are blocked)/ })
}

/**
 * There is no admin page to deep-link to any more: the owner edits the portal
 * they are already looking at. These helpers go through the header buttons on
 * purpose — a test that jumped straight to an editing surface would not notice
 * the only way in disappearing.
 *
 * `exact` matters: in edit mode every tile also carries an "Edit <label>"
 * button, and the header's is just "Edit".
 */
async function enterEditMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
}

async function leaveEditMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
}

/** Adds a device through edit mode's ghost tile. Requires edit mode to be on. */
async function addDevice(page: Page, query: string, entityId: string): Promise<void> {
  await page.getByRole('button', { name: /add device/i }).click()
  await page.getByPlaceholder(/search/i).fill(query)
  await page.getByRole('option', { name: new RegExp(entityId.replaceAll('.', '\\.')) }).click()
}

/**
 * A device added from the picker starts with every action for its domain
 * already allowed — usable by a guest immediately, not inert until the owner
 * visits the tile editor. This asserts that default rather than switching it
 * on, since there is nothing left to check.
 */
async function expectActionsAllowed(page: Page, label: string, actions: string[]): Promise<void> {
  await page.getByRole('button', { name: `Edit ${label}` }).click()

  for (const action of actions) {
    // `exact`: a role name match is a substring by default, so 'lock' would
    // also find 'unlock'.
    const box = page.getByRole('checkbox', { name: action, exact: true })
    await expect(box).toBeChecked()
  }

  await page.getByTestId('tile-editor').getByRole('button', { name: 'Close' }).click()
}

test.describe('Portal E2E', () => {
  test('main path: admin login → add device → guest view → control → live SSE update', async ({
    page,
  }) => {
    const { baseUrl, fake } = harness

    // Screenshot: Login screen
    await page.goto(baseUrl)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.screenshot({
      path: 'test/e2e/screenshots/01-login.png',
      fullPage: true,
      animations: 'disabled',
    })

    // Step 1: Login as admin
    await loginAsAdmin(page, baseUrl)

    // Step 2: Turn on edit mode — the owner's way in, on the page they are
    // already looking at
    await enterEditMode(page)

    // Step 3: Add multiple devices to show variety of tile types, through the
    // ghost tile, then say what a guest may do with each
    await addDevice(page, 'porch', 'light.porch')
    await expectActionsAllowed(page, 'Porch Light', ['turn_on', 'turn_off', 'toggle'])

    await addDevice(page, 'garage', 'cover.garage_door')
    await expectActionsAllowed(page, 'Garage Door', ['open_cover', 'close_cover', 'stop_cover'])

    await addDevice(page, 'front door', 'lock.front_door')
    await expectActionsAllowed(page, 'Front Door Lock', ['lock', 'unlock'])

    // Screenshot: the owner's edit mode with the picker open over the themed grid
    await page.getByRole('button', { name: /add device/i }).click()
    await page.getByPlaceholder(/search/i).fill('lamp')
    await expect(page.getByRole('option', { name: /switch\.living_room_lamp/ })).toBeVisible()
    await page.screenshot({
      path: 'test/e2e/screenshots/02-owner-edit-picker.png',
      fullPage: true,
      animations: 'disabled',
    })

    // Step 4: Back to the ordinary portal, which is what a guest sees
    await page.goto(baseUrl)

    // Step 5: Verify all tiles appear with correct states
    const lightTile = page.getByRole('button', { name: 'Porch Light' })
    await expect(lightTile).toBeVisible()
    await expect(lightTile).toContainText('Off')

    // Verify cover tile
    await expect(page.getByText('Garage Door')).toBeVisible()
    await expect(page.getByText('Closed')).toBeVisible()

    // Verify lock tile
    await expect(page.getByText('Front Door Lock')).toBeVisible()
    await expect(page.getByText('Locked')).toBeVisible()

    // Screenshot: Guest grid with multiple device types (phone viewport)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
      path: 'test/e2e/screenshots/03-guest-normal.png',
      fullPage: true,
      animations: 'disabled',
    })

    // Step 6: Click the light tile to turn it on
    await lightTile.click()

    // Step 7: Verify the service call was recorded
    await expect
      .poll(
        () => {
          const calls = fake.serviceCalls
          return calls.find(
            (c) =>
              c.domain === 'light' &&
              c.service === 'turn_on' &&
              c.body &&
              typeof c.body === 'object' &&
              'entity_id' in c.body &&
              c.body.entity_id === 'light.porch',
          )
        },
        { timeout: 2000 },
      )
      .toBeDefined()

    // Step 8: Update the fake HA state to 'on'
    fake.setState('light.porch', 'on', { brightness: 255 })

    // Step 9: Verify the tile updates to 'On' without page reload (SSE working)
    await expect(lightTile).toContainText('On', { timeout: 3000 })

    // Verify the tile is visibly painted as 'on'.
    // This used to assert the Tailwind class bg-blue-500, which the themed
    // tiles no longer emit — every colour now comes from a token. classic also
    // paints the state colour on the icon circle rather than the whole card; a
    // card that stays neutral is what separates it from the flood-fill themes.
    // Read the colour off the token so this tracks tokens.ts instead of
    // duplicating it, and off the LIGHT-ACTIVE token specifically: Home
    // Assistant colours an on light amber, and asserting `--accent` here would
    // pass for a tile that ignored the domain entirely.
    await expect(lightTile).toHaveAttribute('aria-pressed', 'true')
    // The circle has a 180ms colour transition, so the paint lags the text
    // update; poll for it.
    await expect
      .poll(() => iconCircleBg(lightTile))
      .toBe(await tokenRgb(lightTile, '--stateLightActive'))
    // The circle is the state colour at 20%, not a solid fill. Park the pointer
    // off the tile first: it is still resting where the click landed, and
    // hovering a tile deliberately lifts the fill to 35%, as Home Assistant's
    // does.
    await page.mouse.move(0, 0)
    await expect.poll(() => iconCircleOpacity(lightTile)).toBe('0.2')
  })

  test('staleness: disconnect triggers stale UI state', async ({ page }) => {
    const { baseUrl, fake } = harness

    // Login and set up a device first
    await loginAsAdmin(page, baseUrl)

    // Add the light if an earlier test has not already (idempotent).
    // `waitFor`, not `isVisible`: the latter does not retry, so it would answer
    // "no" before the stream had delivered anything at all.
    const porchTile = page.getByRole('button', { name: 'Porch Light' })
    const alreadyThere = await porchTile
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false)

    if (!alreadyThere) {
      await enterEditMode(page)
      await addDevice(page, 'porch', 'light.porch')
      await expectActionsAllowed(page, 'Porch Light', ['turn_on', 'turn_off', 'toggle'])
      await leaveEditMode(page)
    }

    // Reload to be sure nothing of edit mode is left on screen
    await page.goto(baseUrl)
    await page.setViewportSize({ width: 390, height: 844 })

    const tile = page.getByRole('button', { name: 'Porch Light' })
    await expect(tile).toBeVisible()

    // First,ensure the light is off (reset from previous test's 'on' state)
    // This way the stale tile won't show bright blue
    if (
      await tile
        .getByText('On')
        .isVisible()
        .catch(() => false)
    ) {
      fake.setState('light.porch', 'off', { brightness: 0 })
      await expect(tile).toContainText('Off', { timeout: 2000 })
    }

    // Verify tile is initially NOT showing unknown
    await expect(tile).not.toContainText('Unknown')

    // Drop the WebSocket connection
    fake.drop()

    // Within a few seconds, the tile should show 'Unknown' but remain enabled
    await expect(tile).toContainText('Unknown', { timeout: 5000 })
    await expect(tile).not.toBeDisabled()

    // Verify the stale tile is NOT painted as active.
    // This compared against Tailwind's blue-500, which the themed tiles never
    // emit — so it passed regardless and proved nothing. Compare against the
    // colour an active light actually takes, on the element that carries it,
    // and pin the colour it should have instead: `not.toBe` alone would be
    // satisfied by a circle painted any wrong colour at all.
    await expect.poll(() => iconCircleBg(tile)).toBe(await tokenRgb(tile, '--stateInactive'))
    expect(await iconCircleBg(tile)).not.toBe(await tokenRgb(tile, '--stateLightActive'))

    // Screenshot: Stale state
    await page.screenshot({
      path: 'test/e2e/screenshots/04-guest-stale.png',
      fullPage: true,
      animations: 'disabled',
    })
  })

  test('boot order: portal starts before HA, then HA appears and tiles populate', async ({
    page,
  }) => {
    // Use a separate harness for this test since it has different lifecycle
    const bootHarness = await startHarnessBootOrder()

    try {
      const { baseUrl } = bootHarness

      // Step 1: Portal is running, but HA is not yet available
      // Verify portal serves pages
      await page.goto(baseUrl)
      await expect(page.getByLabel('Password')).toBeVisible()

      // Login as admin
      await page.getByLabel('Password').fill(ADMIN_PASSWORD)
      await page.getByRole('button', { name: 'Log in' }).click()
      await expect(page).toHaveURL(`${baseUrl}/`)

      // This harness has a database of its own, so the owner arrives at an
      // empty deployment. Making a portal is the first thing they do, and it
      // has to work with Home Assistant still unreachable — nothing about
      // naming a portal and giving it a password needs HA.
      await createPortalThroughUi(page, { title: 'Cabin', password: 'cabin-portal-pw' })

      // Turn on edit mode. With HA unreachable the portal's own device list
      // cannot be fetched — the orphan check needs the catalog — so edit mode
      // says so and fails closed: the ghost tile is disabled rather than
      // offering to save a list it was never able to read. That guard is
      // per-portal and new; a save computed from an unread list would wipe
      // this portal's allowlist.
      await enterEditMode(page)

      const orphanPanel = page.locator('div').filter({ hasText: /could not check for orphaned/i })
      await expect(orphanPanel.first()).toBeVisible({ timeout: 10000 })

      const ghost = page.getByRole('button', { name: /add device/i })
      await expect(ghost).toBeDisabled()
      await expect(page.getByText(/waiting for this portal.s device list/i)).toBeVisible()

      // Step 2: Now start the fake Home Assistant
      await bootHarness.startHA()

      // Give the connection a moment to establish
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Step 3: Retry the device-list load now that HA is there. The ghost
      // tile coming back is the signal that this portal's allowlist arrived.
      await orphanPanel.first().getByRole('button', { name: /retry/i }).click()
      await expect(ghost).toBeEnabled({ timeout: 10000 })

      // Step 4: Add a device, which now loads the catalog for the first time
      await ghost.click()
      await expect(page.getByPlaceholder(/search/i)).toBeVisible({ timeout: 10000 })
      await page.getByPlaceholder(/search/i).fill('porch')
      await page.getByRole('option', { name: /light\.porch/ }).click()
      await expectActionsAllowed(page, 'Porch Light', ['turn_on', 'turn_off', 'toggle'])

      // Step 5: Back to the ordinary portal
      await page.goto(baseUrl)

      // Step 6: Tiles should populate with real state from HA
      const tile = page.getByRole('button', { name: 'Porch Light' })
      await expect(tile).toBeVisible()
      await expect(tile).toContainText('Off')

      // Verify state is not stale
      await expect(tile).not.toContainText('Unknown')
    } finally {
      await bootHarness.cleanup()
    }
  })

  test('an admin can disable the portal and a guest is blocked, then restored', async ({
    browser,
  }) => {
    const { baseUrl } = harness

    const adminContext = await browser.newContext()
    const guestContext = await browser.newContext()

    const adminPage = await adminContext.newPage()
    const guestPage = await guestContext.newPage()

    try {
      // Step 1: Guest signs in with THIS portal's password and reaches the
      // device list
      await guestPage.goto(baseUrl)
      await guestPage.getByLabel('Password').fill(GUEST_PASSWORD)
      await guestPage.getByRole('button', { name: 'Log in' }).click()
      await expect(guestPage.getByTestId('guest-screen')).toBeVisible()

      // Step 2: Admin signs in and turns this one portal off from its own
      // settings accordion. The switch reports the state in its own label,
      // which is the only confirmation the owner gets that the write landed.
      await loginAsAdmin(adminPage, baseUrl)
      await openPortalSettings(adminPage)
      await expect(enabledToggle(adminPage)).toBeChecked()

      await enabledToggle(adminPage).click()
      await expect(adminPage.getByText(/Disabled .* guests are blocked/)).toBeVisible()
      await expect(enabledToggle(adminPage)).not.toBeChecked()

      // Step 3: The guest's stream is dropped, the client rechecks, and lands on disabled screen
      // This proves the SSE-drop → session-recheck path works
      // 5s timeout: fast path is ~800ms, this gives 6× headroom while staying well below
      // the 15s poll, ensuring the poll cannot satisfy this assertion
      await expect(guestPage.getByTestId('portal-disabled-screen')).toBeVisible({
        timeout: 5000,
      })

      // Step 4: The owner's own page keeps working while the portal is off —
      // the kill switch locks guests out, not the person holding it
      await expect(adminPage.getByTestId('guest-screen')).toBeVisible()

      // Step 5: Turning it back on restores the guest without a fresh login
      await enabledToggle(adminPage).click()
      await expect(adminPage.getByText(/Enabled .* guests can log in/)).toBeVisible()
      await expect(enabledToggle(adminPage)).toBeChecked()

      await guestPage.getByTestId('portal-disabled-retry').click()
      await expect(guestPage.getByTestId('guest-screen')).toBeVisible()

      // Verify the guest is back on the device list, not on the login screen
      // This proves sessions were blocked, not destroyed
      await expect(guestPage.getByLabel('Password')).not.toBeVisible()
    } finally {
      await adminContext.close()
      await guestContext.close()
    }
  })

  test('an admin selects a theme for their portal and its guest sees it', async ({ browser }) => {
    const { baseUrl } = harness

    const adminContext = await browser.newContext()
    const guestContext = await browser.newContext()
    const adminPage = await adminContext.newPage()
    const guestPage = await guestContext.newPage()

    try {
      await loginAsAdmin(adminPage, baseUrl)

      // Park this portal's theme somewhere else first, and somewhere that is
      // not the default either. Without the parking the test would pass
      // against a picker that saves nothing; parking at the default would let
      // it pass against a guest who is served the pre-login theme instead of
      // their portal's.
      const parked = await adminPage.request.put(`${baseUrl}/api/admin/portals/${portal.id}`, {
        data: { theme: 'cards' },
      })
      expect(parked.status()).toBe(200)
      await adminPage.goto(baseUrl)

      await openPortalSettings(adminPage)
      await expect(adminPage.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()

      // Wait for the save itself, not just the optimistic repaint: the guest
      // navigation below must not race the write.
      const saved = adminPage.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/admin/portals/${portal.id}`) &&
          response.request().method() === 'PUT',
      )
      await adminPage.getByRole('radio', { name: /tiles/i }).click()
      expect((await saved).status()).toBe(200)

      // A visitor with no session has no portal, so there is nothing to theme
      // for: they get the neutral default rather than some portal's look.
      await guestPage.goto(baseUrl)
      await expect(guestPage.locator('html')).toHaveAttribute('data-theme', 'classic')

      // The guest's document must carry their portal's chosen theme on first
      // paint — this is the property the whole injection design exists for,
      // and it would fail if the server served a cached or unmutated
      // index.html, or resolved the theme from anything but their own portal.
      await guestPage.getByLabel('Password').fill(GUEST_PASSWORD)
      await guestPage.getByRole('button', { name: 'Log in' }).click()
      await expect(guestPage.getByTestId('guest-screen')).toBeVisible()

      // This pins the live half: login happens in-page, with no reload, so
      // the document that was served the neutral default above must already
      // carry the portal's theme right now — before the reload-based
      // assertion below ever runs. Without a working live update this would
      // still read 'classic', the value the pre-login `goto` left behind.
      await expect(guestPage.locator('html')).toHaveAttribute('data-theme', 'tiles')

      // This pins the other half: a *fresh* load, after the live update
      // above, must still be served the theme by the server directly rather
      // than relying on whatever the client wrote — the server-injection
      // property the test above already covers on first paint.
      await guestPage.goto(baseUrl)
      await expect(guestPage.locator('html')).toHaveAttribute('data-theme', 'tiles')
      await expect(guestPage.getByTestId('guest-screen')).toBeVisible()
    } finally {
      await adminContext.close()
      await guestContext.close()
    }
  })

  /**
   * The first screen anyone sees on a new install, and new on this branch: a
   * deployment is born with no portals, so there is nothing to show a guest and
   * nothing for the owner to edit until they make one. A harness of its own,
   * because every other test in this file needs the opposite.
   */
  test('first run: an empty deployment lands the owner on the create-portal screen', async ({
    browser,
  }) => {
    const fresh = await startHarness()
    const adminContext = await browser.newContext()
    const guestContext = await browser.newContext()
    const adminPage = await adminContext.newPage()
    const guestPage = await guestContext.newPage()

    try {
      const { baseUrl } = fresh

      await loginAsAdmin(adminPage, baseUrl)

      // There is no portal, so none of the portal chrome exists: no dropdown to
      // switch between them, no Edit, no per-portal settings.
      await expect(adminPage.getByRole('heading', { name: 'Create a portal' })).toBeVisible()
      await expect(adminPage.getByRole('combobox', { name: 'Portal' })).toHaveCount(0)
      await expect(adminPage.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
      await expect(adminPage.getByRole('button', { name: /Portal settings/ })).toHaveCount(0)

      // The deployment gear does exist here, and has to: pairing the Home
      // Assistant integration by hand needs the token behind it, and an owner
      // who cannot reach it before making their first portal is stuck.
      await adminPage.getByRole('button', { name: 'Settings' }).click()
      await expect(adminPage.getByTestId('deployment-settings-panel')).toBeVisible()
      await adminPage.getByRole('button', { name: 'Close' }).click()

      await createPortalThroughUi(adminPage, {
        title: 'Lake House',
        password: 'lake-house-portal-pw',
      })
      await expect(adminPage.getByRole('combobox', { name: 'Portal' })).toContainText('Lake House')

      // The password the owner typed into that form is the one a guest logs in
      // with. Nowhere else in this suite is a portal password both set and used
      // through the UI, and it is the only thing standing between the two.
      await guestPage.goto(baseUrl)
      await guestPage.getByLabel('Password').fill('lake-house-portal-pw')
      await guestPage.getByRole('button', { name: 'Log in' }).click()
      await expect(guestPage.getByTestId('guest-screen')).toBeVisible()
      await expect(guestPage.getByRole('heading', { name: 'Lake House' })).toBeVisible()
    } finally {
      await adminContext.close()
      await guestContext.close()
      await fresh.cleanup()
    }
  })
})
