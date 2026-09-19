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
      GUEST_PASSWORD: 'test-guest-password',
      ADMIN_PASSWORD: 'test-admin-password',
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
