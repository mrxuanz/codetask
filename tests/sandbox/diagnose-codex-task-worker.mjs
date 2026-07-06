import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadNative,
  policyForRoleV2,
  sandboxTestsEnabled,
  wirePolicy
} from './sandbox-test-utils.mjs'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const skipLive = args.includes('--skip-live')
const workspaceArg = readArg('--workspace')
const caseFilter = args.includes('--case') ? args[args.indexOf('--case') + 1] : 'all'

const TASK_EXPECTED_FILES = [
  'src/App.vue',
  'src/data/siteContent.js',
  'package.json',
  'vite.config.js'
]

const CODEX_CONVERSATION_MCP_TOOLS = [
  'propose_task_draft',
  'read_reference_attachment',
  'get_task_draft',
  'get_execution_plan',
  'revise_requirements_contract',
  'confirm_requirements_contract',
  'update_task_draft',
  'update_execution_plan_node',
  'confirm_draft_section',
  'request_phase_rollback'
]

function readArg(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function log(section, message, extra) {
  const prefix = `[diagnose-codex:${section}]`
  if (extra !== undefined) console.log(prefix, message, extra)
  else console.log(prefix, message)
}

function resolveRoleWorkerPath() {
  const candidates = [
    join(process.cwd(), 'out', 'main', 'sandbox', 'role-worker.js'),
    join(process.cwd(), 'out', 'main', 'sandbox', 'role-worker.cjs'),
    join(process.cwd(), 'out', 'main', 'sandbox', 'role-worker-codex.js'),
    join(process.cwd(), 'out', 'main', 'sandbox', 'role-worker-codex.cjs')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function buildCodexSdkConfig(input) {
  const config = {}
  if (input.mcpUrl) {
    const toolNames = input.mcpToolNames ?? CODEX_CONVERSATION_MCP_TOOLS
    config.mcp_servers = {
      'codeteam-manager': {
        url: input.mcpUrl,
        http_headers: { Accept: 'application/json, text/event-stream' },
        default_tools_approval_mode: 'approve',
        tools: Object.fromEntries(toolNames.map((name) => [name, { approval_mode: 'approve' }]))
      }
    }
  }
  if (input.outerSandbox) {
    Object.assign(config, {
      sandbox_mode: 'danger-full-access',
      approval_policy: 'never',
      sandbox_workspace_write: { network_access: true }
    })
  }
  const hasMcp = Boolean(config.mcp_servers && Object.keys(config.mcp_servers).length > 0)
  if (!hasMcp && !input.outerSandbox) return undefined
  return config
}

function codexAuthPresent() {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return existsSync(join(codexHome, 'auth.json'))
}

function listDirNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return null
  }
}

function probeWorkspace(workspacePath) {
  const result = {
    path: workspacePath,
    exists: existsSync(workspacePath),
    entries: [],
    expectedFiles: {},
    missingExpected: [],
    looksLikeVueProject: false,
    siblingVueProjects: []
  }

  if (!result.exists) {
    return result
  }

  result.entries = listDirNames(workspacePath) ?? []
  for (const rel of TASK_EXPECTED_FILES) {
    const full = join(workspacePath, rel)
    const present = existsSync(full)
    result.expectedFiles[rel] = present
    if (!present) result.missingExpected.push(rel)
  }
  result.looksLikeVueProject =
    result.expectedFiles['package.json'] && result.expectedFiles['src/App.vue']

  const parent = dirname(workspacePath)
  for (const name of listDirNames(parent) ?? []) {
    if (name.startsWith('.')) continue
    const sibling = join(parent, name)
    try {
      if (!statSync(sibling).isDirectory()) continue
    } catch {
      continue
    }
    const hasPackage = existsSync(join(sibling, 'package.json'))
    const hasSrcApp = existsSync(join(sibling, 'src', 'App.vue'))
    if (hasPackage && hasSrcApp) {
      result.siblingVueProjects.push(realpathSync(sibling))
    }
  }

  return result
}

function analyzeArchitectureDiff() {
  return {
    testsdkConversation: {
      role: 'planner (default conversation)',
      outerSandbox: false,
      path: 'streamCodexTurn(workerInput, { outerSandbox: false }) directly on host',
      mcpToolNames: 'passed from conversation service (e.g. test_print, read_reference_attachment)',
      mcpUrlKind: 'conversation MCP (/api/mcp/conversation/...)',
      note: 'testsdk worker-input.json with role=planner is host-side SDK, not task-worker sandbox'
    },
    taskJobExecution: {
      role: 'task-worker',
      outerSandbox: true,
      path: 'streamAgentTurn -> streamSandboxedConversationTurn -> role-worker.js in native sandbox',
      mcpToolNames:
        'NOT forwarded: RunSandboxedTurnInput / orchestrator-local workerInput omit mcpToolNames',
      mcpUrlKind: 'task MCP (/api/mcp/task/...) with report_task_result',
      readRoots: 'attachment paths merged into sandbox allowed_read_roots',
      stdoutBehavior:
        'Windows elevated sandbox buffers role-worker stdout until process exit (see role-worker.ts comment)',
      failureMode:
        'agent calls report_task_result(status=blocked) when workspace lacks expected project files'
    },
    configGap: {
      executorOmitsMcpToolNames: true,
      defaultMcpToolListIncludesReportTaskResult:
        CODEX_CONVERSATION_MCP_TOOLS.includes('report_task_result'),
      mitigatedByDefaultApprovalMode:
        'default_tools_approval_mode=approve should still auto-approve report_task_result'
    }
  }
}

function analyzeMcpConfigForTaskWorker(mcpUrl) {
  const withoutToolNames = buildCodexSdkConfig({ mcpUrl, outerSandbox: true })
  const withReportTool = buildCodexSdkConfig({
    mcpUrl,
    outerSandbox: true,
    mcpToolNames: ['report_task_result']
  })
  return {
    taskExecutorToday: {
      explicitToolApprovals: Object.keys(
        withoutToolNames?.mcp_servers?.['codeteam-manager']?.tools ?? {}
      ),
      includesReportTaskResult: Boolean(
        withoutToolNames?.mcp_servers?.['codeteam-manager']?.tools?.report_task_result
      ),
      defaultToolsApprovalMode:
        withoutToolNames?.mcp_servers?.['codeteam-manager']?.default_tools_approval_mode ?? null
    },
    recommended: {
      explicitToolApprovals: Object.keys(
        withReportTool?.mcp_servers?.['codeteam-manager']?.tools ?? {}
      ),
      includesReportTaskResult: true
    }
  }
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

function buildProductionSandboxEnv(prod, runtimeRoot, workspaceRoot, coreCode = 'codex') {
  const authPrepared = prod.prepareProviderAuth(coreCode, runtimeRoot, { workspaceRoot })
  if (typeof prod.runProviderAuthPreflight === 'function') {
    prod.runProviderAuthPreflight(coreCode, authPrepared)
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

function buildProductionPolicy(prod, runtimeRoot, workspaceRoot, readRoots = []) {
  const authPrepared = prod.prepareProviderAuth('codex', runtimeRoot, { workspaceRoot })
  const dataDir =
    typeof prod.resolveSandboxDataDir === 'function'
      ? prod.resolveSandboxDataDir()
      : join(process.cwd(), 'data')
  const providerReadRoots =
    typeof prod.mergeProviderReadRoots === 'function' &&
    typeof prod.resolveProviderReadRoots === 'function'
      ? prod.mergeProviderReadRoots(prod.resolveProviderReadRoots('codex'), [
          ...authPrepared.readRoots,
          dataDir
        ])
      : []
  if (typeof prod.policyForRoleV2 === 'function') {
    return prod.policyForRoleV2({
      role: 'task-worker',
      workspaceRoot,
      runtimeRoot,
      providerReadRoots,
      providerWriteRoots: authPrepared.writeRoots,
      attachmentReadRoots: readRoots
    })
  }
  return policyForRoleV2('task-worker', workspaceRoot, runtimeRoot)
}

function buildMinimalSandboxEnv(runtimeRoot) {
  const env = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    CODETASK_OUTER_SANDBOX: '1',
    CODETASK_RUNTIME_ROOT: runtimeRoot,
    HOME: runtimeRoot,
    TMPDIR: join(runtimeRoot, 'tmp'),
    TEMP: join(runtimeRoot, 'tmp'),
    TMP: join(runtimeRoot, 'tmp')
  }
  const hostProfile = process.env.USERPROFILE ?? process.env.HOME
  if (hostProfile) env.CODETASK_SANDBOX_HOST_PROFILE = hostProfile
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  if (process.platform === 'win32') {
    env.ELECTRON_RUN_AS_NODE = '1'
    env.ELECTRON_DISABLE_CRASH_REPORTER = '1'
    env.USERPROFILE = hostProfile ?? runtimeRoot
    env.APPDATA = join(hostProfile ?? runtimeRoot, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(hostProfile ?? runtimeRoot, 'AppData', 'Local')
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
    env.CODEX_HOME = codexHome
    env.CODETASK_PROVIDER_AUTH_MODE = 'host-identity'
  }
  return env
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runSandboxRoleWorker(native, options) {
  const { name, policy, workerInput, envRecord, timeoutMs = 600_000 } = options

  const workerPath = resolveRoleWorkerPath()
  if (!workerPath) throw new Error('role-worker.js missing; run npm run build')

  const env = Object.entries(envRecord).map(([key, value]) => ({ key, value }))
  log(name, 'launching role-worker', { workerPath, cwd: policy.cwd })

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
        if (firstLineAt === null) firstLineAt = Date.now()
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
      for (;;) {
        const errTail = handle.readStderrChunk(64 * 1024)
        if (!errTail?.length) break
        stderr += errTail.toString('utf8')
      }
      handle.close()
      return {
        name,
        exitCode,
        elapsedMs: Date.now() - startedAt,
        firstLineMs: firstLineAt === null ? null : firstLineAt - startedAt,
        chunks,
        stderr: stderr.trim(),
        evidence: handle.evidence
      }
    }
    await sleep(25)
  }

  handle.kill()
  handle.close()
  throw new Error(`${name}: timed out after ${timeoutMs}ms`)
}

function startProbeMcpServer(tools) {
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
      tool: parsed.params?.name,
      args: parsed.params?.arguments
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
            serverInfo: { name: 'probe-task-mcp', version: '1.0.0' }
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
          result: { tools }
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
            structuredContent: { ok: true, tool: parsed.params?.name }
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function runDirectCodexHello(workspace, _runtimeRoot) {
  let Codex
  try {
    ;({ Codex } = await import('@openai/codex-sdk'))
  } catch {
    return { skipped: true, reason: '@openai/codex-sdk not installed' }
  }

  const codex = new Codex({
    env: {
      PATH: process.env.PATH ?? '',
      CODEX_HOME: process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
    },
    config: buildCodexSdkConfig({ outerSandbox: false })
  })

  const thread = codex.startThread({
    workingDirectory: workspace,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    networkAccessEnabled: true
  })

  const startedAt = Date.now()
  let firstDeltaMs = null
  let reply = ''
  const { events } = await thread.runStreamed('Reply with exactly: pong')
  for await (const event of events) {
    if (event.type === 'item.updated' || event.type === 'item.completed') {
      if (event.item.type === 'agent_message' && event.item.text) {
        if (firstDeltaMs === null) firstDeltaMs = Date.now() - startedAt
        reply = event.item.text
      }
    }
    if (event.type === 'turn.failed') throw new Error(event.error.message)
  }

  return {
    skipped: false,
    elapsedMs: Date.now() - startedAt,
    firstDeltaMs,
    reply: reply.trim(),
    streaming: firstDeltaMs !== null && firstDeltaMs < Date.now() - startedAt - 100
  }
}

async function runSandboxCodexCase(
  native,
  { workspace, runtimeRoot, mcpUrl, mcpToolNames, prompt, prod }
) {
  const policy = prod
    ? buildProductionPolicy(prod, runtimeRoot, workspace)
    : policyForRoleV2('task-worker', workspace, runtimeRoot)
  const envBundle = prod
    ? buildProductionSandboxEnv(prod, runtimeRoot, workspace)
    : { envRecord: buildMinimalSandboxEnv(runtimeRoot), authPrepared: null }

  const workerInput = {
    provider: 'codex',
    role: 'task-worker',
    cwd: workspace,
    runtimeRoot,
    prompt,
    systemPrompt:
      'You are a sandbox diagnostic agent. Follow instructions exactly and call MCP when asked.',
    ...(mcpUrl ? { mcpUrl } : {}),
    ...(mcpToolNames ? { mcpToolNames } : {})
  }

  try {
    return await runSandboxRoleWorker(native, {
      name: mcpUrl ? 'codex-sandbox-mcp' : 'codex-sandbox-hello',
      policy,
      workerInput,
      envRecord: envBundle.envRecord,
      timeoutMs: 600_000
    })
  } finally {
    envBundle.authPrepared?.cleanupPlan?.()
  }
}

function summarizeCodexChunks(result) {
  const deltas = result.chunks.filter((c) => c.type === 'delta')
  const completed = result.chunks.find((c) => c.type === 'completed')
  const errors = result.chunks.filter((c) => c.type === 'error')
  return {
    deltaCount: deltas.length,
    lastDeltaPreview: deltas.at(-1)?.content?.slice(0, 160) ?? null,
    completedPreview: completed?.reply?.slice(0, 160) ?? null,
    errors: errors.map((e) => e.message)
  }
}

function deriveRootCause(report) {
  const causes = []

  const ws = report.workspace
  if (ws && !ws.looksLikeVueProject) {
    causes.push({
      id: 'empty-or-wrong-workspace',
      severity: 'primary',
      detail: `Workspace ${ws.path} is missing expected Vue files: ${ws.missingExpected.join(', ')}`
    })
    if (ws.siblingVueProjects.length > 0) {
      causes.push({
        id: 'vue-project-in-sibling-directory',
        severity: 'primary',
        detail: `Agent may discover Vue project at ${ws.siblingVueProjects[0]} outside assigned workspace`
      })
    }
  }

  if (report.architecture?.taskJobExecution?.mcpToolNames?.includes('NOT forwarded')) {
    causes.push({
      id: 'mcp-tool-names-not-forwarded',
      severity: 'secondary',
      detail:
        'task-worker sandbox path drops mcpToolNames; report_task_result not in explicit tool approval list (default approve may still work)'
    })
  }

  const sandboxHello = report.live?.sandboxHello
  if (sandboxHello && sandboxHello.firstLineMs > 30_000) {
    causes.push({
      id: 'sandbox-stdout-buffering',
      severity: 'secondary',
      detail: `First sandbox stdout arrived after ${sandboxHello.firstLineMs}ms — matches supervisor-client "still waiting" logs on Windows`
    })
  }

  const mcp = report.live?.sandboxMcp
  if (mcp?.failed || (mcp?.exitCode !== undefined && mcp.exitCode !== 0 && !mcp?.skipped)) {
    causes.push({
      id: 'sandbox-role-worker-failed',
      severity: 'primary',
      detail:
        mcp?.message ??
        `role-worker exited ${mcp?.exitCode} inside outer sandbox — check stderrPreview in report`
    })
  } else if (mcp?.toolCallCount === 0 && mcp?.skipped !== true) {
    causes.push({
      id: 'mcp-not-reachable-in-sandbox',
      severity: 'primary',
      detail: 'Codex in outer sandbox did not call probe MCP tools/call'
    })
  }

  if (causes.length === 0) {
    causes.push({
      id: 'no-static-cause',
      severity: 'info',
      detail: 'Static checks passed; inspect live section or job-specific workspace path'
    })
  }

  return causes
}

async function main() {
  const report = {
    platform: process.platform,
    execPath: process.execPath,
    caseFilter,
    skipLive,
    architecture: null,
    mcpConfig: null,
    workspace: null,
    live: {},
    rootCauses: []
  }

  if (caseFilter === 'all' || caseFilter === 'static') {
    report.architecture = analyzeArchitectureDiff()
    report.mcpConfig = analyzeMcpConfigForTaskWorker('http://127.0.0.1:8080/api/mcp/task/example')
    log('static', 'architecture diff ready')
    log('static', 'task mcp config', report.mcpConfig.taskExecutorToday)
  }

  let workspacePath
  try {
    workspacePath = realpathSync(
      workspaceArg ?? process.env.TEST_WORKSPACE ?? 'E:\\testwork\\cxseq'
    )
  } catch {
    workspacePath = workspaceArg ?? process.env.TEST_WORKSPACE ?? 'E:\\testwork\\cxseq'
  }

  if (caseFilter === 'all' || caseFilter === 'workspace') {
    report.workspace = probeWorkspace(workspacePath)
    log('workspace', report.workspace.path, {
      looksLikeVueProject: report.workspace.looksLikeVueProject,
      missing: report.workspace.missingExpected,
      siblings: report.workspace.siblingVueProjects
    })
  }

  const shouldRunLive =
    !skipLive &&
    (caseFilter === 'all' ||
      caseFilter === 'live' ||
      caseFilter === 'codex-direct' ||
      caseFilter === 'codex-sandbox' ||
      caseFilter === 'sandbox-smoke')

  if (shouldRunLive) {
    const gate = sandboxTestsEnabled()
    if (!gate.enabled) {
      report.live.skipped = gate.reason
      log('live', `skipped: ${gate.reason}`)
    } else if (!codexAuthPresent()) {
      report.live.skipped = 'Codex auth.json missing — set CODEX_HOME or login via Codex CLI'
      log('live', report.live.skipped)
    } else {
      const native = loadNative()
      native.preflight()
      ensureWindowsSetup(native)
      const prod = loadProductionSandboxModule()
      report.live.productionEnv = prod ? 'loaded from out/main/chunks' : 'fallback minimal env'

      const base = mkdtempSync(join(tmpdir(), 'codeteam-codex-diagnose-'))
      const runtimeRoot = join(base, 'runtime')
      mkdirSync(runtimeRoot, { recursive: true })
      report.live.runtimeRoot = runtimeRoot

      if (caseFilter === 'all' || caseFilter === 'codex-direct' || caseFilter === 'live') {
        try {
          report.live.directHello = await runDirectCodexHello(workspacePath, runtimeRoot)
          log('live', 'direct codex hello', report.live.directHello)
        } catch (error) {
          report.live.directHello = {
            failed: true,
            message: error instanceof Error ? error.message : String(error)
          }
          log('live', 'direct codex hello FAILED', report.live.directHello.message)
        }
      }

      if (caseFilter === 'all' || caseFilter === 'codex-sandbox' || caseFilter === 'live') {
        try {
          const sandboxHello = await runSandboxCodexCase(native, {
            workspace: workspacePath,
            runtimeRoot,
            prompt: 'Reply with exactly: pong',
            prod
          })
          report.live.sandboxHello = {
            ...summarizeCodexChunks(sandboxHello),
            exitCode: sandboxHello.exitCode,
            elapsedMs: sandboxHello.elapsedMs,
            firstLineMs: sandboxHello.firstLineMs,
            stderrPreview: sandboxHello.stderr.slice(0, 400)
          }
          log('live', 'sandbox codex hello', report.live.sandboxHello)
        } catch (error) {
          report.live.sandboxHello = {
            failed: true,
            message: error instanceof Error ? error.message : String(error)
          }
          log('live', 'sandbox codex hello FAILED', report.live.sandboxHello.message)
        }

        const probe = await startProbeMcpServer([
          {
            name: 'report_task_result',
            description: 'Submit task status',
            inputSchema: {
              type: 'object',
              properties: { status: { type: 'string' } },
              required: ['status']
            }
          }
        ])

        try {
          const sandboxMcp = await runSandboxCodexCase(native, {
            workspace: workspacePath,
            runtimeRoot,
            mcpUrl: probe.url,
            prompt:
              'Call codeteam-manager report_task_result now with status "completed". Then reply: mcp-ok',
            prod
          })
          report.live.sandboxMcp = {
            ...summarizeCodexChunks(sandboxMcp),
            exitCode: sandboxMcp.exitCode,
            elapsedMs: sandboxMcp.elapsedMs,
            firstLineMs: sandboxMcp.firstLineMs,
            toolCallCount: probe.calls.filter((c) => c.rpcMethod === 'tools/call').length,
            probeCalls: probe.calls
          }
          log('live', 'sandbox codex mcp (no mcpToolNames)', report.live.sandboxMcp)
        } catch (error) {
          report.live.sandboxMcp = {
            failed: true,
            message: error instanceof Error ? error.message : String(error)
          }
          log('live', 'sandbox codex mcp FAILED', report.live.sandboxMcp.message)
        } finally {
          await probe.close()
        }

        const probe2 = await startProbeMcpServer([
          {
            name: 'report_task_result',
            description: 'Submit task status',
            inputSchema: {
              type: 'object',
              properties: { status: { type: 'string' } },
              required: ['status']
            }
          }
        ])

        try {
          const sandboxMcpExplicit = await runSandboxCodexCase(native, {
            workspace: workspacePath,
            runtimeRoot,
            mcpUrl: probe2.url,
            mcpToolNames: ['report_task_result'],
            prompt:
              'Call codeteam-manager report_task_result now with status "completed". Then reply: mcp-ok',
            prod
          })
          report.live.sandboxMcpExplicitTools = {
            ...summarizeCodexChunks(sandboxMcpExplicit),
            exitCode: sandboxMcpExplicit.exitCode,
            toolCallCount: probe2.calls.filter((c) => c.rpcMethod === 'tools/call').length
          }
          log('live', 'sandbox codex mcp (with mcpToolNames)', report.live.sandboxMcpExplicitTools)
        } catch (error) {
          report.live.sandboxMcpExplicitTools = {
            failed: true,
            message: error instanceof Error ? error.message : String(error)
          }
        } finally {
          await probe2.close()
        }
      }

      if (caseFilter === 'all' || caseFilter === 'sandbox-smoke') {
        const policy = policyForRoleV2('task-worker', workspacePath, runtimeRoot)
        const handle = native.launchSandboxedWorker({
          policyJson: wirePolicy(policy),
          command: process.execPath,
          args: ['-e', "console.log(JSON.stringify({type:'completed',reply:'pong'}))"],
          cwd: policy.cwd,
          env: Object.entries(buildMinimalSandboxEnv(runtimeRoot)).map(([key, value]) => ({
            key,
            value
          }))
        })
        handle.endStdin()
        handle.waitForAttestation(15_000)
        const startedAt = Date.now()
        let firstLineMs = null
        while (Date.now() - startedAt < 10_000) {
          const chunk = handle.readStdoutChunk(64 * 1024)
          if (chunk?.length && firstLineMs === null) firstLineMs = Date.now() - startedAt
          const code = handle.pollExit()
          if (code !== null && code !== undefined) break
          await sleep(25)
        }
        handle.close()
        report.live.sandboxSmoke = { firstLineMs, note: 'electron -e ping inside sandbox' }
        log('live', 'sandbox smoke', report.live.sandboxSmoke)
      }
    }
  }

  report.rootCauses = deriveRootCause(report)
  const reportPath = join(
    mkdtempSync(join(tmpdir(), 'codeteam-codex-report-')),
    'codex-task-worker-report.json'
  )
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

  console.log('\n========== ROOT CAUSES ==========')
  for (const cause of report.rootCauses) {
    console.log(`- [${cause.severity}] ${cause.id}: ${cause.detail}`)
  }
  console.log(`\nFull report: ${reportPath}`)

  const failed =
    report.rootCauses.some((c) => c.severity === 'primary') ||
    report.live.directHello?.failed ||
    report.live.sandboxHello?.failed ||
    report.live.sandboxMcp?.failed

  if (failed) process.exit(1)
}

main().catch((error) => {
  console.error('[diagnose-codex] fatal:', error)
  process.exit(1)
})
