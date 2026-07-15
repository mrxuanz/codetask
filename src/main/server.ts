import { join } from 'path'
import { serve, type ServerType } from '@hono/node-server'
import type { Hono } from 'hono'
import { app as electronApp } from 'electron'
import { is } from '@electron-toolkit/utils'
import { bootstrapRuntime, createApp, ensureRuntimeReady, shutdownRuntime } from '../server'
import { readSchemaGeneration } from '../server/application/cutover-state'
import { initConversationMcpBackend } from '../server/conversation/mcp/url'
import {
  getSandboxSupervisorManager,
  shutdownSandboxSupervisor
} from '../server/sandbox/supervisor-manager'
import { ensureWindowsSandboxReady } from '../server/sandbox/windows-bootstrap'
import { resolveDataDirSelection } from './data-dir'
import { ensureResolvedDataRoot } from './storage-locator'
import { createSetupShell } from './setup-shell'
import { resolveAvailablePort } from './port'
import type { CliOptions } from './cli'
import { generateSetupToken } from '../server/auth/setup-token'
import { loadMainProcessAuthSecret } from './app-secret'

export interface ServerInfo {
  host: string
  port: number
  url: string
  requestedPort: number
  portChanged: boolean
  mode: CliOptions['mode']
}

let activeServer: ServerType | null = null
let shutdownPromise: Promise<void> | null = null

function formatUrl(host: string, port: number): string {
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host
  return `http://${displayHost}:${port}`
}

/**
 * FIX-PLAN F3-C (§8.5): confirm the sandbox/provider is executable with bounded backoff retry.
 * Throws (fail closed) if it never becomes ready, so we never claim the runtime is ready.
 */
async function confirmSandboxReadyOrThrow(supervisor: {
  ensureReady(): Promise<void>
}): Promise<void> {
  const maxAttempts = Math.max(1, Number(process.env.CODETASK_SANDBOX_READY_MAX_ATTEMPTS ?? 5))
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await supervisor.ensureReady()
      console.log('[sandbox] supervisor ready')
      return
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const delayMs = 500 * attempt
      console.warn(
        `[sandbox] not ready (attempt ${attempt}/${maxAttempts}): ${message}; retrying in ${delayMs}ms`
      )
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Sandbox/provider unavailable after ${maxAttempts} attempts: ${message}`)
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
  )
}

function listen(app: Hono, host: string, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({
      fetch: app.fetch,
      hostname: host,
      port
    })

    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

export function getShutdownPromise(): Promise<void> | null {
  return shutdownPromise
}

export async function gracefulShutdown(): Promise<void> {
  shutdownPromise ??= stopAppServer()
  return shutdownPromise
}

export async function startAppServer(
  cli: CliOptions,
  options: { onStorageInitialized?: (dataDir: string) => void | Promise<void> } = {}
): Promise<ServerInfo> {
  const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
  const staticDir = join(__dirname, '../renderer')

  const storage = resolveDataDirSelection({ explicitDataDir: cli.dataDir, mode: cli.mode })
  if (storage.phase !== 'ready') {
    if (cli.mode === 'server') {
      throw new Error(
        `Headless server storage is not configured (${storage.issue ?? storage.phase}); use --data-dir or CODETASK_DATA_DIR`
      )
    }

    const { port: startPort, changed: preflightChanged } = await resolveAvailablePort(
      cli.host,
      cli.port
    )
    let boundPort = startPort
    let bindChanged = preflightChanged
    for (let offset = 0; offset < 100; offset++) {
      const port = startPort + offset
      const setupApp = createSetupShell({
        storage,
        isDev: is.dev,
        rendererDevUrl,
        staticDir: is.dev ? undefined : staticDir,
        forbiddenRoots: [electronApp.getAppPath(), process.cwd()],
        onInitialized: options.onStorageInitialized
      })
      try {
        activeServer = await listen(setupApp, cli.host, port)
        boundPort = port
        bindChanged = cli.port !== port
        break
      } catch (error) {
        if (!isAddressInUse(error)) throw error
      }
    }
    if (!activeServer) {
      throw new Error(`No available port found starting from ${cli.port} on ${cli.host}`)
    }
    const info: ServerInfo = {
      host: cli.host,
      port: boundPort,
      url: formatUrl(cli.host, boundPort),
      requestedPort: cli.port,
      portChanged: bindChanged,
      mode: cli.mode
    }
    console.log(`[server] desktop storage setup listening on ${info.url}`)
    console.log(`[storage] bootstrap root: ${storage.bootstrap.root}`)
    console.log(`[storage] default candidate: ${storage.dataDir}`)
    return info
  }

  const dataDir = ensureResolvedDataRoot(storage)
  process.env.CODETASK_DATA_DIR = dataDir

  if (process.platform === 'win32') {
    void ensureWindowsSandboxReady(dataDir).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[sandbox] Windows bootstrap deferred: ${message}`)
    })
  }

  const supervisor = getSandboxSupervisorManager()
  supervisor.on('restart_failed', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[sandbox] supervisor restart failed permanently: ${message}`)
  })

  const authSecret = await loadMainProcessAuthSecret({
    mode: cli.mode,
    bootstrapSecretPath: storage.bootstrap.authSecretFile
  })
  console.log(`[security] auth secret provider: ${authSecret.provider.describeStorage().kind}`)

  const ctx = bootstrapRuntime({
    dataDir,
    mode: cli.mode,
    authSecret: authSecret.value,
    mcpSecretPath: storage.bootstrap.mcpSecretFile,
    storage: {
      bootstrapRoot: storage.bootstrap.root,
      source: storage.source,
      managed: storage.managed
    }
  })
  process.env.CODETASK_MODE = cli.mode

  const schemaRead = readSchemaGeneration(ctx.db)
  const usesLegacyComposition = schemaRead !== 'v3_authoritative'

  // FIX-PLAN F3-C / R6: full recovery must complete BEFORE HTTP bind/listen:
  //   open DB/migrate → select Legacy root → init sandbox/provider (confirm executable) →
  //   reclaim stale run/slot/lease → running attempt → interrupted → resume last running Job →
  //   advance pending FIFO → start reconciler → (only then) listen.
  if (usesLegacyComposition) {
    await confirmSandboxReadyOrThrow(supervisor)
  }

  await ensureRuntimeReady(ctx)

  if (usesLegacyComposition) {
    await import('../server/legacy-control-plane/job-queue').then((module) =>
      module.resumeJobQueuesAfterServerReady(supervisor)
    )
  }

  if (cli.mode === 'server') {
    const { getBootstrap } = await import('../server/auth/service')
    const state = await getBootstrap()
    if (!state.initialized) {
      const { token } = generateSetupToken(ctx.security.authSecret)
      ctx.security.setupToken = token
      console.log('')
      console.log('========================================')
      console.log('  Account not initialized.')
      console.log('  Setup token (valid 15 min):')
      console.log(`  ${token}`)
      console.log('========================================')
      console.log('')
    }
  }

  const { port: startPort, changed: preflightChanged } = await resolveAvailablePort(
    cli.host,
    cli.port
  )

  let boundPort = startPort
  let bindChanged = preflightChanged
  let app: ReturnType<typeof createApp> | null = null

  for (let offset = 0; offset < 100; offset++) {
    const port = startPort + offset
    app = createApp(ctx, {
      isDev: is.dev,
      rendererDevUrl,
      staticDir: is.dev ? undefined : staticDir
    })
    try {
      activeServer = await listen(app, cli.host, port)
      boundPort = port
      bindChanged = cli.port !== port
      initConversationMcpBackend(port)
      break
    } catch (error) {
      if (!isAddressInUse(error)) throw error
    }
  }

  if (!activeServer || !app) {
    throw new Error(`No available port found starting from ${cli.port} on ${cli.host}`)
  }

  if (bindChanged) {
    console.log(`[server] Port ${cli.port} is in use, using ${boundPort} instead`)
  }

  const info: ServerInfo = {
    host: cli.host,
    port: boundPort,
    url: formatUrl(cli.host, boundPort),
    requestedPort: cli.port,
    portChanged: bindChanged,
    mode: cli.mode
  }

  console.log(`[server] ${cli.mode} mode listening on ${info.url}`)
  console.log(`[storage] bootstrap root: ${storage.bootstrap.root}`)
  console.log(`[storage] data root: ${dataDir} (source=${storage.source})`)
  if (cli.mode === 'server' && cli.host === '0.0.0.0') {
    console.log(`[server] External access: http://<your-ip>:${boundPort}`)
  }

  return info
}

export async function stopAppServer(): Promise<void> {
  if (activeServer) {
    activeServer.close()
    activeServer = null
  }

  try {
    const { stopRetentionJanitor } = await import('../server/retention/lifecycle')
    stopRetentionJanitor()
    const { stopArtifactExpiryScheduler } = await import('../server/retention/expiry-scheduler')
    stopArtifactExpiryScheduler()
  } catch (error) {
    console.warn('[server] failed to stop retention janitor', error)
  }

  try {
    const { stopAuthJanitor } = await import('../server/auth/janitor')
    stopAuthJanitor()
  } catch (error) {
    console.warn('[server] failed to stop auth janitor', error)
  }

  try {
    await shutdownRuntime('app_shutdown')
  } catch (error) {
    console.warn('[server] failed to shutdown application runtime', error)
  }

  await shutdownSandboxSupervisor()

  try {
    const { closeDatabaseForTests } = await import('../server/db')
    closeDatabaseForTests()
  } catch (error) {
    console.warn('[server] failed to close database', error)
  }
}
