import { join } from 'path'
import { serve, type ServerType } from '@hono/node-server'
import type { ExecutionContext, Hono } from 'hono'
import { app as electronApp } from 'electron'
import { is } from '@electron-toolkit/utils'
import { bootstrapRuntime, createApp, ensureRuntimeReady, shutdownRuntime } from '../server'
import { readSchemaGeneration } from '../server/application/cutover-state'
import { initConversationMcpBackend } from '../server/conversation/mcp/url'
import { mkdirSync } from 'fs'
import { resolveDataDirSelection } from './data-dir'
import { ensureResolvedDataRoot, type DataDirResolution } from './storage-locator'
import { createSetupShell } from './setup-shell'
import { resolveAvailablePort } from './port'
import type { CliOptions } from './cli'
import { generateSetupToken } from '../server/auth/setup-token'
import { loadMainProcessAuthSecret } from './app-secret'
import { clearPublishedRunningService, publishRunningService } from './service-discovery'

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
  http: { rendererDevUrl?: string; staticDir?: string }
): Promise<{ app: Hono; dataDir: string }> {
  const dataDir = ensureResolvedDataRoot(storage)
  process.env.CODETASK_DATA_DIR = dataDir

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

  await ensureRuntimeReady(ctx)

  if (usesLegacyComposition) {
    await import('../server/legacy-control-plane/job-queue').then((module) =>
      module.resumeJobQueuesAfterServerReady()
    )
  }

  if (cli.mode === 'server') {
    const { getBootstrap } = await import('../server/auth/service')
    const state = await getBootstrap()
    if (!state.initialized) {
      announceSetupToken(ctx.security.authSecret)
    }
  }

  const app = createApp(ctx, {
    isDev: is.dev,
    rendererDevUrl: http.rendererDevUrl,
    staticDir: http.staticDir
  })
  return { app, dataDir }
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
  const http = {
    rendererDevUrl,
    staticDir: is.dev ? undefined : staticDir
  }

  const storage = resolveDataDirSelection({ explicitDataDir: cli.dataDir, mode: cli.mode })
  let activeApp: Hono
  let boundPort = cli.port
  let bindChanged = false

  if (storage.phase !== 'ready') {
    // Ensure the default candidate exists so browse/select works out of the box.
    if (storage.phase === 'selection_required' && storage.dataDir) {
      try {
        mkdirSync(storage.dataDir, { recursive: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[storage] failed to create default candidate ${storage.dataDir}: ${message}`)
      }
    }

    const setupTokenRequired = cli.mode === 'server'
    if (setupTokenRequired) {
      const earlySecret = await loadMainProcessAuthSecret({
        mode: cli.mode,
        bootstrapSecretPath: storage.bootstrap.authSecretFile
      })
      announceSetupToken(earlySecret.value)
    }

    let promoteInflight: Promise<void> | null = null
    let publishedInfo: ServerInfo | null = null
    const setupApp = createSetupShell({
      storage,
      isDev: is.dev,
      rendererDevUrl,
      staticDir: http.staticDir,
      forbiddenRoots: [electronApp.getAppPath(), process.cwd()],
      setupTokenRequired,
      activateStorage: async () => {
        if (promoteInflight) {
          await promoteInflight
          return
        }
        promoteInflight = (async () => {
          const resolved = resolveDataDirSelection({ mode: cli.mode })
          if (resolved.phase !== 'ready') {
            throw new Error(resolved.issue ?? 'Storage locator is not ready after initialization')
          }
          const { app, dataDir } = await createReadyApp(cli, resolved, http)
          activeApp = app
          initConversationMcpBackend(boundPort)
          if (cli.mode === 'server' && publishedInfo) {
            publishRunningService(resolved.bootstrap, { ...publishedInfo, mode: 'server' }, dataDir)
          }
          console.log(
            `[server] ${cli.mode} mode ready after storage setup on ${formatUrl(cli.host, boundPort)}`
          )
          console.log(`[storage] data root: ${dataDir} (source=${resolved.source})`)
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
    if (cli.mode === 'server') {
      publishedInfo = info
      publishRunningService(storage.bootstrap, { ...info, mode: 'server' })
    }
    console.log(`[server] ${cli.mode} storage setup listening on ${info.url}`)
    console.log(`[storage] bootstrap root: ${storage.bootstrap.root}`)
    console.log(`[storage] default candidate: ${storage.dataDir}`)
    if (cli.mode === 'server') {
      console.log(`[server] open in browser to choose data directory: ${info.url}`)
    }
    return info
  }

  const { app, dataDir } = await createReadyApp(cli, storage, http)
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

  if (cli.mode === 'server') {
    publishRunningService(storage.bootstrap, { ...info, mode: 'server' }, dataDir)
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
  clearPublishedRunningService()

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
