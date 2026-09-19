import { test, expect, type Page } from '@playwright/test'
import { startHarness, startHarnessBootOrder, type TestHarness } from './harness.js'

let harness: TestHarness

test.beforeAll(async () => {
  harness = await startHarness()
})

test.afterAll(async () => {
  if (harness) {
    await harness.cleanup()
  }
})

async function loginAsAdmin(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl)
  await page.getByLabel('Password').fill('test-admin-password')
  await page.getByRole('button', { name: 'Log in' }).click()

  // Wait for redirect to guest page after successful login
  await expect(page).toHaveURL(`${baseUrl}/`)
}

async function navigateToAdmin(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/admin`)
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

    // Step 2: Navigate to admin page
    await navigateToAdmin(page, baseUrl)

    // Wait for catalog to load
    await expect(page.getByPlaceholder(/search/i)).toBeVisible()

    // Step 3: Add multiple devices to show variety of tile types
    // Add light first
    await page.getByPlaceholder(/search/i).fill('porch')
    await expect(page.getByText('Porch Light')).toBeVisible()
    await page.getByText('Porch Light').click()

    // Add cover
    await page.getByPlaceholder(/search/i).fill('garage')
    await expect(page.getByText('Garage Door')).toBeVisible()
    await page.getByText('Garage Door').click()

    // Add lock
    await page.getByPlaceholder(/search/i).fill('front door')
    await expect(page.getByText('Front Door Lock')).toBeVisible()
    await page.getByText('Front Door Lock').click()

    // Save the allowlist
    await page.getByRole('button', { name: /save/i }).click()
    await expect(page.getByText(/saved/i)).toBeVisible()

    // Screenshot: Admin screen with devices on allowlist and picker open
    await page.getByPlaceholder(/search/i).fill('lamp')
    await expect(page.getByText('Living Room Lamp')).toBeVisible()
    await page.screenshot({
      path: 'test/e2e/screenshots/02-admin-picker.png',
      fullPage: true,
      animations: 'disabled',
    })

    // Step 4: Navigate to guest page
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

    // Verify the tile has the blue 'on' styling
    await expect(lightTile).toHaveClass(/bg-blue-500/)
  })

  test('staleness: disconnect triggers stale UI state', async ({ page }) => {
    const { baseUrl, fake } = harness

    // Login and set up a device first
    await loginAsAdmin(page, baseUrl)
    await navigateToAdmin(page, baseUrl)
    await expect(page.getByPlaceholder(/search/i)).toBeVisible()

    // Add a device if not already present (idempotent)
    const searchBox = page.getByPlaceholder(/search/i)
    await searchBox.fill('porch')
    const porchLight = page.getByText('Porch Light')

    // Only add if the allowlist is empty or doesn't have this device
    if (await porchLight.isVisible({ timeout: 1000 }).catch(() => false)) {
      await porchLight.click()
      await page.getByRole('button', { name: /save/i }).click()
      await expect(page.getByText(/saved/i)).toBeVisible()
    }

    // Navigate to guest view
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

    // Verify the stale tile is NOT painted as the active blue
    const bg = await tile.evaluate((el) => window.getComputedStyle(el).backgroundColor)
    // Tailwind v4 blue-500 in oklch is oklch(62.3% .214 259.815)
    // which computes to approximately rgb(59, 130, 246)
    expect(bg).not.toBe('rgb(59, 130, 246)')

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
      await page.getByLabel('Password').fill('test-admin-password')
      await page.getByRole('button', { name: 'Log in' }).click()
      await expect(page).toHaveURL(`${baseUrl}/`)

      // Navigate to admin
      await page.goto(`${baseUrl}/admin`)

      // At this point, HA is unreachable, so the catalog won't load
      // We expect to see an error message
      await expect(page.getByText(/failed to load catalog/i)).toBeVisible({
        timeout: 10000,
      })

      // Step 2: Now start the fake Home Assistant
      await bootHarness.startHA()

      // Give the connection a moment to establish
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Step 3: Click retry to load the catalog now that HA is available
      await page.getByRole('button', { name: /retry/i }).click()

      // Wait for catalog to load
      await expect(page.getByPlaceholder(/search/i)).toBeVisible({ timeout: 10000 })

      // Add a device
      await page.getByPlaceholder(/search/i).fill('porch')
      await expect(page.getByText('Porch Light')).toBeVisible()
      await page.getByText('Porch Light').click()
      await page.getByRole('button', { name: /save/i }).click()
      await expect(page.getByText(/saved/i)).toBeVisible()

      // Step 4: Navigate to guest page
      await page.goto(baseUrl)

      // Step 5: Tiles should populate with real state from HA
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
      // Step 1: Guest signs in and reaches the device list
      await guestPage.goto(baseUrl)
      await guestPage.getByLabel('Password').fill('test-guest-password')
      await guestPage.getByRole('button', { name: 'Log in' }).click()
      await expect(guestPage.getByTestId('guest-screen')).toBeVisible()

      // Step 2: Admin signs in and turns the portal off
      await adminPage.goto(`${baseUrl}/admin`)
      await adminPage.getByLabel('Password').fill('test-admin-password')
      await adminPage.getByRole('button', { name: 'Log in' }).click()
      await expect(adminPage.getByTestId('portal-toggle')).toBeChecked()

      await adminPage.getByTestId('portal-toggle').uncheck()
      await expect(adminPage.getByTestId('portal-disabled-banner')).toBeVisible()

      // Step 3: The guest's stream is dropped, the client rechecks, and lands on disabled screen
      // This proves the SSE-drop → session-recheck path works
      // 5s timeout: fast path is ~800ms, this gives 6× headroom while staying well below
      // the 15s poll, ensuring the poll cannot satisfy this assertion
      await expect(guestPage.getByTestId('portal-disabled-screen')).toBeVisible({
        timeout: 5000,
      })

      // Step 4: The admin page keeps working while the portal is off
      await expect(adminPage.getByTestId('admin-screen')).toBeVisible()

      // Step 5: Turning it back on restores the guest without a fresh login
      await adminPage.getByTestId('portal-toggle').check()
      await expect(adminPage.getByTestId('portal-disabled-banner')).not.toBeVisible()

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
})
