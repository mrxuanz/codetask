import { serve, type ServerType } from '@hono/node-server'
import type { ExecutionContext, Hono } from 'hono'
import { bootstrapRuntime, createApp, ensureRuntimeReady, shutdownRuntime } from '../server'
import { readSchemaGeneration } from '../server/application/cutover-state'
import { initConversationMcpBackend } from '../server/conversation/mcp/url'
import type { DataDirResolution } from './storage-selection'
import { createSetupShell } from './setup-shell'
import { resolveAvailablePort } from './port'
import type { CliOptions } from './cli'
import {
  generateSetupToken,
  createProcessSetupGateSecret,
  installProcessSetupGate,
  clearProcessSetupGate
} from '../server/auth/setup-token'

export interface ServerInfo {
  host: string
  port: number
  url: string
  requestedPort: number
  portChanged: boolean
  mode: CliOptions['mode']
}

/**
 * Host-specific capabilities used by the shared HTTP/runtime composition.
 *
 * Electron and standalone Node entry points provide separate implementations so the business
 * runtime never needs to import Electron APIs directly.
 */
export interface AppServerPlatform {
  isDev: boolean
  rendererDevUrl?: string
  staticDir?: string
  appRoot: string
  shellChildEnvironment?: Record<string, string>
  resolveDataDirSelection(): DataDirResolution
  persistDataDirSelection(dataDir: string): void | Promise<void>
}

let activeServer: ServerType | null = null
let shutdownPromise: Promise<void> | null = null
let setupTokenAnnounced = false

function formatUrl(host: string, port: number): string {
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host
  return `http://${displayHost}:${port}`
}

/** Print setup token once for headless server first-run (desktop never needs it). */
function announceSetupToken(authSecret: string): void {
  if (setupTokenAnnounced) return
  setupTokenAnnounced = true
  const { token } = generateSetupToken(authSecret)
  console.log('')
  console.log('========================================')
  console.log('  Account not initialized.')
  console.log('  Setup token (valid 15 min):')
  console.log(`  ${token}`)
  console.log('========================================')
  console.log('')
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
  )
}

type NodeFetch = (
  request: Request,
  env?: unknown,
  executionCtx?: ExecutionContext
) => Response | Promise<Response>

function listen(fetch: NodeFetch, host: string, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({
      fetch: fetch as Parameters<typeof serve>[0]['fetch'],
      hostname: host,
      port
    })

    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

/** Hot-swap wrapper: keep serve() env bindings (incoming socket) while swapping activeApp. */
function activeFetch(getApp: () => Hono): NodeFetch {
  return (request, env, executionCtx) => getApp().fetch(request, env, executionCtx)
}

async function createReadyApp(
  cli: CliOptions,
  storage: DataDirResolution,
  platform: AppServerPlatform,
  http: { rendererDevUrl?: string; staticDir?: string }
): Promise<{ app: Hono; dataDir: string; usesLegacyComposition: boolean }> {
  const dataDir = storage.dataDir

  const ctx = bootstrapRuntime({
    dataDir,
    mode: cli.mode,
    shellChildEnvironment: platform.shellChildEnvironment,
    storage: {
      source: storage.source
    }
  })

  const schemaRead = readSchemaGeneration(ctx.db)
  const usesLegacyComposition = schemaRead !== 'v3_authoritative'

  await ensureRuntimeReady(ctx)

  if (cli.mode === 'server') {
    const state = await ctx.security.auth.bootstrap()
    if (!state.initialized) {
      announceSetupToken(ctx.security.authSecret)
    }
  }

  const app = createApp(ctx, {
    isDev: platform.isDev,
    rendererDevUrl: http.rendererDevUrl,
    staticDir: http.staticDir
  })
  return { app, dataDir, usesLegacyComposition }
}

function scheduleLegacyQueueResume(usesLegacyComposition: boolean): void {
  if (!usesLegacyComposition) return

  // Resume persisted work only after the HTTP listener is live. setImmediate also lets startup
  // finish reporting readiness before recovered jobs can consume executor capacity.
  setImmediate(() => {
    void import('../server/legacy-control-plane/job-queue')
      .then((module) => module.resumeJobQueuesAfterServerReady())
      .catch((error) => {
        console.error('[jobs] failed to resume queues after HTTP startup', error)
      })
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
  platform: AppServerPlatform
): Promise<ServerInfo> {
  const rendererDevUrl = platform.rendererDevUrl
  const http = {
    rendererDevUrl,
    staticDir: platform.isDev ? undefined : platform.staticDir
  }

  const storage = platform.resolveDataDirSelection()
  let activeApp: Hono
  let boundPort = cli.port
  let bindChanged = false

  if (storage.phase !== 'ready') {
    let promoteInflight: Promise<void> | null = null
    // Server mode: print the setup token immediately (process gate), before SQLite exists.
    // The same token remains valid after storage activation via validateSetupTokenWithGate.
    if (cli.mode === 'server') {
      const gate = createProcessSetupGateSecret()
      installProcessSetupGate(gate)
      announceSetupToken(gate)
    }
    const setupApp = createSetupShell({
      storage,
      isDev: platform.isDev,
      rendererDevUrl,
      staticDir: http.staticDir,
      forbiddenRoots: [platform.appRoot, process.cwd()],
      setupTokenRequired: cli.mode === 'server',
      persistDataDir: platform.persistDataDirSelection,
      activateStorage: async () => {
        if (promoteInflight) {
          await promoteInflight
          return
        }
        promoteInflight = (async () => {
          const resolved = platform.resolveDataDirSelection()
          if (resolved.phase !== 'ready') {
            throw new Error(resolved.issue ?? 'Storage is not ready after initialization')
          }
          const { app, dataDir, usesLegacyComposition } = await createReadyApp(
            cli,
            resolved,
            platform,
            http
          )
          activeApp = app
          initConversationMcpBackend(boundPort)
          console.log(
            `[server] ${cli.mode} mode ready after storage setup on ${formatUrl(cli.host, boundPort)}`
          )
          console.log(`[storage] data root: ${dataDir} (source=${resolved.source})`)
          scheduleLegacyQueueResume(usesLegacyComposition)
        })()
        try {
          await promoteInflight
        } catch (error) {
          promoteInflight = null
          throw error
        }
      }
    })
    activeApp = setupApp

    const { port: startPort, changed: preflightChanged } = await resolveAvailablePort(
      cli.host,
      cli.port
    )
    boundPort = startPort
    bindChanged = preflightChanged
    for (let offset = 0; offset < 100; offset++) {
      const port = startPort + offset
      try {
        activeServer = await listen(
          activeFetch(() => activeApp),
          cli.host,
          port
        )
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
    console.log(`[server] ${cli.mode} storage setup listening on ${info.url}`)
    console.log(`[storage] default candidate: ${storage.dataDir}`)
    if (cli.mode === 'server') {
      console.log(`[server] open in browser to choose data directory: ${info.url}`)
    }
    return info
  }

  const { app, dataDir, usesLegacyComposition } = await createReadyApp(cli, storage, platform, http)
  activeApp = app

  const { port: startPort, changed: preflightChanged } = await resolveAvailablePort(
    cli.host,
    cli.port
  )

  boundPort = startPort
  bindChanged = preflightChanged

  for (let offset = 0; offset < 100; offset++) {
    const port = startPort + offset
    try {
      activeServer = await listen(
        activeFetch(() => activeApp),
        cli.host,
        port
      )
      boundPort = port
      bindChanged = cli.port !== port
      initConversationMcpBackend(port)
      break
    } catch (error) {
      if (!isAddressInUse(error)) throw error
    }
  }

  if (!activeServer) {
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
  console.log(`[storage] data root: ${dataDir} (source=${storage.source})`)
  if (cli.mode === 'server' && cli.host === '0.0.0.0') {
    console.log(`[server] External access: http://<your-ip>:${boundPort}`)
  }

  scheduleLegacyQueueResume(usesLegacyComposition)

  return info
}

export async function stopAppServer(): Promise<void> {
  setupTokenAnnounced = false
  clearProcessSetupGate()
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

  await import('../server/sandbox/supervisor-manager').then((module) =>
    module.shutdownSandboxSupervisor()
  )

  try {
    const { closeDatabaseForTests } = await import('../server/db')
    closeDatabaseForTests()
  } catch (error) {
    console.warn('[server] failed to close database', error)
  }
}
