import { expect, test } from '@playwright/test'
import { startHarness, type TestHarness } from './harness.js'

/**
 * The requirement this whole feature exists for, tested rather than argued
 * about: a guest opens the installed portal somewhere it cannot be reached and
 * gets the portal's own explanation instead of the browser's error page.
 *
 * Service workers need a secure context. `127.0.0.1` is one by definition, so
 * the harness works unmodified over plain HTTP.
 */
let harness: TestHarness

/**
 * A lock, specifically. The spec's objection to caching `/api/*` is not
 * abstract — it is that a guest could be shown a lock reading "Locked" as of an
 * hour ago. Seeding one means the test can assert that exact string is absent
 * offline, so a worker that cached the API fails on the harm itself rather than
 * on a proxy for it.
 */
async function seedLock(baseUrl: string): Promise<void> {
  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-admin-password' }),
  })
  if (!login.ok) throw new Error(`admin login failed: ${login.status}`)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('no session cookie')

  const put = await fetch(`${baseUrl}/api/admin/allowlist`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      devices: [
        {
          entityId: 'lock.front_door',
          label: 'Front Door Lock',
          allowedActions: ['lock', 'unlock'],
          sortOrder: 1,
        },
      ],
    }),
  })
  if (!put.ok) throw new Error(`allowlist put failed: ${put.status} ${await put.text()}`)
}

test.beforeAll(async () => {
  harness = await startHarness()
  await seedLock(harness.baseUrl)
})

test.afterAll(async () => {
  if (harness) {
    await harness.cleanup()
  }
})

test.describe('Offline', () => {
  test('an installed portal explains itself when it cannot be reached', async ({
    page,
    context,
  }) => {
    const { baseUrl } = harness

    await page.goto(baseUrl)
    await page.getByLabel('Password').fill('test-guest-password')
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page.getByTestId('guest-screen')).toBeVisible()

    // Online, the lock is on screen and reads Locked. Asserting it here is what
    // stops the offline `toHaveCount(0)` below from passing vacuously against a
    // portal that simply never showed a lock.
    await expect(page.getByText('Front Door Lock')).toBeVisible()
    await expect(page.getByText('Locked')).toBeVisible()

    // The worker controls the page only after it activates — `clients.claim()`
    // in sw.js is what sets this. Waiting on the condition rather than sleeping.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

    // One more online load, with the worker in charge. This is not padding: the
    // worker caches at runtime, and the first load's document and bundles were
    // fetched before it had claimed the page, so nothing is in the cache yet.
    // A real guest gets this for free — they install on one visit and open the
    // icon on another — and it is the recorded price of runtime caching over a
    // generated precache manifest.
    await page.reload()
    await expect(page.getByTestId('guest-screen')).toBeVisible()

    await context.setOffline(true)
    await page.reload()

    // The shell came from the cache; the session request did not, because the
    // worker never touches /api/*. So the app boots and immediately learns it
    // cannot reach the portal.
    await expect(page.getByTestId('portal-unreachable-screen')).toBeVisible()
    await expect(page.getByText(/can't reach the guest portal/i)).toBeVisible()

    // No trace of the signed-in portal, and no stale claim about the lock.
    //
    // Verified by mutation: dropping the `/api/` guard from sw.js caches
    // /api/session, and this offline reload then restores the whole guest
    // screen — header, Log out, device area — instead of the explanation. The
    // tile text stays empty there only because state arrives over SSE rather
    // than from a cached GET; the `Locked` assertion is what catches the day
    // that changes, and the `guest-screen` one is what catches it today.
    await expect(page.getByTestId('guest-screen')).toHaveCount(0)
    await expect(page.getByText('Locked')).toHaveCount(0)

    await context.setOffline(false)
    await page.getByRole('button', { name: /retry/i }).click()
    await expect(page.getByTestId('guest-screen')).toBeVisible()
    await expect(page.getByText('Locked')).toBeVisible()
  })

  test('the offline shell is the portal, not the browser error page', async ({ page, context }) => {
    const { baseUrl } = harness

    await page.goto(baseUrl)
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
    await page.reload()

    await context.setOffline(true)
    await page.reload()

    // Without a worker this reload lands on the browser's network-error page,
    // where the document has no #root and the server never got to inject a
    // theme. Both checks are about the *shell* rather than any one screen, so
    // this still fails if the unreachable screen is later renamed or restyled.
    await expect(page.locator('#root')).toHaveCount(1)
    await expect(page.locator('html')).toHaveAttribute('data-theme', /.+/)
  })
})
