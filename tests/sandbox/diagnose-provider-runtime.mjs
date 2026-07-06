import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadNative,
  policyForRoleV2,
  sandboxTestsEnabled,
  wirePolicy
} from './sandbox-test-utils.mjs'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)

const PROVIDERS = ['codex', 'cursorcli', 'claude-code', 'opencode']
const PROVIDER_ALIASES = {
  codex: 'codex',
  cursor: 'cursorcli',
  cursorcli: 'cursorcli',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  opencode: 'opencode',
  all: 'all'
}

function readArg(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const skipLive = args.includes('--skip-live')
const caseFilter = readArg('--case') ?? 'all'
const workspaceArg = readArg('--workspace')
const providerArg = readArg('--provider') ?? 'all'

function resolveProviders() {
  const key = PROVIDER_ALIASES[providerArg] ?? providerArg
  if (key === 'all') return PROVIDERS
  if (!PROVIDERS.includes(key)) {
    throw new Error(`Unknown provider: ${providerArg} (use codex|cursor|claude|opencode|all)`)
  }
  return [key]
}

function log(section, message, extra) {
  const prefix = `[diagnose-provider:${section}]`
  if (extra !== undefined) console.log(prefix, message, extra)
  else console.log(prefix, message)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function resolveRoleWorkerPath(_role = 'codex') {
  const candidates = [
    join(process.cwd(), 'out', 'main', 'sandbox', 'role-worker.js'),
    join(process.cwd(), 'out', 'main', 'sandbox', 'role-worker.cjs')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function loadProductionSandboxModule() {
  const chunksDir = join(process.cwd(), 'out', 'main', 'chunks')
  if (!existsSync(chunksDir)) return null
  for (const file of readdirSync(chunksDir)) {
    if (!file.endsWith('.js')) continue
    try {
      const mod = require(join(chunksDir, file))
      if (
        typeof mod.prepareProviderAuth === 'function' &&
        typeof mod.buildSandboxEnv === 'function'
      ) {
        return mod
      }
    } catch {
      /* best-effort, ignore errors */
    }
  }
  return null
}

function loadProviderPolicyModule() {
  const candidates = [
    join(process.cwd(), 'out', 'main', 'chunks'),
    join(process.cwd(), 'out', 'main')
  ]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.js')) continue
      try {
        const mod = require(join(dir, file))
        if (typeof mod.buildCursorAcpCliArgs === 'function') return mod
      } catch {
        /* best-effort, ignore errors */
      }
    }
  }
  return null
}

function hostHome() {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir()
}

function authStatus(provider) {
  switch (provider) {
    case 'codex': {
      const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
      const hasFile = existsSync(join(codexHome, 'auth.json'))
      const hasEnv = Boolean(
        process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim()
      )
      return { present: hasFile || hasEnv, detail: hasFile ? codexHome : 'env-key-only' }
    }
    case 'cursorcli': {
      const candidates = [
        join(hostHome(), 'AppData', 'Roaming', 'Cursor', 'auth.json'),
        join(hostHome(), '.config', 'cursor', 'auth.json')
      ]
      const hasFile = candidates.some((p) => existsSync(p))
      const hasEnv = Boolean(process.env.CURSOR_API_KEY?.trim())
      return {
        present: hasFile || hasEnv,
        detail: hasFile ? 'auth.json' : hasEnv ? 'env-key' : 'missing'
      }
    }
    case 'claude-code': {
      const hasEnv = Boolean(
        process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
      )
      const settings = join(hostHome(), '.claude', 'settings.json')
      return {
        present: hasEnv || existsSync(settings),
        detail: existsSync(settings) ? settings : 'env'
      }
    }
    case 'opencode': {
      const configDir = join(hostHome(), '.config', 'opencode')
      const hasConfig = ['opencode.json', 'auth.json'].some((n) => existsSync(join(configDir, n)))
      const hasEnv = Boolean(
        process.env.OPENCODE_API_KEY?.trim() ||
        process.env.ANTHROPIC_API_KEY?.trim() ||
        process.env.OPENAI_API_KEY?.trim()
      )
      return { present: hasConfig || hasEnv, detail: hasConfig ? configDir : 'env' }
    }
    default:
      return { present: false, detail: 'unknown' }
  }
}

function analyzeStaticProvider(prod, provider, runtimeRoot, workspaceRoot) {
  const prepared = prod.prepareProviderAuth(provider, runtimeRoot, { workspaceRoot })
  const host = hostHome()
  const hostWrites = (prepared.writeRoots ?? []).filter((root) =>
    root.toLowerCase().startsWith(host.toLowerCase())
  )

  const policy = prod.policyForRoleV2
    ? prod.policyForRoleV2({
        role: 'task-worker',
        workspaceRoot,
        runtimeRoot,
        providerReadRoots: prepared.readRoots,
        providerWriteRoots: prepared.writeRoots,
        attachmentReadRoots: []
      })
    : policyForRoleV2('task-worker', workspaceRoot, runtimeRoot)

  const writeRoots =
    policy.filesystem?.allowedWriteRoots ?? policy.filesystem?.allowed_write_roots ?? []

  return {
    provider,
    mode: prepared.diagnostics.mode,
    authPresent: prepared.diagnostics.authMaterialPresent,
    warnings: prepared.diagnostics.warnings,
    env: {
      HOME: prepared.envPatch.HOME,
      CODEX_HOME: prepared.envPatch.CODEX_HOME ?? null,
      CURSOR_CONFIG_DIR: prepared.envPatch.CURSOR_CONFIG_DIR ?? null,
      CLAUDE_CONFIG_DIR: prepared.envPatch.CLAUDE_CONFIG_DIR ?? null,
      XDG_CONFIG_HOME: prepared.envPatch.XDG_CONFIG_HOME ?? null
    },
    hostWriteRoots: hostWrites,
    policyWriteTouchesHost: writeRoots.some((root) =>
      root.toLowerCase().startsWith(host.toLowerCase())
    ),
    runtimeIsolated:
      prepared.envPatch.HOME === runtimeRoot &&
      prepared.diagnostics.mode === 'runtime-copy' &&
      hostWrites.length === 0
  }
}

function buildProductionSandboxEnv(prod, runtimeRoot, workspaceRoot, provider) {
  const authPrepared = prod.prepareProviderAuth(provider, runtimeRoot, { workspaceRoot })
  if (typeof prod.runProviderAuthPreflight === 'function') {
    prod.runProviderAuthPreflight(provider, authPrepared)
  }
  const dataDir =
    typeof prod.resolveSandboxDataDir === 'function'
      ? prod.resolveSandboxDataDir()
      : join(process.cwd(), 'data')
  const envRecord = prod.buildSandboxEnv({
    runtimeRoot,
    dataDir,
    providerEnv: authPrepared.envPatch
  })
  return { envRecord, authPrepared, dataDir }
}

function buildProductionPolicy(prod, runtimeRoot, workspaceRoot, provider) {
  const authPrepared = prod.prepareProviderAuth(provider, runtimeRoot, { workspaceRoot })
  if (prod.policyForRoleV2) {
    return prod.policyForRoleV2({
      role: 'task-worker',
      workspaceRoot,
      runtimeRoot,
      providerReadRoots: authPrepared.readRoots,
      providerWriteRoots: authPrepared.writeRoots,
      attachmentReadRoots: []
    })
  }
  return policyForRoleV2('task-worker', workspaceRoot, runtimeRoot)
}

function ensureWindowsSetup(native) {
  if (process.platform !== 'win32') return
  const home =
    process.env.CODETASK_SANDBOX_HOME?.trim() ||
    join(process.env.LOCALAPPDATA ?? tmpdir(), 'codetask', 'sandbox-home')
  mkdirSync(join(home, 'sandbox'), { recursive: true })
  if (native.windowsSetupStatus(home)) return
  log('setup', 'Running windowsSetup (UAC may prompt once)...')
  native.windowsSetup(
    process.execPath,
    join(process.cwd(), 'native/codeteam-sandbox/setup-entry.js'),
    join(process.cwd(), 'native/codeteam-sandbox/runner-entry.js'),
    home,
    process.cwd()
  )
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runSandboxRoleWorker(native, options) {
  const { name, policy, workerInput, envRecord, timeoutMs = 600_000 } = options
  const workerPath = resolveRoleWorkerPath(workerInput.provider)
  if (!workerPath) throw new Error('role-worker.js missing; run npm run build')

  const env = Object.entries(envRecord).map(([key, value]) => ({ key, value }))
  log(name, 'launching role-worker', { provider: workerInput.provider, cwd: policy.cwd })

  const startedAt = Date.now()
  let firstLineAt = null
  const chunks = []
  let stderr = ''

  const handle = native.launchSandboxedWorker({
    policyJson: wirePolicy(policy),
    command: process.execPath,
    args: [workerPath],
    cwd: policy.cwd,
    env
  })

  handle.writeStdin(Buffer.from(JSON.stringify(workerInput), 'utf8'))
  handle.endStdin()

  if (!handle.waitForAttestation(30_000)) {
    handle.kill()
    handle.close()
    throw new Error(`${name}: sandbox attestation timeout`)
  }

  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const piece = handle.readStdoutChunk(64 * 1024)
    if (piece?.length) {
      buffer += piece.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (firstLineAt === null) firstLineAt = Date.now() - startedAt
        try {
          chunks.push(JSON.parse(trimmed))
        } catch {
          chunks.push({ type: 'parse_error', raw: trimmed.slice(0, 200) })
        }
      }
    }

    const errPiece = handle.readStderrChunk(64 * 1024)
    if (errPiece?.length) stderr += errPiece.toString('utf8')

    const exitCode = handle.pollExit()
    if (exitCode !== null && exitCode !== undefined) {
      if (buffer.trim()) {
        try {
          chunks.push(JSON.parse(buffer.trim()))
        } catch {
          chunks.push({ type: 'parse_error', raw: buffer.trim().slice(0, 200) })
        }
      }
      handle.close()
      return {
        name,
        exitCode,
        elapsedMs: Date.now() - startedAt,
        firstLineMs: firstLineAt === null ? null : firstLineAt - startedAt,
        chunks,
        stderr: stderr.trim()
      }
    }
    await sleep(25)
  }

  handle.kill()
  handle.close()
  throw new Error(`${name}: timed out after ${timeoutMs}ms`)
}

function summarizeChunks(result) {
  const deltas = result.chunks.filter((c) => c.type === 'delta')
  const completed = result.chunks.find((c) => c.type === 'completed')
  const errors = result.chunks.filter((c) => c.type === 'error')
  return {
    deltaCount: deltas.length,
    lastDeltaPreview: deltas.at(-1)?.content?.slice(0, 160) ?? null,
    completedPreview: completed?.reply?.slice(0, 160) ?? null,
    runtimeSessionId: completed?.runtimeSessionId ?? null,
    errors: errors.map((e) => e.message)
  }
}

function startProbeMcpServer(toolName = 'report_task_result') {
  const calls = []
  const server = createServer(async (req, res) => {
    const body = await new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })

    let parsed = {}
    try {
      parsed = body ? JSON.parse(body) : {}
    } catch {
      parsed = {}
    }

    calls.push({
      method: req.method,
      path: req.url,
      rpcMethod: parsed.method,
      tool: parsed.params?.name
    })

    if (parsed.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'probe-provider-mcp', version: '1.0.0' }
          }
        })
      )
      return
    }

    if (parsed.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          result: {
            tools: [
              {
                name: toolName,
                description: 'probe',
                inputSchema: {
                  type: 'object',
                  properties: { status: { type: 'string' } },
                  required: ['status']
                }
              }
            ]
          }
        })
      )
      return
    }

    if (parsed.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          result: {
            content: [{ type: 'text', text: `accepted:${parsed.params?.name}` }],
            structuredContent: { ok: true }
          }
        })
      )
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

async function runProviderLiveCase(native, prod, provider, workspace, runtimeRoot) {
  const policy = buildProductionPolicy(prod, runtimeRoot, workspace, provider)
  const envBundle = buildProductionSandboxEnv(prod, runtimeRoot, workspace, provider)

  const workerInput = {
    provider,
    role: 'task-worker',
    cwd: workspace,
    runtimeRoot,
    prompt: 'Reply with exactly: pong',
    systemPrompt: 'Sandbox diagnostic agent. Follow instructions exactly.'
  }

  try {
    return await runSandboxRoleWorker(native, {
      name: `${provider}-hello`,
      policy,
      workerInput,
      envRecord: envBundle.envRecord
    })
  } finally {
    envBundle.authPrepared?.cleanupPlan?.()
  }
}

async function runProviderMcpCase(native, prod, provider, workspace, runtimeRoot, mcpUrl) {
  const policy = buildProductionPolicy(prod, runtimeRoot, workspace, provider)
  const envBundle = buildProductionSandboxEnv(prod, runtimeRoot, workspace, provider)

  const workerInput = {
    provider,
    role: 'task-worker',
    cwd: workspace,
    runtimeRoot,
    prompt: `Call codeteam-manager report_task_result now with status "completed". Then reply: mcp-ok`,
    systemPrompt: 'Sandbox diagnostic agent. You must call MCP tools when asked.',
    mcpUrl,
    mcpToolNames: ['report_task_result']
  }

  try {
    return await runSandboxRoleWorker(native, {
      name: `${provider}-mcp`,
      policy,
      workerInput,
      envRecord: envBundle.envRecord
    })
  } finally {
    envBundle.authPrepared?.cleanupPlan?.()
  }
}

function listRuntimeStateFiles(runtimeRoot, max = 40) {
  const found = []
  function walk(dir, depth) {
    if (depth > 6 || found.length >= max) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= max) break
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile() && /\.(json|toml)$/i.test(entry.name)) {
        found.push(full.slice(runtimeRoot.length + 1))
      }
    }
  }
  walk(runtimeRoot, 0)
  return found
}

function checkHostNotPolluted(provider) {
  const host = hostHome()
  const suspects = []
  if (provider === 'cursorcli') {
    const approvals = join(host, '.cursor', 'projects')
    if (existsSync(approvals)) {
      try {
        for (const slug of readdirSync(approvals)) {
          const file = join(approvals, slug, 'mcp-approvals.json')
          if (existsSync(file)) suspects.push(file)
        }
      } catch {
        /* best-effort, ignore errors */
      }
    }
  }
  return suspects
}

async function main() {
  const providers = resolveProviders()
  const report = {
    platform: process.platform,
    providers,
    caseFilter,
    skipLive,
    static: {},
    cursorCliArgs: null,
    live: {},
    failures: []
  }

  let workspacePath
  try {
    workspacePath = realpathSync(
      workspaceArg ?? process.env.TEST_WORKSPACE ?? join(tmpdir(), 'codetask-provider-ws')
    )
  } catch {
    workspacePath = workspaceArg ?? join(tmpdir(), 'codetask-provider-ws')
  }
  mkdirSync(workspacePath, { recursive: true })

  if (caseFilter === 'all' || caseFilter === 'static') {
    const prod = loadProductionSandboxModule()
    if (!prod) {
      report.failures.push('Production sandbox module missing — run npm run build')
    } else {
      const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-provider-static-'))
      try {
        for (const provider of providers) {
          report.static[provider] = analyzeStaticProvider(
            prod,
            provider,
            runtimeRoot,
            workspacePath
          )
          if (!report.static[provider].runtimeIsolated) {
            report.failures.push(`${provider}: static runtime isolation check failed`)
          }
        }
        const policyMod = loadProviderPolicyModule()
        if (policyMod?.buildCursorAcpCliArgs) {
          report.cursorCliArgs = policyMod.buildCursorAcpCliArgs({
            outerSandbox: true,
            cwd: workspacePath
          })
        }
        log('static', 'checks done', report.static)
      } finally {
        rmSync(runtimeRoot, { recursive: true, force: true })
      }
    }
  }

  const shouldRunLive = !skipLive && (caseFilter === 'all' || caseFilter === 'live')

  if (shouldRunLive) {
    const gate = sandboxTestsEnabled()
    if (!gate.enabled) {
      report.live.skipped = gate.reason
      log('live', `skipped: ${gate.reason}`)
    } else {
      const prod = loadProductionSandboxModule()
      if (!prod) {
        report.live.skipped = 'build output missing'
      } else {
        const native = loadNative()
        native.preflight()
        ensureWindowsSetup(native)

        const base = mkdtempSync(join(tmpdir(), 'codetask-provider-live-'))
        const runtimeRoot = join(base, 'runtime')
        mkdirSync(runtimeRoot, { recursive: true })

        for (const provider of providers) {
          const auth = authStatus(provider)
          report.live[provider] = { auth, hello: null, mcp: null }

          if (!auth.present) {
            report.live[provider].skipped = `No auth for ${provider} (${auth.detail})`
            report.failures.push(`${provider}: auth missing — skip live`)
            continue
          }

          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const hostSnapshots = {}

          try {
            const hello = await runProviderLiveCase(
              native,
              prod,
              provider,
              workspacePath,
              runtimeRoot
            )
            report.live[provider].hello = {
              ...summarizeChunks(hello),
              exitCode: hello.exitCode,
              elapsedMs: hello.elapsedMs,
              firstLineMs: hello.firstLineMs,
              stderrPreview: hello.stderr.slice(0, 400)
            }
            if (hello.exitCode !== 0 || summarizeChunks(hello).errors.length > 0) {
              report.failures.push(`${provider}: hello failed exit=${hello.exitCode}`)
            }
          } catch (error) {
            report.live[provider].hello = {
              failed: true,
              message: error instanceof Error ? error.message : String(error)
            }
            report.failures.push(
              `${provider}: hello threw — ${report.live[provider].hello.message}`
            )
          }

          const probe = await startProbeMcpServer()
          try {
            const mcp = await runProviderMcpCase(
              native,
              prod,
              provider,
              workspacePath,
              runtimeRoot,
              probe.url
            )
            report.live[provider].mcp = {
              ...summarizeChunks(mcp),
              exitCode: mcp.exitCode,
              toolCallCount: probe.calls.filter((c) => c.rpcMethod === 'tools/call').length,
              probeCalls: probe.calls
            }
            if (
              mcp.exitCode !== 0 ||
              probe.calls.filter((c) => c.rpcMethod === 'tools/call').length === 0
            ) {
              report.failures.push(`${provider}: MCP probe did not succeed`)
            }
          } catch (error) {
            report.live[provider].mcp = {
              failed: true,
              message: error instanceof Error ? error.message : String(error)
            }
            report.failures.push(`${provider}: mcp threw — ${report.live[provider].mcp.message}`)
          } finally {
            await probe.close()
          }

          report.live[provider].runtimeStateFiles = listRuntimeStateFiles(runtimeRoot)
          report.live[provider].hostPollution = checkHostNotPolluted(provider)
          if (report.live[provider].hostPollution.length > 0) {
            report.failures.push(
              `${provider}: host mcp-approvals still present: ${report.live[provider].hostPollution.join(', ')}`
            )
          }
        }

        report.live.runtimeRoot = runtimeRoot
      }
    }
  }

  const reportPath = join(
    mkdtempSync(join(tmpdir(), 'codetask-provider-report-')),
    'provider-runtime-report.json'
  )
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

  console.log('\n========== PROVIDER RUNTIME REPORT ==========')
  for (const provider of providers) {
    const staticInfo = report.static[provider]
    const liveInfo = report.live[provider]
    console.log(`\n[${provider}]`)
    if (staticInfo) {
      console.log(`  static: mode=${staticInfo.mode} isolated=${staticInfo.runtimeIsolated}`)
      console.log(`  env HOME=${staticInfo.env.HOME}`)
    }
    if (liveInfo?.hello) {
      console.log(
        `  live hello: exit=${liveInfo.hello.exitCode ?? 'n/a'} reply=${liveInfo.hello.completedPreview ?? liveInfo.hello.lastDeltaPreview ?? '(none)'}`
      )
    }
    if (liveInfo?.mcp) {
      console.log(`  live mcp: toolCalls=${liveInfo.mcp.toolCallCount ?? 0}`)
    }
    if (liveInfo?.skipped) console.log(`  skipped: ${liveInfo.skipped}`)
  }
  if (report.cursorCliArgs) {
    console.log(`\nCursor CLI args (outer sandbox): ${report.cursorCliArgs.join(' ')}`)
  }
  if (report.failures.length) {
    console.log('\nFailures:')
    for (const failure of report.failures) console.log(`  - ${failure}`)
  }
  console.log(`\nFull report: ${reportPath}`)

  if (report.failures.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error('[diagnose-provider] fatal:', error)
  process.exit(1)
})
