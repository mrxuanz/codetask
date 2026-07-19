import { createServer } from 'node:net'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TIMEOUTS } from '../config/timeouts'
import { PublicApiClient } from '../api/client'
import type { ProcessRegistry } from './process-registry'

export type ServerHandle = {
  pid: number
  port: number
  baseUrl: string
  dataDir: string
  bootstrapDir: string
  startedAt: number
  setupToken: string | undefined
  stop: () => Promise<void>
}

function pickPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port)
        else reject(new Error('port_alloc_failed'))
      })
    })
  })
}

function extractSetupToken(output: string): string | undefined {
  const banner = output.match(/Setup token \(valid 15 min\):\s*\n\s*([A-Za-z0-9._~+/=-]+)/)
  if (banner?.[1]) return banner[1]
  const lines = output.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.includes('Setup token')) {
      const next = lines[i + 1]?.trim()
      if (next && /^[A-Za-z0-9._~+/=-]{16,}$/.test(next)) return next
    }
  }
  return undefined
}

export async function startDedicatedServer(options: {
  repoRoot: string
  runRoot: string
  registry: ProcessRegistry
  ledger?: import('../reports/ledger').OperationLedger
}): Promise<ServerHandle> {
  const entry = resolve(options.repoRoot, 'out/main/standalone.js')
  if (!existsSync(entry)) {
    throw new Error(`sut_entry_missing:${entry}`)
  }

  const dataDir = join(options.runRoot, 'data')
  const bootstrapDir = join(options.runRoot, 'bootstrap')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(bootstrapDir, { recursive: true })

  const port = await pickPort()
  const host = '127.0.0.1'
  const baseUrl = `http://${host}:${port}`

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODETASK_BOOTSTRAP_ROOT: bootstrapDir,
    CODETASK_STATIC_DIR: resolve(options.repoRoot, 'out/renderer'),
    CODETASK_APP_ROOT: options.repoRoot,
    CODETASK_SANDBOX_READY_MAX_ATTEMPTS: process.env.CODETASK_SANDBOX_READY_MAX_ATTEMPTS ?? '1'
  }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY

  const child = spawn(
    process.execPath,
    [entry, '--host', host, '--port', String(port), '--data-dir', dataDir],
    {
      cwd: options.repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    }
  ) as ChildProcessWithoutNullStreams

  if (!child.pid) throw new Error('server_spawn_failed')

  let output = ''
  let setupToken: string | undefined
  const append = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    output += text
    if (output.length > 200_000) output = output.slice(output.length - 200_000)
    if (!setupToken) {
      setupToken = extractSetupToken(output)
      if (setupToken) {
        // Keep raw token in memory only; do not log it.
      }
    }
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  const startedAt = Date.now()
  options.registry.track({
    label: 'codetask-standalone',
    pid: child.pid,
    startedAt
  })

  const client = new PublicApiClient(baseUrl, { ledger: options.ledger })
  const deadline = Date.now() + TIMEOUTS.serverStartupMs
  let ready = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `sut_crash:server_exited_${child.exitCode}:${output.slice(-2000).replace(/[A-Za-z0-9._~+/=-]{20,}/g, '[REDACTED]')}`
      )
    }
    try {
      if (await client.health()) {
        await client.bootstrap(false)
        ready = true
        break
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, TIMEOUTS.healthPollMs))
  }

  if (!ready) {
    await stopChild(child)
    options.registry.untrack(child.pid)
    throw new Error('timeout:server_startup')
  }

  // Allow a moment for setup token banner after health is ready.
  const tokenDeadline = Date.now() + 5_000
  while (!setupToken && Date.now() < tokenDeadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  return {
    pid: child.pid,
    port,
    baseUrl,
    dataDir,
    bootstrapDir,
    startedAt,
    setupToken,
    async stop() {
      await stopChild(child)
      if (child.pid) options.registry.untrack(child.pid)
    }
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process')
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + TIMEOUTS.gracefulShutdownMs
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}
