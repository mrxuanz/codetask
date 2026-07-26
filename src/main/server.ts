import { serve, type ServerType } from '@hono/node-server'
import type { ExecutionContext, Hono } from 'hono'
import { createApp, createRuntime, type ApplicationRuntime } from '../server'
import { mkdirSync } from 'fs'
import { ensureResolvedDataRoot, type DataDirResolution } from './storage-locator'
import { createSetupShell } from './setup-shell'
import { resolveAvailablePort } from './port'
import type { CliOptions } from './cli'
import { createSetupGrantService } from '../server/composition/auth'
import { clearPublishedRunningService, publishRunningService } from './service-discovery'
import type { AppSecretProvider } from '../server/auth/secret'

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
  resolveDataDirSelection(input: {
    explicitDataDir?: string
    mode: CliOptions['mode']
  }): DataDirResolution
  loadAuthSecret(input: {
    mode: CliOptions['mode']
    bootstrapSecretPath: string
  }): Promise<{ value: string; provider: AppSecretProvider }>
}

let activeServer: ServerType | null = null
let activeRuntime: ApplicationRuntime | null = null
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
  const { grant } = createSetupGrantService(authSecret).issue(Date.now())
  console.log('')
  console.log('========================================')
  console.log('  Account not initialized.')
  console.log('  Setup token (valid 15 min):')
  console.log(`  ${grant}`)
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
): Promise<{ app: Hono; dataDir: string; runtime: ApplicationRuntime }> {
  const dataDir = ensureResolvedDataRoot(storage)

  const authSecret = await platform.loadAuthSecret({
    mode: cli.mode,
    bootstrapSecretPath: storage.bootstrap.authSecretFile
  })
  console.log(`[security] auth secret provider: ${authSecret.provider.describeStorage().kind}`)

  const runtime = createRuntime({
    dataDir,
    mode: cli.mode,
    authSecret: authSecret.value,
    storage: {
      bootstrapRoot: storage.bootstrap.root,
      source: storage.source,
      managed: storage.managed
    }
  })

  try {
    await runtime.ensureReady()
    const ctx = runtime.context

    if (cli.mode === 'server') {
      const state = ctx.security.auth.service.bootstrap()
      if (!state.initialized) {
        announceSetupToken(ctx.security.authSecret)
      }
    }

    const app = createApp(ctx, {
      isDev: platform.isDev,
      rendererDevUrl: http.rendererDevUrl,
      staticDir: http.staticDir
    })
    return { app, dataDir, runtime }
  } catch (error) {
    await runtime.shutdown()
    throw error
  }
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

  const storage = platform.resolveDataDirSelection({
    explicitDataDir: cli.dataDir,
    mode: cli.mode
  })
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
    let verifySetupToken: ((token: string) => boolean) | undefined
    if (setupTokenRequired) {
      const earlySecret = await platform.loadAuthSecret({
        mode: cli.mode,
        bootstrapSecretPath: storage.bootstrap.authSecretFile
      })
      const grants = createSetupGrantService(earlySecret.value)
      verifySetupToken = (token) => grants.verify(token, Date.now())
      announceSetupToken(earlySecret.value)
    }

    let promoteInflight: Promise<void> | null = null
    let publishedInfo: ServerInfo | null = null
    const setupApp = createSetupShell({
      storage,
      isDev: platform.isDev,
      rendererDevUrl,
      staticDir: http.staticDir,
      forbiddenRoots: [platform.appRoot, process.cwd()],
      setupTokenRequired,
      verifySetupToken,
      activateStorage: async () => {
        if (promoteInflight) {
          await promoteInflight
          return
        }
        promoteInflight = (async () => {
          const resolved = platform.resolveDataDirSelection({ mode: cli.mode })
          if (resolved.phase !== 'ready') {
            throw new Error(resolved.issue ?? 'Storage locator is not ready after initialization')
          }
          const { app, dataDir, runtime } = await createReadyApp(cli, resolved, platform, http)
          activeApp = app
          activeRuntime = runtime
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

  const { app, dataDir, runtime } = await createReadyApp(cli, storage, platform, http)
  activeApp = app
  activeRuntime = runtime

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
      if (!isAddressInUse(error)) {
        activeRuntime = null
        await runtime.shutdown()
        throw error
      }
    }
  }

  if (!activeServer) {
    activeRuntime = null
    await runtime.shutdown()
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
    const runtime = activeRuntime
    activeRuntime = null
    await runtime?.shutdown()
  } catch (error) {
    console.warn('[server] failed to shutdown application runtime', error)
  }

  await import('../server/sandbox/supervisor-manager').then((module) =>
    module.shutdownSandboxSupervisor()
  )
}
