import { expect, test } from '@playwright/test'
import {
  ADMIN_PASSWORD,
  AdminApi,
  seedPortal,
  startHarness,
  type SeededPortal,
  type TestHarness,
} from './harness.js'

/**
 * The property this whole refactor exists to provide: two portals in one
 * deployment are two separate houses. A guest holding one portal's password
 * must not be able to see, or touch, anything belonging to the other — not
 * through the UI, and not by naming the other portal in a request of their
 * own.
 *
 * Every other spec in this suite runs against a single portal, where a server
 * that ignored portal scoping entirely would look perfectly healthy. This one
 * is the reason the scoping is there.
 */
let harness: TestHarness
let admin: AdminApi
let beach: SeededPortal
let lodge: SeededPortal

const BEACH_PASSWORD = 'beach-house-pw'
const LODGE_PASSWORD = 'ski-lodge-pw'

// Disjoint device sets, so "did not leak" is a statement about a named device
// rather than about an empty screen. Each portal's device is also the other's
// canary: the positive assertion that a guest DOES see their own is what stops
// the negative one passing against a portal that renders nothing at all.
const BEACH_DEVICE = { entityId: 'light.porch', label: 'Porch Light' }
const LODGE_DEVICE = { entityId: 'lock.front_door', label: 'Front Door Lock' }

test.beforeAll(async () => {
  harness = await startHarness()
  admin = await AdminApi.login(harness.baseUrl)

  beach = await seedPortal(harness.baseUrl, {
    title: 'Beach House',
    password: BEACH_PASSWORD,
    devices: [
      { ...BEACH_DEVICE, allowedActions: ['turn_on', 'turn_off', 'toggle'], sortOrder: 0 },
    ],
    select: true,
  })

  lodge = await seedPortal(harness.baseUrl, {
    title: 'Ski Lodge',
    password: LODGE_PASSWORD,
    devices: [{ ...LODGE_DEVICE, allowedActions: ['lock', 'unlock'], sortOrder: 0 }],
  })
})

test.afterAll(async () => {
  if (harness) {
    await harness.cleanup()
  }
})

test.describe('Cross-portal isolation', () => {
  test('a guest of one portal never sees the other portal’s devices', async ({ browser }) => {
    const { baseUrl } = harness

    const beachContext = await browser.newContext()
    const lodgeContext = await browser.newContext()
    const beachPage = await beachContext.newPage()
    const lodgePage = await lodgeContext.newPage()

    try {
      // Two guests, signed in at the same time, in browser contexts that share
      // no cookies — the situation the deployment actually ships into.
      for (const [page, password] of [
        [beachPage, BEACH_PASSWORD],
        [lodgePage, LODGE_PASSWORD],
      ] as const) {
        await page.goto(baseUrl)
        await page.getByLabel('Password').fill(password)
        await page.getByRole('button', { name: 'Log in' }).click()
        await expect(page.getByTestId('guest-screen')).toBeVisible()
      }

      // Each guest is in their own portal: their header names it, and the tile
      // grid they were streamed holds their device and only their device.
      await expect(beachPage.getByRole('heading', { name: 'Beach House' })).toBeVisible()
      await expect(beachPage.getByText(BEACH_DEVICE.label)).toBeVisible()
      await expect(beachPage.getByText(LODGE_DEVICE.label)).toHaveCount(0)

      await expect(lodgePage.getByRole('heading', { name: 'Ski Lodge' })).toBeVisible()
      await expect(lodgePage.getByText(LODGE_DEVICE.label)).toBeVisible()
      await expect(lodgePage.getByText(BEACH_DEVICE.label)).toHaveCount(0)

      // A device added to one portal after the fact arrives on that portal's
      // stream and nowhere else. Without this, a server that scoped the
      // initial snapshot but broadcast every later change to everyone would
      // still pass everything above.
      //
      // Written from outside the browser, through the harness's own admin
      // client: signing in as the admin from either of these pages would
      // replace the guest session in that context's cookie jar.
      await admin.setAllowlist(lodge.id, [
        { ...LODGE_DEVICE, allowedActions: ['lock', 'unlock'], sortOrder: 0 },
        {
          entityId: 'switch.living_room_lamp',
          label: 'Living Room Lamp',
          allowedActions: ['turn_on', 'turn_off', 'toggle'],
          sortOrder: 1,
        },
      ])

      // The lodge's guest gets it over their open stream…
      await expect(lodgePage.getByText('Living Room Lamp')).toBeVisible({ timeout: 5000 })
      // …and the beach guest, still signed in and still streaming, does not.
      await expect(beachPage.getByText('Living Room Lamp')).toHaveCount(0)
    } finally {
      await beachContext.close()
      await lodgeContext.close()
    }
  })

  test('a guest’s portal is their session’s, not whichever one they name', async ({ playwright }) => {
    const { baseUrl, fake } = harness

    // A request context of its own: this is the guest with their own cookie,
    // asking the server directly for things the UI would never ask for.
    const guest = await playwright.request.newContext({ baseURL: baseUrl })

    try {
      const login = await guest.post('/api/login', { data: { password: BEACH_PASSWORD } })
      expect(login.status()).toBe(200)
      expect(((await login.json()) as { portalId: string }).portalId).toBe(beach.id)

      // `?portalId=` is how an ADMIN says which portal they mean. A guest's
      // portal comes from their session, so naming another one must change
      // nothing at all — not the session, not the device list.
      const session = await guest.get(`/api/session?portalId=${lodge.id}`)
      expect(session.status()).toBe(200)
      expect(((await session.json()) as { portalId: string }).portalId).toBe(beach.id)

      const devices = await guest.get(`/api/devices?portalId=${lodge.id}`)
      expect(devices.status()).toBe(200)
      const body = (await devices.json()) as { devices: { label: string }[] }
      expect(body.devices.map((device) => device.label)).toEqual([BEACH_DEVICE.label])

      // Reading is half of it. The other half is actuation: the lock belongs
      // to the other portal, so it is not merely refused, it is 404 — the
      // server does not confirm that the entity exists at all.
      const callsBefore = fake.serviceCalls.length
      const action = await guest.post(
        `/api/devices/${LODGE_DEVICE.entityId}/lock?portalId=${lodge.id}`,
      )
      expect(action.status()).toBe(404)
      expect(fake.serviceCalls.length, 'a cross-portal action reached Home Assistant').toBe(
        callsBefore,
      )

      // The same call against their OWN device succeeds, so the 404 above is
      // about the portal boundary and not about a guest being unable to do
      // anything at all.
      const own = await guest.post(`/api/devices/${BEACH_DEVICE.entityId}/turn_on`)
      expect(own.status()).toBe(200)
    } finally {
      await guest.dispose()
    }
  })

  test('an owner switching portals switches which portal they are editing', async ({ page }) => {
    const { baseUrl } = harness

    await page.goto(baseUrl)
    await page.getByLabel('Password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: 'Log in' }).click()

    // One admin identity reaches every portal — but only one at a time, and
    // the grid has to follow the dropdown. A stale stream here would show the
    // owner one portal's devices under another portal's name, which is how a
    // device ends up allowed on the wrong portal.
    const dropdown = page.getByRole('combobox', { name: 'Portal' })
    await dropdown.selectOption({ label: 'Beach House' })
    await expect(page.getByText(BEACH_DEVICE.label)).toBeVisible()
    await expect(page.getByText(LODGE_DEVICE.label)).toHaveCount(0)

    await dropdown.selectOption({ label: 'Ski Lodge' })
    await expect(page.getByText(LODGE_DEVICE.label)).toBeVisible()
    await expect(page.getByText(BEACH_DEVICE.label)).toHaveCount(0)
  })
})
