import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProviderAuth } from '../../src/server/sandbox/provider-auth/bridge'
import { runtimeCodexHome } from '../../src/server/sandbox/provider-auth/paths'
import { buildOuterSandboxCodexConfigOverrides } from '../../src/server/agent-runtime/mcp'
import { buildCodexTurnPlan } from '../../src/server/agent-runtime/providers/codex-policy'
import type { ConversationRole } from '../../src/server/agent-runtime/roles'
import type { AgentTurnInput } from '../../src/server/agent-runtime/types'

const TURN_TIMEOUT_MS = 8 * 60_000
const args = process.argv.slice(2)

function readArg(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const skipLive = args.includes('--skip-live')
const caseFilter = readArg('--case') ?? 'all'
const workspaceArg = readArg('--workspace')
const roleArg = readArg('--role') ?? 'task-worker'

const CODEX_ROLES: ConversationRole[] = [
  'conversation',
  'planner',
  'task-worker',
  'slice-verifier',
  'milestone-verifier'
]

function resolveRoles(): ConversationRole[] {
  if (roleArg === 'all') return CODEX_ROLES
  if (CODEX_ROLES.includes(roleArg as ConversationRole)) return [roleArg as ConversationRole]
  throw new Error(`unknown --role ${roleArg}`)
}

function log(step: string, message: string, extra?: unknown): void {
  const prefix = `[codex-light:${step}]`
  if (extra !== undefined) console.log(prefix, message, extra)
  else console.log(prefix, message)
}

function codexAuthPresent(codexHome: string): boolean {
  return (
    existsSync(join(codexHome, 'auth.json')) ||
    Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim())
  )
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

interface FakeMcpCall {
  at: string
  rpcMethod?: string
  tool?: string
  args?: unknown
}

function assertNoRuntimeCodexConfig(codexHome: string): void {
  const configPath = join(codexHome, 'config.toml')
  if (!existsSync(configPath)) return
  const raw = readFileSync(configPath, 'utf8')
  if (/mcp_servers|codeteam-manager/i.test(raw)) {
    throw new Error(`runtime config.toml must not contain MCP entries: ${configPath}`)
  }
}

function startFakeMcp(toolName = 'report_task_result'): Promise<{
  url: string
  calls: FakeMcpCall[]
  close: () => Promise<void>
}> {
  const calls: FakeMcpCall[] = []

  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(': ok\n\n')
      res.end()
      return
    }

    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })

    let parsed: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } } =
      {}
    try {
      parsed = body ? JSON.parse(body) : {}
    } catch {
      parsed = {}
    }

    const record: FakeMcpCall = {
      at: new Date().toISOString(),
      rpcMethod: parsed.method,
      tool: parsed.params?.name,
      args: parsed.params?.arguments
    }
    calls.push(record)
    console.log('[fake-mcp]', JSON.stringify(record))

    if (parsed.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-codex-mcp', version: '1.0.0' }
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
                description: 'Fake probe',
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
      console.log('[fake-mcp] TOOL CALLED:', parsed.params?.name, parsed.params?.arguments)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          result: {
            content: [{ type: 'text', text: `ok:${parsed.params?.name}` }],
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
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

function listRuntimeJson(runtimeRoot: string): string[] {
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

function turnInput(
  role: ConversationRole,
  cwd: string,
  runtimeRoot: string,
  mcpUrl?: string
): AgentTurnInput {
  return {
    provider: 'codex',
    role,
    cwd,
    runtimeRoot,
    prompt: 'probe',
    mcpUrl
  }
}

async function runCodexTurn(input: {
  role: ConversationRole
  cwd: string
  runtimeRoot: string
  env?: Record<string, string>
  prompt: string
  mcpUrl?: string
  outerSandbox?: boolean
}): Promise<{ reply: string; threadId: string | null; elapsedMs: number; mcpToolCalls: string[] }> {
  const plan = buildCodexTurnPlan(
    turnInput(input.role, input.cwd, input.runtimeRoot, input.mcpUrl),
    {
      outerSandbox: input.outerSandbox
    }
  )
  const env = input.env ?? plan.env
  const codexHome = env.CODEX_HOME ?? ''
  if (codexHome) assertNoRuntimeCodexConfig(codexHome)

  const { Codex } = await import('@openai/codex-sdk')
  const codex = new Codex({
    env,
    ...(plan.sdkConfig
      ? { config: plan.sdkConfig as NonNullable<ConstructorParameters<typeof Codex>[0]>['config'] }
      : {})
  })

  const thread = codex.startThread(plan.threadOptions)

  const started = Date.now()
  const mcpToolCalls: string[] = []
  let reply = ''

  const streamed = await thread.runStreamed(input.prompt)
  const deadline = started + TURN_TIMEOUT_MS

  for await (const event of streamed.events) {
    if (Date.now() > deadline) {
      throw new Error(`turn timeout (${TURN_TIMEOUT_MS / 1000}s)`)
    }

    if (
      event.type === 'item.updated' ||
      event.type === 'item.started' ||
      event.type === 'item.completed'
    ) {
      const item = event.item as {
        type?: string
        text?: string
        tool?: string
        status?: string
      }
      if (item.type === 'mcp_tool_call' && item.tool) {
        mcpToolCalls.push(`${item.tool}:${item.status ?? '?'}`)
        console.log('[codex-sdk] mcp_tool_call', item.tool, item.status)
      }
      if (item.type === 'agent_message' && item.text) {
        reply = item.text
        process.stdout.write('.')
      }
    }

    if (event.type === 'turn.failed') {
      throw new Error(event.error.message)
    }

    if (event.type === 'turn.completed') {
      break
    }
  }

  console.log('')
  return {
    reply: reply.trim(),
    threadId: thread.id,
    elapsedMs: Date.now() - started,
    mcpToolCalls
  }
}

function expectedMcpTool(role: ConversationRole, runtimeRoot: string): string | undefined {
  const plan = buildCodexTurnPlan(
    { ...turnInput(role, '/workspace', runtimeRoot), mcpUrl: 'http://127.0.0.1:1/mcp' },
    { outerSandbox: role !== 'conversation' && role !== 'planner' }
  )
  return plan.mcpToolNames?.[0]
}

async function runStaticForRole(
  role: ConversationRole,
  runtimeRoot: string
): Promise<{
  role: ConversationRole
  outerSandbox: boolean
  sandboxMode: string
  mode: string
  authPresent: boolean
  codexHome: string
  configTomlPresent: boolean
  writeRoots: string[]
  sdkOverrides: unknown
  sdkConfigKeys: string[]
  mcpViaSdkOnly: boolean
  mcpToolNames: string[] | undefined
  mcpTools: string[]
  runtimeIsolated: boolean
}> {
  const outerSandbox = role !== 'conversation' && role !== 'planner'
  const plan = buildCodexTurnPlan(
    { ...turnInput(role, '/workspace', runtimeRoot), mcpUrl: 'http://127.0.0.1:1/mcp' },
    { outerSandbox }
  )

  const prepared = outerSandbox ? prepareProviderAuth('codex', runtimeRoot) : null
  const codexHome = outerSandbox
    ? (prepared!.envPatch.CODEX_HOME ?? runtimeCodexHome(runtimeRoot))
    : join(process.env.CODEX_HOME ?? join(process.env.HOME ?? runtimeRoot, '.codex'))

  const mcpTools = plan.sdkConfig?.mcp_servers
    ? Object.keys(
        (plan.sdkConfig.mcp_servers as Record<string, { tools?: Record<string, unknown> }>)[
          'codeteam-manager'
        ]?.tools ?? {}
      )
    : []

  const report = {
    role,
    outerSandbox: plan.outerSandbox,
    sandboxMode: plan.threadOptions.sandboxMode,
    mode: prepared?.diagnostics.mode ?? 'host-identity',
    authPresent: outerSandbox
      ? Boolean(prepared?.diagnostics.authMaterialPresent && codexAuthPresent(codexHome))
      : codexAuthPresent(codexHome),
    codexHome,
    configTomlPresent: existsSync(join(codexHome, 'config.toml')),
    writeRoots: prepared?.writeRoots ?? [],
    sdkOverrides: outerSandbox ? buildOuterSandboxCodexConfigOverrides() : null,
    sdkConfigKeys: plan.sdkConfig ? Object.keys(plan.sdkConfig) : [],
    mcpViaSdkOnly: true,
    mcpToolNames: plan.mcpToolNames,
    mcpTools,
    runtimeIsolated: outerSandbox
      ? prepared!.diagnostics.mode === 'runtime-copy' &&
        prepared!.envPatch.HOME === runtimeRoot &&
        prepared!.envPatch.CODEX_HOME === runtimeCodexHome(runtimeRoot) &&
        (prepared!.writeRoots ?? []).length === 0
      : plan.threadOptions.sandboxMode === 'workspace-write' && !plan.outerSandbox
  }

  log('static', role, report)

  if (outerSandbox && !report.runtimeIsolated) {
    throw new Error(`[${role}] runtime-copy isolation check failed`)
  }
  if (!outerSandbox && plan.outerSandbox) {
    throw new Error(`[${role}] conversation must not use outer sandbox`)
  }
  const expectedTool = expectedMcpTool(role, runtimeRoot)
  if (expectedTool && !mcpTools.includes(expectedTool)) {
    throw new Error(`[${role}] SDK config missing ${expectedTool}`)
  }

  return report
}

async function runStatic(runtimeRoot: string): Promise<Record<string, unknown>> {
  const roles = resolveRoles()
  const byRole: Record<string, unknown> = {}
  for (const role of roles) {
    byRole[role] = await runStaticForRole(role, join(runtimeRoot, role))
  }
  return byRole
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'codetask-codex-light-'))
  const runtimeRoot = join(base, 'runtime')
  const workspace = workspaceArg ?? join(base, 'workspace')
  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# codex light probe\n', 'utf8')

  const liveRole: ConversationRole =
    roleArg === 'all' || !CODEX_ROLES.includes(roleArg as ConversationRole)
      ? 'task-worker'
      : (roleArg as ConversationRole)

  const report: Record<string, unknown> = {
    platform: process.platform,
    workspace,
    runtimeRoot,
    caseFilter,
    roleFilter: roleArg,
    liveRole,
    skipLive,
    static: null,
    hello: null,
    mcp: null,
    runtimeJson: null,
    failures: [] as string[]
  }

  const prepared = prepareProviderAuth('codex', runtimeRoot)

  try {
    if (caseFilter === 'all' || caseFilter === 'static') {
      report.static = await runStatic(runtimeRoot)
    }

    const shouldLive =
      !skipLive && (caseFilter === 'all' || caseFilter === 'hello' || caseFilter === 'mcp')
    const env = buildMergedEnv(prepared.envPatch)
    const codexHome = env.CODEX_HOME ?? runtimeCodexHome(runtimeRoot)

    if (shouldLive) {
      if (!codexAuthPresent(codexHome)) {
        ;(report.failures as string[]).push('auth: Codex auth.json / API key missing')
        log('live', 'skipped — no auth')
      } else if (caseFilter === 'all' || caseFilter === 'hello') {
        try {
          const result = await runCodexTurn({
            role: liveRole,
            cwd: workspace,
            runtimeRoot,
            env,
            outerSandbox: liveRole !== 'conversation' && liveRole !== 'planner',
            prompt: 'Reply with exactly: pong'
          })
          report.hello = result
          log('hello', 'done', result)
          if (!result.reply.toLowerCase().includes('pong') && !result.threadId) {
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

      if (caseFilter === 'all' || caseFilter === 'mcp') {
        const mcpTool =
          buildCodexTurnPlan(turnInput(liveRole, workspace, runtimeRoot), {
            outerSandbox: liveRole !== 'conversation' && liveRole !== 'planner'
          }).mcpToolNames?.[0] ?? 'report_task_result'
        const fake = await startFakeMcp(mcpTool)
        log('mcp', `fake server at ${fake.url} tool=${mcpTool} role=${liveRole}`)
        try {
          const result = await runCodexTurn({
            role: liveRole,
            cwd: workspace,
            runtimeRoot,
            env,
            mcpUrl: fake.url,
            outerSandbox: liveRole !== 'conversation' && liveRole !== 'planner',
            prompt: `Call codeteam-manager ${mcpTool} now with status "completed". Then reply: mcp-ok`
          })
          const toolCalls = fake.calls.filter((c) => c.rpcMethod === 'tools/call')
          report.mcp = {
            ...result,
            fakeMcpCalls: fake.calls.length,
            httpToolCalls: toolCalls.length
          }
          log('mcp', 'done', report.mcp)
          if (toolCalls.length === 0 && result.mcpToolCalls.length === 0) {
            ;(report.failures as string[]).push(`mcp: Codex did not call ${mcpTool}`)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          report.mcp = { failed: true, message, fakeCalls: fake.calls }
          ;(report.failures as string[]).push(`mcp: ${message}`)
        } finally {
          await fake.close()
        }
      }
    }

    report.runtimeJson = listRuntimeJson(runtimeRoot)
    const reportPath = join(base, 'codex-light-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

    console.log('\n========== CODEX LIGHT TEST ==========')
    if (report.static) console.log('static: OK')
    if (report.hello) console.log('hello:', report.hello)
    if (report.mcp) console.log('mcp:', report.mcp)
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
  console.error('[codex-light] fatal:', error)
  process.exit(1)
})
