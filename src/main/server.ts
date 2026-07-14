import { join } from 'path'
import { serve, type ServerType } from '@hono/node-server'
import { is } from '@electron-toolkit/utils'
import { bootstrapRuntime, createApp, ensureRuntimeReady, shutdownRuntime } from '../server'
import { initConversationMcpBackend } from '../server/conversation/mcp/url'
import {
  getSandboxSupervisorManager,
  shutdownSandboxSupervisor
} from '../server/sandbox/supervisor-manager'
import { ensureWindowsSandboxReady } from '../server/sandbox/windows-bootstrap'
import { ensureDataDir } from './data-dir'
import { resolveAvailablePort } from './port'
import type { CliOptions } from './cli'
import { generateSetupToken } from '../server/auth/setup-token'

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

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
  )
}

function listen(
  app: ReturnType<typeof createApp>,
  host: string,
  port: number
): Promise<ServerType> {
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

export async function startAppServer(cli: CliOptions): Promise<ServerInfo> {
  const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
  const staticDir = join(__dirname, '../renderer')

  const dataDir = ensureDataDir()
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
  void supervisor.ensureReady().then(
    () => console.log('[sandbox] supervisor ready'),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[sandbox] supervisor lazy start deferred: ${message}`)
    }
  )

  const ctx = bootstrapRuntime({ dataDir, mode: cli.mode })
  // Scheduler, outbox, and reconciliation must finish before HTTP bind/listen.
  await ensureRuntimeReady(ctx)

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
      if (ctx.applicationRuntime?.kind !== 'v3') {
        void import('../server/legacy-control-plane/job-queue')
          .then((module) => module.resumeJobQueuesAfterServerReady(supervisor))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            console.warn(`[jobs] queue resume deferred: ${message}`)
          })
      }
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
  console.log(`[server] data dir: ${dataDir}`)
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
