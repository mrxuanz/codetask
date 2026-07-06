import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProviderAuth } from '../../src/server/sandbox/provider-auth/bridge'
import {
  materializeOpencodeAuth,
  opencodeRuntimeLayout
} from '../../src/server/sandbox/provider-auth/materialize'
import { resolveOpencodeExecutable } from '../../src/server/sandbox/provider-auth/paths'

const SERVER_TIMEOUT_MS = 30_000
const args = process.argv.slice(2)

function readArg(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const skipLive = args.includes('--skip-live')
const caseFilter = readArg('--case') ?? 'all'

function log(step: string, message: string, extra?: unknown): void {
  const prefix = `[opencode-light:${step}]`
  if (extra !== undefined) console.log(prefix, message, extra)
  else console.log(prefix, message)
}

function buildMergedEnv(envPatch: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, envPatch)
  env.CODETASK_OUTER_SANDBOX = '1'
  return env
}

function listRuntimeFiles(runtimeRoot: string): string[] {
  const found: string[] = []
  function walk(dir: string, depth: number): void {
    if (depth > 5 || found.length > 30) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (/\.(json|toml)$/i.test(entry.name)) found.push(full.slice(runtimeRoot.length + 1))
    }
  }
  walk(runtimeRoot, 0)
  return found
}

async function runStatic(runtimeRoot: string): Promise<{
  mode: string
  writeRoots: string[]
  layout: unknown
  materialized: {
    configCopied: boolean
    runtimeConfigDir: string
    runtimeDataDir: string
  }
  env: {
    HOME: string | undefined
    XDG_CONFIG_HOME: string | undefined
    XDG_DATA_HOME: string | undefined
    XDG_STATE_HOME: string | undefined
    CODETASK_OPENCODE_BIN: string | undefined
  }
  runtimeIsolated: boolean
}> {
  const layout = opencodeRuntimeLayout(runtimeRoot)
  const materialized = materializeOpencodeAuth(runtimeRoot)
  const prepared = prepareProviderAuth('opencode', runtimeRoot)
  const env = buildMergedEnv(prepared.envPatch)

  const report = {
    mode: prepared.diagnostics.mode,
    writeRoots: prepared.writeRoots ?? [],
    layout,
    materialized: {
      configCopied: materialized.configCopied,
      runtimeConfigDir: materialized.runtimeConfigDir,
      runtimeDataDir: materialized.runtimeDataDir
    },
    env: {
      HOME: env.HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: env.XDG_DATA_HOME,
      XDG_STATE_HOME: env.XDG_STATE_HOME,
      CODETASK_OPENCODE_BIN: env.CODETASK_OPENCODE_BIN
    },
    runtimeIsolated:
      prepared.diagnostics.mode === 'runtime-copy' &&
      env.HOME === runtimeRoot &&
      env.XDG_CONFIG_HOME === layout.configHome &&
      env.XDG_DATA_HOME === layout.dataHome &&
      env.XDG_STATE_HOME === layout.stateHome &&
      materialized.runtimeConfigDir === layout.configDir &&
      materialized.runtimeDataDir === layout.dataDir &&
      (prepared.writeRoots ?? []).length === 0
  }

  log('static', 'report', report)

  if (!report.runtimeIsolated) throw new Error('OpenCode runtime-copy isolation check failed')

  return report
}

async function runServerProbe(runtimeRoot: string): Promise<unknown> {
  const prepared = prepareProviderAuth('opencode', runtimeRoot)
  const env = buildMergedEnv(prepared.envPatch)
  const bin = env.CODETASK_OPENCODE_BIN?.trim() || resolveOpencodeExecutable()

  if (!existsSync(bin) && bin === 'opencode') {
    return { skipped: true, reason: 'opencode binary not found on PATH' }
  }

  const { createRequire } = await import('node:module')
  const nodeRequire = createRequire(import.meta.url)
  const crossSpawn = nodeRequire('cross-spawn') as typeof import('child_process').spawn
  const { createServer } = await import('node:net')

  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no port'))
      })
    })
  })

  const turnConfig = { permission: 'allow' as const }
  const proc = crossSpawn(bin, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(turnConfig)
    },
    windowsHide: true
  })

  const started = Date.now()
  let output = ''
  let url: string | null = null

  try {
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server start timeout')), SERVER_TIMEOUT_MS)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }

      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const match = output.match(/opencode server listening on (https?:\/\/[^\s]+)/i)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      proc.on('error', (error) => fail(error))
      proc.on('exit', (code) => fail(new Error(`opencode serve exited ${code}\n${output}`)))
    })

    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client')
    const client = createOpencodeClient({ baseUrl: url, directory: runtimeRoot })
    const health = await client.global.health()
    const elapsedMs = Date.now() - started

    return {
      url,
      health: health.error ? { error: String(health.error) } : health.data,
      elapsedMs,
      configDir: join(env.XDG_CONFIG_HOME ?? '', 'opencode'),
      authCopied: existsSync(join(env.XDG_CONFIG_HOME ?? '', 'opencode', 'auth.json'))
    }
  } finally {
    if (proc.pid && process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process')
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      proc.kill()
    }
  }
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'codetask-opencode-light-'))
  const runtimeRoot = join(base, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })

  const report: Record<string, unknown> = {
    caseFilter,
    skipLive,
    static: null,
    server: null,
    runtimeJson: null,
    failures: [] as string[]
  }

  const prepared = prepareProviderAuth('opencode', runtimeRoot)

  try {
    if (caseFilter === 'all' || caseFilter === 'static') {
      report.static = await runStatic(runtimeRoot)
    }

    if (!skipLive && (caseFilter === 'all' || caseFilter === 'server')) {
      try {
        const result = await runServerProbe(runtimeRoot)
        report.server = result
        log('server', 'done', result)
        if (
          result &&
          typeof result === 'object' &&
          'health' in result &&
          result.health &&
          typeof result.health === 'object' &&
          'error' in result.health &&
          result.health.error
        ) {
          ;(report.failures as string[]).push(`server: health check failed: ${result.health.error}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report.server = { failed: true, message }
        ;(report.failures as string[]).push(`server: ${message}`)
      }
    }

    report.runtimeJson = listRuntimeFiles(runtimeRoot)
    const reportPath = join(base, 'opencode-light-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

    console.log('\n========== OPENCODE LIGHT TEST ==========')
    if (report.static) console.log('static: OK')
    if (report.server) console.log('server:', report.server)
    if ((report.failures as string[]).length) {
      console.log('\nFailures:')
      for (const f of report.failures as string[]) console.log(`  - ${f}`)
    }
    console.log(`\nReport: ${reportPath}`)
    console.log(`Runtime files: ${(report.runtimeJson as string[]).join(', ') || '(none)'}`)

    prepared.cleanupPlan()

    const failures = report.failures as string[]
    const serverSkipped =
      report.server &&
      typeof report.server === 'object' &&
      'skipped' in report.server &&
      report.server.skipped
    if (failures.length > 0 && !serverSkipped) process.exit(1)
    if (failures.length > 0 && serverSkipped && failures.every((f) => f.startsWith('server:'))) {
      console.log('\n(server live skipped — static checks passed)')
    }
  } finally {
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      /* best-effort, ignore errors */
    }
  }
}

main().catch((error) => {
  console.error('[opencode-light] fatal:', error)
  process.exit(1)
})
