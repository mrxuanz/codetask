import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProviderAuthForTest } from '../helpers/provider-runtime'
import { resolveClaudeSettingSources } from '../../src/server/providers/claude/turn-options'
import { resolveClaudeHostConfigDir } from '../../src/server/sandbox/provider-auth/paths'
import { streamClaudeTurn } from '../../src/server/agent-runtime/providers/claude-sdk'

const TURN_TIMEOUT_MS = 3 * 60_000
const args = process.argv.slice(2)

function readArg(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const skipLive = args.includes('--skip-live')
const caseFilter = readArg('--case') ?? 'all'

function log(step: string, message: string, extra?: unknown): void {
  const prefix = `[claude-light:${step}]`
  if (extra !== undefined) console.log(prefix, message, extra)
  else console.log(prefix, message)
}

function buildMergedEnv(envPatch: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, envPatch)
  return env
}

function claudeAuthPresent(env: Record<string, string>): boolean {
  return Boolean(
    env.ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_AUTH_TOKEN?.trim() ||
    env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  )
}

function listRuntimeFiles(runtimeRoot: string): string[] {
  const found: string[] = []
  function walk(dir: string, depth: number): void {
    if (depth > 4 || found.length > 20) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (/\.json$/i.test(entry.name)) found.push(full.slice(runtimeRoot.length + 1))
    }
  }
  walk(runtimeRoot, 0)
  return found
}

async function runStatic(runtimeRoot: string): Promise<{
  mode: string
  authPresent: boolean
  claudeConfigDir: string
  home: string | undefined
  writeRoots: string[]
  settingSourcesOuterSandbox: unknown
  settingSourcesConversation: unknown
  hostClaudeInReadRoots: string[]
  injectedAuthKeys: string[]
  hostIdentityAligned: boolean
}> {
  const prepared = prepareProviderAuthForTest('claude-code', runtimeRoot)
  const env = buildMergedEnv(prepared.envPatch)
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? runtimeRoot, '.claude')
  const hostConfigDir = resolveClaudeHostConfigDir().toLowerCase()

  const hostReadRoots = (prepared.readRoots ?? []).filter((root) =>
    root.toLowerCase().startsWith(hostConfigDir)
  )

  const report = {
    mode: prepared.diagnostics.mode,
    authPresent: claudeAuthPresent(env) || prepared.diagnostics.authMaterialPresent,
    claudeConfigDir: claudeDir,
    home: env.HOME,
    writeRoots: prepared.writeRoots ?? [],
    settingSourcesOuterSandbox: resolveClaudeSettingSources(true),
    settingSourcesConversation: resolveClaudeSettingSources(false),
    hostClaudeInReadRoots: hostReadRoots,
    injectedAuthKeys: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN'
    ].filter((key) => Boolean(env[key])),
    hostIdentityAligned:
      prepared.diagnostics.mode === 'host-identity' &&
      env.CLAUDE_CONFIG_DIR === undefined &&
      env.HOME !== runtimeRoot &&
      hostReadRoots.length > 0
  }

  log('static', 'report', report)

  if (!report.hostIdentityAligned) throw new Error('Claude host-identity alignment check failed')
  if (report.injectedAuthKeys.length > 0) {
    throw new Error('Claude must not receive environment-token credentials')
  }
  if (report.settingSourcesOuterSandbox.length !== 0) {
    throw new Error('outer sandbox must use empty settingSources')
  }

  return report
}

async function runOuterSandboxOptions(runtimeRoot: string, workspace: string): Promise<unknown> {
  const started = Date.now()
  let reply = ''
  const stream = streamClaudeTurn(
    {
      provider: 'claude-code',
      role: 'work-verifier',
      cwd: workspace,
      runtimeRoot,
      prompt: 'Reply with exactly: pong',
      capabilityProfile: 'verifier-sandbox'
    },
    { outerSandbox: true }
  )

  const deadline = started + TURN_TIMEOUT_MS
  for await (const chunk of stream) {
    if (Date.now() > deadline) throw new Error(`turn timeout (${TURN_TIMEOUT_MS / 1000}s)`)
    if (chunk.type === 'error') throw new Error(chunk.message)
    if (chunk.type === 'completed') reply = chunk.reply
  }

  return { reply: reply.trim(), elapsedMs: Date.now() - started }
}

async function runHello(runtimeRoot: string, workspace: string): Promise<unknown> {
  const started = Date.now()
  let reply = ''
  let runtimeSessionId: string | null = null
  const stream = streamClaudeTurn(
    {
      provider: 'claude-code',
      role: 'conversation',
      cwd: workspace,
      runtimeRoot,
      prompt: 'Reply with exactly: pong',
      capabilityProfile: 'chat-read'
    },
    { outerSandbox: false }
  )

  const deadline = started + TURN_TIMEOUT_MS
  for await (const chunk of stream) {
    if (Date.now() > deadline) throw new Error(`turn timeout (${TURN_TIMEOUT_MS / 1000}s)`)
    if (chunk.type === 'error') throw new Error(chunk.message)
    if (chunk.type === 'completed') {
      reply = chunk.reply
      runtimeSessionId = chunk.runtimeSessionId
    }
  }

  return {
    reply: reply.trim(),
    elapsedMs: Date.now() - started,
    runtimeSessionId
  }
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'codetask-claude-light-'))
  const runtimeRoot = join(base, 'runtime')
  const workspace = join(base, 'workspace')
  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# claude light probe\n', 'utf8')

  const report: Record<string, unknown> = {
    caseFilter,
    skipLive,
    static: null,
    hello: null,
    outer: null,
    runtimeJson: null,
    failures: [] as string[]
  }

  const prepared = prepareProviderAuthForTest('claude-code', runtimeRoot)

  try {
    if (caseFilter === 'all' || caseFilter === 'static') {
      report.static = await runStatic(runtimeRoot)
    }

    if (!skipLive && (caseFilter === 'all' || caseFilter === 'hello')) {
      try {
        const result = await runHello(runtimeRoot, workspace)
        report.hello = result
        log('hello', 'done', result)
        if (
          result &&
          typeof result === 'object' &&
          'reply' in result &&
          typeof result.reply === 'string' &&
          !result.reply.toLowerCase().includes('pong')
        ) {
          ;(report.failures as string[]).push(
            `hello: expected pong, got ${result.reply || '(empty)'}`
          )
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report.hello = { failed: true, message }
        ;(report.failures as string[]).push(`hello: ${message}`)
      }
    }

    if (!skipLive && (caseFilter === 'all' || caseFilter === 'outer')) {
      try {
        const result = await runOuterSandboxOptions(runtimeRoot, workspace)
        report.outer = result
        log('outer', 'done', result)
        if (
          result &&
          typeof result === 'object' &&
          'reply' in result &&
          typeof result.reply === 'string' &&
          !result.reply.toLowerCase().includes('pong')
        ) {
          ;(report.failures as string[]).push(
            `outer: expected pong, got ${result.reply || '(empty)'}`
          )
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report.outer = { failed: true, message }
        ;(report.failures as string[]).push(`outer: ${message}`)
      }
    }

    report.runtimeJson = listRuntimeFiles(runtimeRoot)
    const reportPath = join(base, 'claude-light-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

    console.log('\n========== CLAUDE LIGHT TEST ==========')
    if (report.static) console.log('static: OK')
    if (report.hello) console.log('hello:', report.hello)
    if (report.outer) console.log('outer:', report.outer)
    if ((report.failures as string[]).length) {
      console.log('\nFailures:')
      for (const f of report.failures as string[]) console.log(`  - ${f}`)
    }
    console.log(`\nReport: ${reportPath}`)
    console.log(`Runtime files: ${(report.runtimeJson as string[]).join(', ') || '(none)'}`)

    prepared.cleanupPlan()

    if ((report.failures as string[]).length > 0) process.exit(1)
  } finally {
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      /* best-effort, ignore errors */
    }
  }
}

main().catch((error) => {
  console.error('[claude-light] fatal:', error)
  process.exit(1)
})
