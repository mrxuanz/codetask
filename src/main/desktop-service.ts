import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { spawnSupervisedService, type SupervisedService } from '@codetask/service-bootstrap'
import { resolveDataDirSelection } from './data-dir'
import { resolvePackagedServiceEntry } from './service-entry'

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
        if (pkg.main === './out/main/index.js' || pkg.name === 'codetask' || pkg.name === 'task') {
          return dir
        }
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

function looksLikeElectronBinary(path: string): boolean {
  return /Electron\.app|[\\/]electron([\\/]|$)/i.test(path)
}

/** Resolve system Node for the Hono Service child (dev). Packaged builds use Electron-as-Node. */
function resolveHostNodeBinary(): string {
  const override = process.env.CODETASK_HOST_NODE?.trim()
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CODETASK_HOST_NODE does not exist: ${override}`)
    }
    if (looksLikeElectronBinary(override)) {
      throw new Error(
        `CODETASK_HOST_NODE points at Electron (${override}); set it to a system Node 24 binary.`
      )
    }
    return override
  }

  const candidates: string[] = []
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', ['node'], { encoding: 'utf8' })
      candidates.push(
        ...out
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      )
    } else {
      const out = execFileSync('which', ['-a', 'node'], { encoding: 'utf8' })
      candidates.push(
        ...out
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      )
    }
  } catch {
    // fall through to error below
  }

  for (const candidate of candidates) {
    if (!candidate || looksLikeElectronBinary(candidate)) continue
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    'Host Node.js not found for the desktop Service child. Set CODETASK_HOST_NODE to your Node 24 binary, or use `npm run dev:service`.'
  )
}

function resolveServiceLaunch(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (is.dev) {
    const root = resolveRepoRootFromMain()
    const tsconfigImport = join(root, 'scripts', 'tooling', 'tsx-tsconfig.mjs')
    const entry = join(root, 'apps', 'service', 'src', 'main.ts')
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    // Same process as the spawn'd Node so stdio[3] ready-fd stays open.
    // `tsx/cli` re-enters and loses fd 3 (ENXIO on announceServiceReady).
    return {
      command: resolveHostNodeBinary(),
      args: ['--import', tsconfigImport, '--import', 'tsx', entry],
      env
    }
  }

  const standalone = resolvePackagedServiceEntry(__dirname)
  // Packaged desktop: no host Node required; run the bundled service as Electron-as-Node.
  return {
    command: process.execPath,
    args: [standalone],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
}

/**
 * Spawn the Hono Node Service as a supervised child and wait for ready handshake.
 * Desktop shell does not import server-core / database.
 */
export async function startDesktopService(
  options: { smokeTest?: boolean } = {}
): Promise<DesktopServiceHandle> {
  const storage = options.smokeTest
    ? resolveDataDirSelection({
        // Package smoke must be repeatable and must never write test accounts or
        // databases into the application bundle beside the executable.
        defaultDataDir: join(app.getPath('userData'), 'package-smoke-data')
      })
    : resolveDataDirSelection()
  const launch = resolveServiceLaunch()
  const args = [
    ...launch.args,
    '--desktop',
    '--port',
    '0',
    '--host',
    '127.0.0.1',
    '--data-dir',
    storage.dataDir
  ]
  if (is.dev) {
    args.push('--renderer-dev-url', 'http://127.0.0.1:5173')
  }
  if (options.smokeTest) args.push('--smoke-test')

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
