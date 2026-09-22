import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeHomeAssistant } from '../fake-ha.js'

export type TestHarness = {
  baseUrl: string
  fake: FakeHomeAssistant
  cleanup: () => Promise<void>
}

/**
 * The one password this deployment is born with. Every portal password is
 * created after the fact, through the admin API below — there is no longer a
 * guest password in the environment for a test to reach for.
 */
export const ADMIN_PASSWORD = 'test-admin-password'

export type SeedDevice = {
  entityId: string
  label: string
  allowedActions: string[]
  sortOrder: number
}

export type SeededPortal = {
  id: string
  title: string
  theme: string
  enabled: boolean
  /** The password a guest of this portal logs in with. */
  password: string
}

/**
 * A fresh deployment has no portals at all, so every spec has to make one
 * before it has anything to test. These go through the real admin HTTP API
 * rather than touching the database: the routes are the contract the web
 * client uses, so a spec seeded this way fails if they move, instead of
 * quietly testing a shape the server stopped serving.
 *
 * Node's `fetch` rather than Playwright's `page.request`, because the seeding
 * must not put an admin session into the browser context a test then logs into
 * as a guest.
 */
export class AdminApi {
  private constructor(
    readonly baseUrl: string,
    private readonly cookie: string,
  ) {}

  static async login(baseUrl: string): Promise<AdminApi> {
    const response = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    })
    if (!response.ok) {
      throw new Error(`admin login failed: ${response.status} ${await response.text()}`)
    }
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (cookie === undefined) throw new Error('admin login returned no session cookie')
    return new AdminApi(baseUrl, cookie)
  }

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`)
    }
    return response.json()
  }

  async createPortal(input: { title: string; password: string }): Promise<SeededPortal> {
    const created = (await this.send('POST', '/api/admin/portals', input)) as SeededPortal
    return created
  }

  async updatePortal(
    portalId: string,
    patch: { title?: string; theme?: string; enabled?: boolean; password?: string },
  ): Promise<SeededPortal> {
    return (await this.send('PUT', `/api/admin/portals/${portalId}`, patch)) as SeededPortal
  }

  async setAllowlist(portalId: string, devices: SeedDevice[]): Promise<void> {
    await this.send('PUT', `/api/admin/portals/${portalId}/allowlist`, { devices })
  }

  /**
   * What the admin UI writes when an owner picks a portal from the dropdown.
   * It is also what decides which portal's theme the server injects into an
   * admin's index.html, so a spec that asserts on that has to set it.
   */
  async selectPortal(portalId: string): Promise<void> {
    await this.send('PUT', '/api/admin/last-selected-portal', { portalId })
  }
}

/** Create a portal, give it devices, and (optionally) a theme, in one call. */
export async function seedPortal(
  baseUrl: string,
  spec: {
    title: string
    password: string
    devices?: SeedDevice[]
    theme?: string
    /** Point the admin's last-selected pointer at this portal. */
    select?: boolean
  },
): Promise<SeededPortal> {
  const admin = await AdminApi.login(baseUrl)
  let portal = await admin.createPortal({ title: spec.title, password: spec.password })
  if (spec.theme !== undefined) {
    portal = await admin.updatePortal(portal.id, { theme: spec.theme })
  }
  if (spec.devices !== undefined) {
    await admin.setAllowlist(portal.id, spec.devices)
  }
  if (spec.select === true) {
    await admin.selectPortal(portal.id)
  }
  return portal
}

function getSeedData() {
  return {
    entities: [
      {
        entityId: 'light.porch',
        name: 'Porch Light',
        areaId: 'front_yard',
        state: 'off',
        attributes: { brightness: 0 },
      },
      {
        entityId: 'cover.garage_door',
        name: 'Garage Door',
        areaId: 'garage',
        state: 'closed',
        attributes: { current_position: 0 },
      },
      {
        entityId: 'lock.front_door',
        name: 'Front Door Lock',
        areaId: 'front_yard',
        state: 'locked',
        attributes: {},
      },
      {
        entityId: 'switch.living_room_lamp',
        name: 'Living Room Lamp',
        areaId: 'living_room',
        state: 'off',
        attributes: {},
      },
    ],
    areas: [
      { areaId: 'front_yard', name: 'Front Yard' },
      { areaId: 'garage', name: 'Garage' },
      { areaId: 'living_room', name: 'Living Room' },
    ],
  }
}

export async function startHarness(): Promise<TestHarness> {
  const fake = await FakeHomeAssistant.start({ token: 'test-token' })

  // Seed with test entities across multiple domains
  const seed = getSeedData()
  fake.seed(seed.entities, seed.areas)

  // Create temporary database path
  const tempDir = mkdtempSync(join(tmpdir(), 'ha-portal-e2e-'))
  const dbPath = join(tempDir, 'test.db')

  // Spawn the server process
  const serverProcess = await startServer({
    haBaseUrl: fake.baseUrl,
    haToken: fake.token,
    dbPath,
  })

  const baseUrl = `http://127.0.0.1:${serverProcess.port}`

  // Wait for server to be ready
  await waitForServer(baseUrl)

  return {
    baseUrl,
    fake,
    cleanup: async () => {
      // Kill server process
      if (serverProcess.child.pid) {
        serverProcess.child.kill('SIGTERM')
        // Give it a moment to shut down gracefully
        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      // Stop fake HA
      await fake.stop()

      // Clean up temp directory
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}

type ServerProcess = {
  child: ChildProcess
  port: number
}

async function startServer(opts: {
  haBaseUrl: string
  haToken: string
  dbPath: string
}): Promise<ServerProcess> {
  // Use an ephemeral port (0 = OS assigns)
  const port = await getEphemeralPort()

  const child = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      HA_BASE_URL: opts.haBaseUrl,
      HA_TOKEN: opts.haToken,
      ADMIN_PASSWORD,
      PORT: String(port),
      DB_PATH: opts.dbPath,
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
  })

  // Log server output for debugging
  child.stdout?.on('data', (data) => {
    console.log(`[server] ${data.toString().trim()}`)
  })

  child.stderr?.on('data', (data) => {
    console.error(`[server error] ${data.toString().trim()}`)
  })

  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`Server process exited with code ${code}, signal ${signal}`)
    }
  })

  return { child, port }
}

async function getEphemeralPort(): Promise<number> {
  const { createServer } = await import('node:http')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error('Failed to get ephemeral port'))
      }
    })
  })
}

async function waitForServer(baseUrl: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) {
        const data: unknown = await response.json()
        if (typeof data === 'object' && data !== null && 'ok' in data && data.ok === true) {
          return
        }
      }
    } catch {
      // Server not ready yet
    }

    // Wait 100ms before next attempt
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Server failed to become ready within ${timeoutMs}ms`)
}

export async function startHarnessBootOrder(): Promise<
  TestHarness & { startHA: () => Promise<void> }
> {
  // Pick a free port for the fake HA
  const haPort = await getEphemeralPort()

  // Create temporary database path
  const tempDir = mkdtempSync(join(tmpdir(), 'ha-portal-e2e-'))
  const dbPath = join(tempDir, 'test.db')

  // Spawn the server process BEFORE HA is available
  const serverProcess = await startServer({
    haBaseUrl: `http://127.0.0.1:${haPort}`,
    haToken: 'test-token',
    dbPath,
  })

  const baseUrl = `http://127.0.0.1:${serverProcess.port}`

  // Wait for server to be ready (it should handle HA being unreachable)
  await waitForServer(baseUrl)

  let fake: FakeHomeAssistant | null = null

  return {
    baseUrl,
    get fake(): FakeHomeAssistant {
      if (!fake) throw new Error('HA not started yet - call startHA() first')
      return fake
    },
    startHA: async () => {
      // Now start the fake HA on the pre-allocated port
      fake = await FakeHomeAssistant.start({ token: 'test-token', port: haPort })
      const seed = getSeedData()
      fake.seed(seed.entities, seed.areas)
    },
    cleanup: async () => {
      if (serverProcess.child.pid) {
        serverProcess.child.kill('SIGTERM')
        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      if (fake) {
        await fake.stop()
      }

      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}
