import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const projectRoot = join(import.meta.dirname, '..', '..')
const configPath = join(projectRoot, 'config.yaml')
const runPath = join(projectRoot, 'run.sh')
const dockerfilePath = join(projectRoot, 'Dockerfile')
const packagePath = join(projectRoot, 'package.json')

/**
 * Puts a fake `node` first on PATH so `run.sh`'s closing `exec node
 * dist/server/index.js` runs it instead of the real server, and it just
 * dumps its environment. That's what turns "does run.sh export the right
 * variables" from a regex over the script's text into something actually
 * executed: this drives the real script, through the real `if`/`jq` logic,
 * and inspects the environment it hands off to the process it execs.
 */
function makeStubNodeBin(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'node'), '#!/bin/sh\nenv\n')
  chmodSync(join(dir, 'node'), 0o755)
}

/** Runs the real run.sh with a stub `node` on PATH and a scratch APP_DIR, so
 * `cd "$APP_DIR"` doesn't depend on the real container layout existing. */
function runAddonScript(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const workDir = mkdtempSync(join(tmpdir(), 'run-sh-test-'))
  const binDir = join(workDir, 'bin')
  makeStubNodeBin(binDir)
  const appDir = join(workDir, 'app')
  mkdirSync(appDir, { recursive: true })

  const result = spawnSync('sh', [runPath], {
    cwd: projectRoot,
    encoding: 'utf-8',
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      APP_DIR: appDir,
      ...env,
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function writeOptions(admin_password: string | null): string {
  const workDir = mkdtempSync(join(tmpdir(), 'run-sh-options-'))
  const optionsPath = join(workDir, 'options.json')
  writeFileSync(optionsPath, JSON.stringify({ admin_password }))
  return optionsPath
}

describe('Home Assistant add-on configuration', () => {
  it('config.yaml and Dockerfile are at repository root', () => {
    // The repository root is the add-on folder - config.yaml and Dockerfile
    // must be at the root for the Supervisor to recognize and build the add-on
    const config = readFileSync(configPath, 'utf-8')
    const dockerfile = readFileSync(dockerfilePath, 'utf-8')
    expect(config.length).toBeGreaterThan(0)
    expect(dockerfile.length).toBeGreaterThan(0)
    expect(configPath).toBe(join(projectRoot, 'config.yaml'))
    expect(dockerfilePath).toBe(join(projectRoot, 'Dockerfile'))
  })

  it('homeassistant_api is true', () => {
    const config = readFileSync(configPath, 'utf-8')
    expect(config).toMatch(/homeassistant_api:\s*true/)
  })

  it('ingress is enabled for hybrid admin/guest access', () => {
    const config = readFileSync(configPath, 'utf-8')
    const ingressMatch = config.match(/^ingress:\s*(.+)$/m)
    expect(ingressMatch).toBeTruthy()
    if (ingressMatch?.[1]) {
      expect(ingressMatch[1].trim()).toBe('true')
    }
    // Also verify ingress_port is set
    const ingressPortMatch = config.match(/^ingress_port:\s*(.+)$/m)
    expect(ingressPortMatch).toBeTruthy()
    if (ingressPortMatch?.[1]) {
      expect(ingressPortMatch[1].trim()).toBe('8099')
    }
  })

  it('version matches package.json', () => {
    const config = readFileSync(configPath, 'utf-8')
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
    const versionMatch = config.match(/^version:\s*"?([^"\s]+)"?$/m)
    expect(versionMatch).toBeTruthy()
    if (versionMatch) {
      expect(versionMatch[1]).toBe(pkg.version)
    }
  })

  it('arch includes amd64', () => {
    const config = readFileSync(configPath, 'utf-8')
    // Match either YAML list format (- amd64) or inline array format
    const hasAmd64 = config.match(/arch:[\s\S]*?-\s*amd64/) || config.match(/arch:\s*\[.*amd64.*\]/)
    expect(hasAmd64).toBeTruthy()
  })

  it('every key in options has matching entry in schema', () => {
    const config = readFileSync(configPath, 'utf-8')

    // Extract options section
    const optionsMatch = config.match(/^options:\s*$(.*?)^(?:\w+:|$)/ms)
    expect(optionsMatch).toBeTruthy()
    if (!optionsMatch?.[1]) {
      throw new Error('Failed to match options section')
    }
    const optionsSection = optionsMatch[1]
    const optionKeys = [...optionsSection.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])

    // Extract schema section
    const schemaMatch = config.match(/^schema:\s*$(.*?)^(?:\w+:|$)/ms)
    expect(schemaMatch).toBeTruthy()
    if (!schemaMatch?.[1]) {
      throw new Error('Failed to match schema section')
    }
    const schemaSection = schemaMatch[1]
    const schemaKeys = [...schemaSection.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])

    expect(optionKeys.length).toBeGreaterThan(0)
    for (const key of optionKeys) {
      expect(schemaKeys).toContain(key)
    }
  })

  it('run.sh exists and is readable', () => {
    const script = readFileSync(runPath, 'utf-8')
    expect(script.length).toBeGreaterThan(0)
  })

  it('run.sh exports the add-on environment variables in add-on mode', () => {
    const script = readFileSync(runPath, 'utf-8')
    expect(script).toMatch(/export\s+HA_BASE_URL/)
    expect(script).toMatch(/export\s+HA_WS_URL/)
    expect(script).toMatch(/export\s+HA_TOKEN/)
    expect(script).toMatch(/export\s+ADMIN_PASSWORD/)
    expect(script).toMatch(/export\s+PORT/)
    expect(script).toMatch(/export\s+DB_PATH/)
    expect(script).toMatch(/export\s+INGRESS_PORT/)
  })

  it('run.sh never mentions GUEST_PASSWORD - portals carry their own passwords', () => {
    const script = readFileSync(runPath, 'utf-8')
    expect(script).not.toMatch(/export\s+GUEST_PASSWORD/)
    expect(script).not.toMatch(/GUEST_PASSWORD/)
    expect(script).not.toMatch(/guest_password/)
  })

  it('run.sh treats an empty or null admin_password as unconfigured, not fatal', () => {
    const script = readFileSync(runPath, 'utf-8')
    // An add-on with no admin_password is valid: admin is reached via ingress.
    // No guard may exit on an empty or null ADMIN_PASSWORD.
    expect(script).not.toMatch(/-z\s+"\$ADMIN_PASSWORD"[\s\S]{0,200}?exit\s+1/)
    expect(script).not.toMatch(/\$ADMIN_PASSWORD"?\s*=\s*"null"[\s\S]{0,200}?exit\s+1/)
    // And the export itself is conditional, so config.ts sees it genuinely unset
    // rather than as an empty string (which would fail the .min(8) check).
    expect(script).toMatch(
      /if\s+\[\s+-n\s+"\$ADMIN_PASSWORD"\s+\]\s+&&\s+\[\s+"\$ADMIN_PASSWORD"\s+!=\s+"null"\s+\]\s*;\s*then\s+export\s+ADMIN_PASSWORD/,
    )
  })
})

describe('config.yaml add-on options', () => {
  it('declares no guest_password option', () => {
    const config = readFileSync(configPath, 'utf-8')
    expect(config).not.toMatch(/guest_password/)
  })

  it('HA_WS_URL points at /core/websocket not /api/websocket', () => {
    const script = readFileSync(runPath, 'utf-8')
    expect(script).toMatch(/HA_WS_URL.*\/core\/websocket/)
    expect(script).not.toMatch(/HA_WS_URL.*\/api\/websocket/)
  })

  it('HA_TOKEN is derived from SUPERVISOR_TOKEN', () => {
    const script = readFileSync(runPath, 'utf-8')
    expect(script).toMatch(/HA_TOKEN.*SUPERVISOR_TOKEN/)
  })

  it('run.sh uses exec to start the server', () => {
    const script = readFileSync(runPath, 'utf-8')
    expect(script).toMatch(/exec\s+node/)
  })

  it('Dockerfile runtime stage uses node:24-alpine', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf-8')
    // Find the runtime stage (the second FROM after builder)
    // Match FROM node:24-alpine (not AS builder)
    const runtimeFromMatch = dockerfile.match(/^FROM node:24-alpine\s*$/m)
    expect(runtimeFromMatch).toBeTruthy()
  })

  it('Dockerfile installs jq, which run.sh needs to read options.json', () => {
    // run.sh's add-on branch parses /data/options.json with jq, and node:24-alpine
    // does not ship it — a container without this line starts, logs nothing
    // unusual, and exits 127 the moment the Supervisor runs it. CI cannot catch
    // that on its own: the check job installs jq so the end-to-end run.sh tests
    // can execute the real script, which means jq is present there whether or
    // not the image would have had it. This is the assertion that keeps the
    // runtime dependency honest.
    const dockerfile = readFileSync(dockerfilePath, 'utf-8')
    expect(dockerfile).toMatch(/^RUN apk add --no-cache .*\bjq\b/m)
  })

  it('Dockerfile has no USER directive (add-on runs as root, compose sets user)', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf-8')
    // The Dockerfile should not contain a USER directive
    // Add-on runs as root; docker-compose.yml sets user: node for plain Docker
    expect(dockerfile).not.toMatch(/^USER\s+/m)
  })

  it('run.sh detects add-on mode via SUPERVISOR_TOKEN, not file presence', () => {
    const script = readFileSync(runPath, 'utf-8')
    // Mode detection must key on SUPERVISOR_TOKEN (app cannot set environment)
    // not on /data/options.json presence (app can write /data in plain Docker)
    expect(script).toMatch(/if\s+\[\s+-n\s+"\$SUPERVISOR_TOKEN"\s+\]/)
    // Must not use file presence as the mode switch
    expect(script).not.toMatch(/if\s+\[\s+-f\s+\/data\/options\.json\s+\]/)
  })
})

// Every other describe block in this file asserts against run.sh's *text*.
// None of them execute it, so none would notice a refactor that changes the
// shape of the guard while preserving (or breaking) its behaviour. This is
// exactly how the original bug shipped: a fatal `admin_password` guard that
// read a since-removed option was textually present, and a regex-only test
// suite could not see what it actually did at runtime. These tests run the
// real script end to end with a stub `node` on PATH.
describe('run.sh executed end-to-end', () => {
  it('exports a real admin_password as ADMIN_PASSWORD, plus the rest of the add-on environment', () => {
    const { status, stdout } = runAddonScript({
      SUPERVISOR_TOKEN: 'test-supervisor-token',
      OPTIONS_PATH: writeOptions('a-real-admin-password'),
    })

    expect(status).toBe(0)
    expect(stdout).toMatch(/^ADMIN_PASSWORD=a-real-admin-password$/m)
    expect(stdout).toMatch(/^PORT=9123$/m)
    expect(stdout).toMatch(/^INGRESS_PORT=8099$/m)
    expect(stdout).toMatch(/^HA_BASE_URL=http:\/\/supervisor\/core$/m)
    expect(stdout).toMatch(/^HA_WS_URL=ws:\/\/supervisor\/core\/websocket$/m)
    expect(stdout).toMatch(/^HA_TOKEN=test-supervisor-token$/m)
    expect(stdout).toMatch(/^DB_PATH=\/data\/portal\.db$/m)
  })

  it('leaves ADMIN_PASSWORD unset when admin_password is an empty string', () => {
    // The exact configuration this branch changed: a fresh add-on install
    // with no admin_password set, where admin is reachable only via ingress.
    // Every assertion above this describe block is a regex; none of them
    // would fail if this case genuinely started exporting ADMIN_PASSWORD="".
    const { status, stdout } = runAddonScript({
      SUPERVISOR_TOKEN: 'test-supervisor-token',
      OPTIONS_PATH: writeOptions(''),
    })

    expect(status).toBe(0)
    expect(stdout).not.toMatch(/^ADMIN_PASSWORD=/m)
  })

  it('leaves ADMIN_PASSWORD unset when admin_password is JSON null', () => {
    const { status, stdout } = runAddonScript({
      SUPERVISOR_TOKEN: 'test-supervisor-token',
      OPTIONS_PATH: writeOptions(null),
    })

    expect(status).toBe(0)
    expect(stdout).not.toMatch(/^ADMIN_PASSWORD=/m)
  })

  it('fails fast with a clear message when options.json is missing', () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), 'run-sh-missing-')), 'options.json')

    const { status, stderr } = runAddonScript({
      SUPERVISOR_TOKEN: 'test-supervisor-token',
      OPTIONS_PATH: missingPath,
    })

    expect(status).toBe(1)
    expect(stderr).toMatch(/Error: SUPERVISOR_TOKEN is set but .*options\.json is missing/)
  })

  it('runs in plain Docker mode, untouched, when SUPERVISOR_TOKEN is unset', () => {
    const { status, stdout } = runAddonScript({ PORT: '9123' })

    expect(status).toBe(0)
    expect(stdout).not.toMatch(/^INGRESS_PORT=/m)
    expect(stdout).not.toMatch(/^HA_BASE_URL=/m)
  })
})
