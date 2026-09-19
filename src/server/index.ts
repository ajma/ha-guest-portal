import { loadConfig } from './config.js'
import { openDb } from './store/db.js'
import { AllowlistStore } from './store/allowlist.js'
import { AuditLog } from './store/auditlog.js'
import { SettingsStore } from './store/settings.js'
import { SessionStore, LoginRateLimiter } from './http/auth.js'
import { SseHub } from './http/sse.js'
import { HaClient } from './ha/client.js'
import { createRuntime } from './runtime.js'

async function main() {
  // Load configuration
  const cfg = loadConfig(process.env)

  // Open database
  const db = openDb(cfg.dbPath)

  // Construct components
  const allowlist = new AllowlistStore(db)
  const audit = new AuditLog(db)
  const settings = new SettingsStore(db)
  const sessions = new SessionStore()
  const limiter = new LoginRateLimiter()
  const hub = new SseHub()
  const ha = HaClient.create({
    haBaseUrl: cfg.haBaseUrl,
    haToken: cfg.haToken,
    haWsUrl: cfg.haWsUrl,
  })

  // Set initial watched entities
  // This is safe to call before HA is reachable - the client defers it
  // Do NOT wrap this in try/catch that swallows failure - silently never
  // subscribing is a failure mode this project has gone to trouble to eliminate
  await ha.setWatchedEntities(allowlist.entityIds())

  // Start HA client
  ha.start()

  // Create runtime (wires all the event handlers and creates servers)
  const runtime = createRuntime({
    cfg,
    ha,
    allowlist,
    audit,
    settings,
    sessions,
    limiter,
    hub,
  })

  // Start listening on direct port
  runtime.servers[0]?.listen(cfg.port)
  console.log(`Direct port listening on ${cfg.port}`)

  // Start listening on ingress port if configured
  if (cfg.ingressPort && runtime.servers[1]) {
    runtime.servers[1].listen(cfg.ingressPort)
    console.log(`Ingress port listening on ${cfg.ingressPort}`)
  }

  // Graceful shutdown on SIGTERM and SIGINT
  const shutdown = async () => {
    console.log('Shutting down...')

    // Force exit after 5 seconds if graceful shutdown hangs
    const forceExit = setTimeout(() => {
      console.error('Forced shutdown after timeout')
      process.exit(1)
    }, 5000)
    forceExit.unref()

    try {
      await runtime.close()
      clearTimeout(forceExit)
      console.log('Server closed')
      process.exit(0)
    } catch (error) {
      console.error('Error during shutdown:', error)
      process.exit(1)
    }
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
