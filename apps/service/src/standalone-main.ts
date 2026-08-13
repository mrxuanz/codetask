import { gracefulShutdown, startAppServer, type ServerInfo } from './server'
import { parseServerCliArgs } from './cli'
import { createShutdownSignalHandler } from '@codetask/service-bootstrap'
import { createNodeServerPlatform } from './node-platform'
import { initializeProcessHostEnvironment } from '@codetask/agent-runtime/host-environment'

let shutdownPromise: Promise<void> | null = null

function shutdown(): Promise<void> {
  shutdownPromise ??= gracefulShutdown()
  return shutdownPromise
}

async function runSmokeTest(server: ServerInfo): Promise<void> {
  const response = await fetch(`${server.url}/api/health`, {
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`Smoke health check failed with HTTP ${response.status}`)

  const body = (await response.json()) as { success?: boolean; data?: { status?: string } }
  if (body.success !== true || body.data?.status !== 'ok') {
    throw new Error('Smoke health check returned an unexpected response')
  }

  console.log(`CODETASK_SMOKE_READY ${JSON.stringify({ url: server.url, health: 'ok' })}`)
}

async function main(): Promise<void> {
  await initializeProcessHostEnvironment()
  const cli = parseServerCliArgs()
  const platform = createNodeServerPlatform({ dataDir: cli.dataDir })
  if (!platform.isDev && !platform.staticDir) {
    throw new Error('Renderer assets not found. Run the standalone entry from a complete build.')
  }

  const server = await startAppServer(cli, platform)
  console.log(`[server] standalone Node service ready: ${server.url}`)
  // A supervised desktop smoke is orchestrated by the Electron parent and must
  // keep this sidecar alive for setup/login/conversation checks. The headless
  // standalone smoke remains a health-only process that exits by itself.
  if (cli.smokeTest && cli.mode === 'server') {
    await runSmokeTest(server)
    await shutdown()
  }
}

const handleShutdownSignal = createShutdownSignalHandler({
  shutdown,
  exit: (code) => process.exit(code),
  log: (message, error) => console.error(message, error ?? '')
})
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'))
process.on('SIGINT', () => handleShutdownSignal('SIGINT'))

void main().catch(async (error) => {
  console.error(
    `[server] standalone startup failed: ${error instanceof Error ? error.message : String(error)}`
  )
  await shutdown().catch(() => undefined)
  process.exitCode = 1
})
