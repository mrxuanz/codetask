import { spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ClientContext,
  type McpServer,
  type StopReason
} from '@agentclientprotocol/sdk'
import { prepareProviderAuth } from '../../src/server/sandbox/provider-auth/bridge'
import { buildCursorAcpCliArgs } from '../../src/server/agent-runtime/provider-policy'
import {
  probeCursorAgentAuth,
  CURSOR_CLI_MISSING_MESSAGE,
  classifyCursorAcpError
} from '../../src/server/agent-runtime/cursor-acp/errors'
import {
  resolveCursorAgentCommand,
  resolveCursorAgentExecutable,
  spawnCursorAgent
} from '../../src/server/agent-runtime/cursor-acp/command'
import { createCursorPermissionHandler } from '../../src/server/agent-runtime/cursor-acp/permissions'
import { autoAnswerCursorAskQuestion } from '../../src/server/agent-runtime/cursor-acp/extensions'

const MCP_ACCEPT = 'application/json, text/event-stream'
const CURSOR_ACP_RPC_TIMEOUT_MS = 60_000
const CURSOR_ACP_AUTH_TIMEOUT_MS = 120_000
const CURSOR_TURN_TIMEOUT_MS = 5 * 60_000

const args = process.argv.slice(2)

function readArg(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const skipLive = args.includes('--skip-live')
const caseFilter = readArg('--case') ?? 'all'
const workspaceArg = readArg('--workspace')

function log(step: string, message: string, extra?: unknown): void {
  const prefix = `[cursor-light:${step}]`
  if (extra !== undefined) console.log(prefix, message, extra)
  else console.log(prefix, message)
}

function hostHome(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir()
}

function findHostMcpApprovals(): string[] {
  const root = join(hostHome(), '.cursor', 'projects')
  if (!existsSync(root)) return []
  const found: string[] = []
  for (const slug of readdirSync(root)) {
    const file = join(root, slug, 'mcp-approvals.json')
    if (existsSync(file)) found.push(file)
  }
  return found
}

interface FakeMcpCall {
  at: string
  rpcMethod?: string
  tool?: string
  args?: unknown
}

function startFakeMcp(toolName = 'report_task_result'): Promise<{
  url: string
  calls: FakeMcpCall[]
  close: () => Promise<void>
}> {
  const calls: FakeMcpCall[] = []

  const server = createServer(async (req, res) => {
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
            serverInfo: { name: 'fake-cursor-mcp', version: '1.0.0' }
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
                description: 'Fake probe — prints on call',
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

async function withRuntimeEnv(
  envPatch: Record<string, string>,
  fn: () => Promise<void>
): Promise<void> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(envPatch)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  const savedOuter = process.env.CODETASK_OUTER_SANDBOX
  process.env.CODETASK_OUTER_SANDBOX = '1'
  try {
    await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (savedOuter === undefined) delete process.env.CODETASK_OUTER_SANDBOX
    else process.env.CODETASK_OUTER_SANDBOX = savedOuter
  }
}

function buildMergedEnv(envPatch: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, envPatch)
  return env
}

function buildHttpMcp(url: string): McpServer {
  return {
    name: 'codeteam-manager',
    type: 'http',
    url,
    headers: [{ name: 'Accept', value: MCP_ACCEPT }]
  }
}

async function acpRequestWithTimeout<T>(
  label: string,
  request: Promise<T>,
  timeoutMs = CURSOR_ACP_RPC_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Cursor ACP ${label} timeout (${timeoutMs / 1000}s)`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function killChildTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    return
  }
  child.kill()
}

function createAcpClient(): ReturnType<typeof client> {
  const approvePermission = createCursorPermissionHandler()
  const parseParams = <T>(params: unknown): T => params as T
  return client({ name: 'codetask-cursor-light' })
    .onRequest(methods.client.session.requestPermission, async (ctx) =>
      approvePermission({ params: { options: ctx.params.options } })
    )
    .onRequest(
      'cursor/ask_question',
      parseParams<Parameters<typeof autoAnswerCursorAskQuestion>[0]>,
      async ({ params }) => ({ answers: autoAnswerCursorAskQuestion(params) })
    )
    .onRequest('cursor/create_plan', parseParams<Record<string, unknown>>, async () => ({
      accepted: true
    }))
}

async function bootstrapCursorAcp(ctx: ClientContext): Promise<void> {
  await acpRequestWithTimeout(
    'initialize',
    ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true }
      },
      clientInfo: { name: 'codetask-cursor-light', version: '1.0.0' }
    })
  )
  await acpRequestWithTimeout(
    'authenticate',
    ctx.request(methods.agent.authenticate, { methodId: 'cursor_login' }),
    CURSOR_ACP_AUTH_TIMEOUT_MS
  )
}

async function openSession(
  ctx: ClientContext,
  cwd: string,
  mcpServers: McpServer[]
): Promise<ActiveSession> {
  return acpRequestWithTimeout('session.new', ctx.buildSession({ cwd, mcpServers }).start())
}

async function runCursorAcpTurn(input: {
  cwd: string
  env: Record<string, string>
  prompt: string
  mcpUrl?: string
}): Promise<{ reply: string; sessionId: string | null; elapsedMs: number }> {
  const command = resolveCursorAgentCommand()
  const executable = resolveCursorAgentExecutable(command, input.env)
  const authIssue = probeCursorAgentAuth(executable, input.env)
  if (authIssue) throw new Error(authIssue)

  const cliArgs = buildCursorAcpCliArgs({ outerSandbox: true, cwd: input.cwd })
  log('acp', 'spawn', { executable, cliArgs })

  const mcpServers = input.mcpUrl ? [buildHttpMcp(input.mcpUrl)] : []
  const child = spawnCursorAgent(command, cliArgs, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  if (!child.stdin || !child.stdout) {
    throw new Error('Cursor ACP stdio unavailable')
  }

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(writable, readable)
  const app = createAcpClient()
  const started = Date.now()
  let outcome: { reply: string; sessionId: string | null; elapsedMs: number } | undefined

  try {
    await app.connectWith(stream, async (ctx) => {
      await bootstrapCursorAcp(ctx)
      const session = await openSession(ctx, input.cwd, mcpServers)

      let reply = ''
      const promptPromise = session.prompt(input.prompt)

      for (;;) {
        if (Date.now() - started > CURSOR_TURN_TIMEOUT_MS) {
          throw new Error(`turn timeout (${CURSOR_TURN_TIMEOUT_MS / 1000}s)`)
        }

        const message = await session.nextUpdate()
        if (message.kind === 'session_update') {
          const update = message.update
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text
          ) {
            reply += update.content.text
            process.stdout.write('.')
          }
          continue
        }

        if (message.kind === 'stop') {
          const stopReason = message.stopReason as StopReason
          if (stopReason === 'cancelled') throw new Error('cancelled')
          break
        }
      }

      await promptPromise
      console.log('')
      outcome = {
        reply: reply.trim(),
        sessionId: session.sessionId,
        elapsedMs: Date.now() - started
      }
      session.dispose()
    })

    if (!outcome) throw new Error('ACP turn produced no result')
    return outcome
  } catch (error) {
    throw new Error(
      classifyCursorAcpError(error, {
        phase: 'turn',
        command: executable
      })
    )
  } finally {
    killChildTree(child)
  }
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
      else if (/\.json$/i.test(entry.name)) found.push(full.slice(runtimeRoot.length + 1))
    }
  }
  walk(runtimeRoot, 0)
  return found
}

async function runStatic(
  runtimeRoot: string,
  workspace: string
): Promise<{
  mode: string
  authMaterialPresent: boolean
  warnings: string[]
  writeRoots: string[]
  env: {
    HOME: string | undefined
    CURSOR_CONFIG_DIR: string | undefined
    CURSOR_DATA_DIR: string | undefined
  }
  cliArgs: string[]
  executable: string
  authIssue: string | null
  runtimeIsolated: boolean
}> {
  const prepared = prepareProviderAuth('cursorcli', runtimeRoot, { workspaceRoot: workspace })
  const cliArgs = buildCursorAcpCliArgs({ outerSandbox: true, cwd: workspace })
  const env = buildMergedEnv(prepared.envPatch)
  const command = resolveCursorAgentCommand()
  const executable = resolveCursorAgentExecutable(command, env)
  const authIssue = probeCursorAgentAuth(executable, env)

  const report = {
    mode: prepared.diagnostics.mode,
    authMaterialPresent: prepared.diagnostics.authMaterialPresent,
    warnings: prepared.diagnostics.warnings,
    writeRoots: prepared.writeRoots ?? [],
    env: {
      HOME: prepared.envPatch.HOME,
      CURSOR_CONFIG_DIR: prepared.envPatch.CURSOR_CONFIG_DIR,
      CURSOR_DATA_DIR: prepared.envPatch.CURSOR_DATA_DIR
    },
    cliArgs,
    executable,
    authIssue,
    runtimeIsolated:
      prepared.diagnostics.mode === 'host-identity' &&
      prepared.envPatch.HOME !== runtimeRoot &&
      prepared.envPatch.CURSOR_DATA_DIR === join(runtimeRoot, '.cursor') &&
      (prepared.writeRoots ?? []).length > 0
  }

  log('static', 'report', report)

  if (!report.runtimeIsolated) throw new Error('host-identity sandbox wiring check failed')
  if (authIssue === CURSOR_CLI_MISSING_MESSAGE) throw new Error(authIssue)

  return report
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'codetask-cursor-light-'))
  const runtimeRoot = join(base, 'runtime')
  const workspace = workspaceArg ?? join(base, 'workspace')
  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# cursor light probe\n', 'utf8')

  const hostApprovalsBefore = findHostMcpApprovals()
  const report: Record<string, unknown> = {
    platform: process.platform,
    workspace,
    runtimeRoot,
    caseFilter,
    skipLive,
    static: null,
    hello: null,
    mcp: null,
    runtimeJson: null,
    hostMcpApprovalsBefore: hostApprovalsBefore,
    hostMcpApprovalsAfter: null,
    failures: [] as string[]
  }

  const prepared = prepareProviderAuth('cursorcli', runtimeRoot, { workspaceRoot: workspace })

  try {
    if (caseFilter === 'all' || caseFilter === 'static') {
      report.static = await runStatic(runtimeRoot, workspace)
    }

    const shouldLive =
      !skipLive && (caseFilter === 'all' || caseFilter === 'hello' || caseFilter === 'mcp')

    if (shouldLive) {
      const env = buildMergedEnv(prepared.envPatch)
      const authIssue = probeCursorAgentAuth(
        resolveCursorAgentExecutable(resolveCursorAgentCommand(), env),
        env
      )

      if (authIssue) {
        ;(report.failures as string[]).push(`auth: ${authIssue}`)
        log('live', `skipped — ${authIssue}`)
      } else {
        if (caseFilter === 'all' || caseFilter === 'hello') {
          try {
            const result = await withRuntimeEnv(prepared.envPatch, async () =>
              runCursorAcpTurn({
                cwd: workspace,
                env: buildMergedEnv(prepared.envPatch),
                prompt: 'Reply with exactly: pong'
              })
            )
            report.hello = result
            log('hello', 'done', result)
            const pongOk = Boolean(result?.reply?.toLowerCase().includes('pong'))
            const sessionOk = Boolean(result?.sessionId)
            if (!pongOk && !sessionOk) {
              ;(report.failures as string[]).push(
                `hello: no session and no pong; reply=${result?.reply?.slice(0, 120) ?? '(empty)'}`
              )
            } else if (!pongOk) {
              log(
                'hello',
                'warn: session ok but reply not pong',
                result?.reply?.slice(0, 120) ?? '(empty)'
              )
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            report.hello = { failed: true, message }
            ;(report.failures as string[]).push(`hello: ${message}`)
          }
        }

        if (caseFilter === 'all' || caseFilter === 'mcp') {
          const fake = await startFakeMcp()
          log('mcp', `fake server at ${fake.url}`)
          try {
            const result = await withRuntimeEnv(prepared.envPatch, async () =>
              runCursorAcpTurn({
                cwd: workspace,
                env: buildMergedEnv(prepared.envPatch),
                mcpUrl: fake.url,
                prompt:
                  'You must call codeteam-manager report_task_result now with status "completed". Then reply exactly: mcp-ok'
              })
            )
            const toolCalls = fake.calls.filter((c) => c.rpcMethod === 'tools/call')
            report.mcp = { ...result, fakeMcpCalls: fake.calls.length, toolCalls: toolCalls.length }
            log('mcp', 'done', report.mcp)
            if (toolCalls.length === 0) {
              ;(report.failures as string[]).push('mcp: Cursor did not call fake MCP')
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
    }

    report.runtimeJson = listRuntimeJson(runtimeRoot)
    report.hostMcpApprovalsAfter = findHostMcpApprovals()
    const newHostApprovals = (report.hostMcpApprovalsAfter as string[]).filter(
      (p) => !hostApprovalsBefore.includes(p)
    )
    if (newHostApprovals.length > 0) {
      ;(report.failures as string[]).push(
        `host mcp-approvals appeared: ${newHostApprovals.join(', ')}`
      )
    }

    const reportPath = join(base, 'cursor-light-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

    console.log('\n========== CURSOR LIGHT TEST ==========')
    if (report.static) console.log('static: OK')
    if (report.hello) console.log('hello:', report.hello)
    if (report.mcp) console.log('mcp:', report.mcp)
    if ((report.failures as string[]).length) {
      console.log('\nFailures:')
      for (const f of report.failures as string[]) console.log(`  - ${f}`)
    }
    console.log(`\nReport: ${reportPath}`)
    console.log(`Runtime JSON: ${(report.runtimeJson as string[]).join(', ') || '(none)'}`)

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
  console.error('[cursor-light] fatal:', error)
  process.exit(1)
})
