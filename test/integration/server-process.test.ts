import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = join(import.meta.dirname, '..', '..')

describe('Server process smoke test', () => {
  it('stays alive for 8+ seconds and exits cleanly on SIGTERM', async () => {
    // Server-only compile, not the full `pnpm build`: `pnpm build` also runs
    // `vite build`, and the web app does not bundle right now (src/web/api.ts
    // still imports schemas removed earlier in this plan; a later task in
    // this same plan restores it). This test only exercises the server
    // process's lifecycle and never reads dist/web, so building just the
    // server side keeps it decoupled from that already-tracked, unrelated gap
    // instead of failing for a reason it isn't testing.
    let buildOutput = ''
    const buildProc = spawn('pnpm', ['exec', 'tsc', '-p', 'tsconfig.server.json'], {
      cwd: projectRoot,
    })
    buildProc.stdout?.on('data', (data) => {
      buildOutput += data.toString()
      process.stdout.write(data)
    })
    buildProc.stderr?.on('data', (data) => {
      buildOutput += data.toString()
      process.stderr.write(data)
    })

    const buildCode = await new Promise<number | null>((resolve) => {
      buildProc.on('close', resolve)
    })

    // `noEmitOnError` is not set, so `tsc` still emits dist/server/index.js
    // even when the build fails — which is exactly why a non-zero build must
    // not be swallowed here. This test's whole job is "does the built server
    // actually start"; letting it start from a build that failed to compile
    // would report green for a server that doesn't type-check.
    if (buildCode !== 0) {
      throw new Error(`Build failed:\n${buildOutput}`)
    }

    // Spawn the built server
    const proc = spawn('node', ['dist/server/index.js'], {
      cwd: projectRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        HA_BASE_URL: 'http://127.0.0.1:1', // Unreachable - no HA needed
        HA_TOKEN: 'test-token',
        ADMIN_PASSWORD: 'admin-password-test',
        PORT: String(18000 + Math.floor(Math.random() * 1000)), // Random high port
        DB_PATH: ':memory:',
      },
    })

    let output = ''
    let listening = false

    proc.stdout?.on('data', (data) => {
      output += data.toString()
      if (data.toString().includes('Direct port listening')) {
        listening = true
      }
    })

    proc.stderr?.on('data', (data) => {
      output += data.toString()
    })

    try {
      // Wait for server to be listening
      const waitStart = Date.now()
      while (!listening && Date.now() - waitStart < 5000) {
        await new Promise((r) => setTimeout(r, 100))
      }

      if (!listening) {
        console.error('Server output:', output)
      }

      expect(listening).toBe(true)

      // Wait 8 seconds - this catches the force-exit-at-startup bug
      await new Promise((r) => setTimeout(r, 8000))

      // Verify still alive
      expect(proc.exitCode).toBeNull()

      // Send SIGTERM
      const termStart = Date.now()
      proc.kill('SIGTERM')

      // Wait for clean exit
      const exitCode = await new Promise<number | null>((resolve) => {
        proc.on('close', (code) => resolve(code))
        // Timeout after 3 seconds
        setTimeout(() => resolve(null), 3000)
      })

      const termDuration = Date.now() - termStart

      // Verify clean exit
      expect(exitCode).toBe(0)
      expect(termDuration).toBeLessThan(3000)
    } finally {
      // Ensure cleanup
      if (proc.exitCode === null) {
        proc.kill('SIGKILL')
      }
    }
  }, 20000)

  it('close() is idempotent', async () => {
    const { createRuntime } = await import('../../src/server/runtime.ts')
    const { HaClient } = await import('../../src/server/ha/client.ts')
    const { SessionStore, LoginRateLimiter } = await import('../../src/server/http/auth.ts')
    const { SseHub } = await import('../../src/server/http/sse.ts')
    const { AllowlistStore } = await import('../../src/server/store/allowlist.ts')
    const { AuditLog } = await import('../../src/server/store/auditlog.ts')
    const { SettingsStore } = await import('../../src/server/store/settings.ts')
    const { InteractionStore } = await import('../../src/server/store/interactions.ts')
    const { PortalStore } = await import('../../src/server/store/portals.ts')
    const { openDb } = await import('../../src/server/store/db.ts')

    const db = openDb(':memory:')
    const allowlist = new AllowlistStore(db)
    const audit = new AuditLog(db)
    const settings = new SettingsStore(db)
    const interactions = new InteractionStore(db)
    const portals = new PortalStore(db)
    const sessions = new SessionStore()
    const limiter = new LoginRateLimiter()
    const hub = new SseHub()
    const ha = HaClient.create({
      haBaseUrl: 'http://127.0.0.1:1',
      haToken: 'test-token',
    })

    const runtime = createRuntime({
      cfg: {
        haBaseUrl: 'http://127.0.0.1:1',
        haWsUrl: undefined,
        haToken: 'test-token',
        adminPassword: 'admin-pass',
        port: 18999,
        ingressPort: undefined,
        dbPath: ':memory:',
        trustProxy: undefined,
      },
      ha,
      allowlist,
      audit,
      settings,
      interactions,
      portals,
      sessions,
      limiter,
      hub,
    })

    // Start server
    const directServer = runtime.servers[0]
    if (!directServer) throw new Error('No server created')
    await new Promise<void>((resolve) => {
      directServer.listen(18999, '127.0.0.1', () => resolve())
    })

    // First close should succeed
    await runtime.close()

    // Second close should not throw
    await expect(runtime.close()).resolves.toBeUndefined()

    db.close()
  })

  it('refuses to start when ADMIN_PASSWORD collides with a portal password', async () => {
    // This is the only file that boots the real server process. The
    // collision guard (config.ts's assertNoAdminPasswordCollision) is well
    // unit-tested in isolation, but its call site in index.ts had no
    // coverage at all: deleting that call left the whole suite green. Guard
    // the call site itself by actually booting the server into the state it
    // exists to refuse.
    const { openDb } = await import('../../src/server/store/db.ts')
    const { PortalStore } = await import('../../src/server/store/portals.ts')

    const workDir = mkdtempSync(join(tmpdir(), 'server-process-collision-'))
    const dbPath = join(workDir, 'portal.db')
    const collidingPassword = `collide-${randomUUID()}`

    const seedDb = openDb(dbPath)
    const portal = new PortalStore(seedDb).create({ title: 'Barn', password: collidingPassword })
    seedDb.close()

    const proc = spawn('node', ['dist/server/index.js'], {
      cwd: projectRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        HA_BASE_URL: 'http://127.0.0.1:1', // Unreachable - no HA needed
        HA_TOKEN: 'test-token',
        ADMIN_PASSWORD: collidingPassword,
        PORT: String(18000 + Math.floor(Math.random() * 1000)),
        DB_PATH: dbPath,
      },
    })

    let output = ''
    proc.stdout?.on('data', (data) => {
      output += data.toString()
    })
    proc.stderr?.on('data', (data) => {
      output += data.toString()
    })

    try {
      const exitCode = await new Promise<number | null>((resolve) => {
        proc.on('close', (code) => resolve(code))
        setTimeout(() => resolve(null), 5000)
      })

      expect(exitCode).not.toBeNull()
      expect(exitCode).not.toBe(0)
      expect(output).toContain('ADMIN_PASSWORD is also the guest password for')
      expect(output).toContain(`"${portal.title}" (${portal.id})`)
      // The message names the colliding portal, never the password itself.
      expect(output).not.toContain(collidingPassword)
    } finally {
      if (proc.exitCode === null) proc.kill('SIGKILL')
      rmSync(workDir, { recursive: true, force: true })
    }
  }, 10000)
})
