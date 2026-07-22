import { gracefulShutdown, startAppServer, type ServerInfo } from '../main/server'
import { parseServerCliArgs } from '../main/cli'
import { createShutdownSignalHandler } from '../main/shutdown-signal'
import { createNodeServerPlatform } from './platform'

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
  const cli = parseServerCliArgs()
  const platform = createNodeServerPlatform()
  if (!platform.isDev && !platform.staticDir) {
    throw new Error(
      'Renderer assets not found. Set CODETASK_STATIC_DIR or run the standalone entry from a complete build.'
    )
  }

  const server = await startAppServer(cli, platform)
  console.log(`[server] standalone Node service ready: ${server.url}`)
  if (cli.smokeTest) {
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
