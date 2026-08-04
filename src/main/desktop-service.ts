import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { spawnSupervisedService, type SupervisedService } from '@codetask/service-bootstrap'
import { resolveDataDirSelection } from './data-dir'

export type DesktopServiceHandle = {
  url: string
  origin: string
  port: number
  instanceId: string
  pid: number
  stop: () => Promise<void>
}

function resolveRepoRootFromMain(): string {
  let dir = __dirname
  for (;;) {
    const packageJson = join(dir, 'package.json')
    if (existsSync(packageJson)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJson, 'utf8')) as {
          name?: string
          main?: string
        }
        if (pkg.main === './out/main/index.js' || pkg.name === 'task') return dir
      } catch {
        // continue walking
      }
    }
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return app.getAppPath()
}

function resolveServiceLaunch(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

  if (is.dev) {
    const root = resolveRepoRootFromMain()
    const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const tsconfigImport = join(root, 'tests', 'tsx-tsconfig.mjs')
    const entry = join(root, 'apps', 'service', 'src', 'main.ts')
    return {
      command: process.execPath,
      args: ['--import', tsconfigImport, '--import', tsxCli, entry],
      env
    }
  }

  const standalone = join(__dirname, 'standalone.js')
  if (!existsSync(standalone)) {
    throw new Error(
      `Service entry not found at ${standalone}. Build the desktop/standalone bundle first.`
    )
  }
  return {
    command: process.execPath,
    args: [standalone],
    env
  }
}

/**
 * Spawn the Hono Node Service as a supervised child and wait for ready handshake.
 * Desktop shell does not import server-core / database.
 */
export async function startDesktopService(): Promise<DesktopServiceHandle> {
  const storage = resolveDataDirSelection()
  const launch = resolveServiceLaunch()
  const args = [...launch.args, '--port', '0', '--host', '127.0.0.1', '--data-dir', storage.dataDir]
  if (is.dev) {
    args.push('--renderer-dev-url', 'http://127.0.0.1:5173')
  }

  const supervised: SupervisedService = await spawnSupervisedService({
    command: launch.command,
    args,
    env: launch.env,
    readyTimeoutMs: 90_000,
    killGraceMs: 10_000
  })

  const origin = supervised.ready.origin
  return {
    url: origin,
    origin,
    port: Number(new URL(origin).port || (origin.startsWith('https') ? 443 : 80)),
    instanceId: supervised.ready.instanceId,
    pid: supervised.ready.pid,
    stop: () => supervised.stop()
  }
}
