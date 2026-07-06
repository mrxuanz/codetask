import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProviderAuth } from '../../src/server/sandbox/provider-auth/bridge'
import { resolveClaudeSettingSources } from '../../src/server/agent-runtime/providers/claude-policy'
import { resolveClaudeHostConfigDir } from '../../src/server/sandbox/provider-auth/paths'

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
  env.CODETASK_OUTER_SANDBOX = '1'
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
  runtimeIsolated: boolean
}> {
  const prepared = prepareProviderAuth('claude-code', runtimeRoot)
  const env = buildMergedEnv(prepared.envPatch)
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(runtimeRoot, '.claude')
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
    runtimeIsolated:
      prepared.diagnostics.mode === 'runtime-copy' &&
      env.HOME === runtimeRoot &&
      claudeDir.startsWith(runtimeRoot) &&
      (prepared.writeRoots ?? []).length === 0 &&
      hostReadRoots.length === 0
  }

  log('static', 'report', report)

  if (!report.runtimeIsolated) throw new Error('Claude runtime-copy isolation check failed')
  if (report.settingSourcesOuterSandbox.length !== 0) {
    throw new Error('outer sandbox must use empty settingSources')
  }

  return report
}

async function runHello(runtimeRoot: string, workspace: string): Promise<unknown> {
  const prepared = prepareProviderAuth('claude-code', runtimeRoot)
  const env = buildMergedEnv(prepared.envPatch)
  if (!claudeAuthPresent(env)) {
    return { skipped: true, reason: 'no ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN' }
  }

  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const started = Date.now()
  let reply = ''

  const stream = query({
    prompt: 'Reply with exactly: pong',
    options: {
      cwd: workspace,
      settingSources: resolveClaudeSettingSources(true),
      permissionMode: 'bypassPermissions',
      sandbox: { enabled: false },
      tools: [],
      allowedTools: [],
      env,
      persistSession: false
    }
  })

  const deadline = started + TURN_TIMEOUT_MS
  for await (const message of stream) {
    if (Date.now() > deadline) throw new Error(`turn timeout (${TURN_TIMEOUT_MS / 1000}s)`)
    const typed = message as { type?: string; result?: string }
    if (typed.type === 'result' && typed.result) {
      reply = typed.result
      break
    }
  }

  return {
    reply: reply.trim(),
    elapsedMs: Date.now() - started,
    claudeHome: env.CLAUDE_CONFIG_DIR
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
    runtimeJson: null,
    failures: [] as string[]
  }

  const prepared = prepareProviderAuth('claude-code', runtimeRoot)

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

    report.runtimeJson = listRuntimeFiles(runtimeRoot)
    const reportPath = join(base, 'claude-light-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

    console.log('\n========== CLAUDE LIGHT TEST ==========')
    if (report.static) console.log('static: OK')
    if (report.hello) console.log('hello:', report.hello)
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
