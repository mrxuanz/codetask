import { gracefulShutdown, startAppServer, type ServerInfo } from '../../../src/main/server.ts'
import { parseServerCliArgs } from '../../../src/main/cli.ts'
import { createShutdownSignalHandler } from '../../../src/main/shutdown-signal.ts'
import { createNodeServerPlatform } from '../../../src/standalone/platform.ts'
import { initializeProcessHostEnvironment } from '../../../src/server/host-environment.ts'

let shutdownPromise: Promise<void> | null = null

function shutdown(): Promise<void> {
  shutdownPromise ??= gracefulShutdown()
  return shutdownPromise
}

async function main(): Promise<void> {
  await initializeProcessHostEnvironment()
  // Product config comes from CLI (Batch C); no CODETASK_* reads in this entry.
  const cli = parseServerCliArgs(process.argv)
  const platform = createNodeServerPlatform(cli.dataDir ? { dataDir: cli.dataDir } : undefined)
  if (!platform.isDev && !platform.staticDir) {
    throw new Error('Renderer assets not found. Run the standalone entry from a complete build.')
  }

  const servicePlatform = {
    ...platform,
    isDev: true,
    rendererDevUrl: cli.rendererDevUrl ?? 'http://127.0.0.1:5173'
  }

  const server = await startAppServer(cli, servicePlatform)
  console.log(`[dev:service] Hono Server Core ready: ${server.url}`)
  console.log(`[dev:service] instanceId=${server.instanceId}`)
  console.log(`[dev:service] Web (Vite): ${servicePlatform.rendererDevUrl}`)
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
    `[dev:service] startup failed: ${error instanceof Error ? error.message : String(error)}`
  )
  await shutdown().catch(() => undefined)
  process.exitCode = 1
})

export type { ServerInfo }
