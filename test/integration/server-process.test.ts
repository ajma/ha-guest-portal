import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Server process smoke test', () => {
  it('stays alive for 8+ seconds and exits cleanly on SIGTERM', async () => {
    // Build first (ensure dist exists)
    const buildProc = spawn('pnpm', ['build'], {
      cwd: '/home/andm/workspace/ha-guest-portal',
      stdio: 'inherit', // Show build output
    })

    const buildCode = await new Promise<number | null>((resolve) => {
      buildProc.on('close', resolve)
    })

    if (buildCode !== 0) {
      throw new Error(`Build failed with code ${buildCode}`)
    }

    // Spawn the built server
    const proc = spawn('node', ['dist/server/index.js'], {
      cwd: '/home/andm/workspace/ha-guest-portal',
      stdio: 'pipe',
      env: {
        ...process.env,
        HA_BASE_URL: 'http://127.0.0.1:1', // Unreachable - no HA needed
        HA_TOKEN: 'test-token',
        GUEST_PASSWORD: 'guest-password-test',
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
    const { openDb } = await import('../../src/server/store/db.ts')

    const db = openDb(':memory:')
    const allowlist = new AllowlistStore(db)
    const audit = new AuditLog(db)
    const settings = new SettingsStore(db)
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
        guestPassword: 'guest-pass',
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
})
