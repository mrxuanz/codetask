import { spawnSync, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSessionMessage,
  type ClientApp,
  type ClientContext,
  type InitializeResponse,
  type McpServer,
  type PromptResponse,
  type SessionNotification,
  type Stream
} from '@agentclientprotocol/sdk'
import { resolveCursorAcpModelId } from '../../conversation/models'
import type { CursorAcpMcpServer } from '../mcp'
import { autoAnswerCursorAskQuestion, type CursorAskQuestionRequest } from './extensions'
import { sandboxTurnDebug } from '../../debug/sandbox-turn'
import { resolveCursorAgentBin } from './config'
import { spawnCursorAgent, spawnCursorAgentInvocation } from './command'
import { createCursorPermissionHandler } from './permissions'
import type { AgentCapabilityProfile } from '../capabilities'
import { classifyCursorAcpError } from './errors'
import { createTurnError } from '../../../shared/turn-errors.ts'

export const CURSOR_ACP_RPC_TIMEOUT_MS = 60_000
export const CURSOR_ACP_AUTH_TIMEOUT_MS = 120_000
export const CURSOR_SPAWN_GRACE_MS = 750
export const CURSOR_ACP_UPDATE_IDLE_TIMEOUT_MS = 120_000

export function debugCursor(step: string, detail?: unknown): void {
  sandboxTurnDebug(`cursor-acp: ${step}`, detail)
}

export async function acpRequestWithTimeout<T>(
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
          () =>
            reject(
              createTurnError('provider.cursor.acp_keepalive_timeout', {
                detail: `Cursor ACP ${label} timed out after ${timeoutMs / 1000}s`
              })
            ),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface ChildDiagnostics {
  getStderrTail(): string
  getEarlyExit(): { code: number | null; signal: NodeJS.Signals | null } | null
  waitForSpawnFailure(): Promise<Error | null>
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
}

export function createChildDiagnostics(child: ChildProcess): ChildDiagnostics {
  let stderrTail = ''
  let spawnError: Error | null = null
  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (!text) return
    stderrTail = `${stderrTail}\n${text}`.slice(-2000)
    debugCursor('stderr', { text: text.slice(0, 400) })
  })

  child.on('error', (error) => {
    spawnError = error
    debugCursor('child error', { message: error.message })
  })

  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      earlyExit = { code, signal }
      debugCursor('child exit', { code, signal, stderrTail: stderrTail.slice(-400) })
    }
    for (const listener of exitListeners) listener(code, signal)
  })

  return {
    getStderrTail: () => stderrTail.trim(),
    getEarlyExit: () => earlyExit,
    onExit: (listener) => {
      exitListeners.push(listener)
      return () => {
        const index = exitListeners.indexOf(listener)
        if (index >= 0) exitListeners.splice(index, 1)
      }
    },
    waitForSpawnFailure: () =>
      new Promise((resolve) => {
        if (spawnError) {
          resolve(spawnError)
          return
        }
        const onError = (error: Error): void => {
          clearTimeout(timer)
          resolve(error)
        }
        const timer = setTimeout(() => {
          child.off('error', onError)
          resolve(null)
        }, CURSOR_SPAWN_GRACE_MS)
        child.once('error', onError)
      })
  }
}

export function killChildTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    if (!result.error && result.status === 0) return
  }
  child.kill()
}

export function waitForChildExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (!child.pid || child.killed || child.exitCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve()
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

interface CursorSessionQueueEntry {
  readonly kind: 'value' | 'error'
  readonly value: ActiveSessionMessage | unknown
}

class CursorSessionQueue {
  private readonly values: CursorSessionQueueEntry[] = []
  private readonly waiters: Array<{
    resolve: (value: ActiveSessionMessage) => void
    reject: (error: unknown) => void
  }> = []
  private disposed = false

  enqueue(value: ActiveSessionMessage): void {
    if (this.disposed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve(value)
      return
    }
    this.values.push({ kind: 'value', value })
  }

  reject(error: unknown): void {
    if (this.disposed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.reject(error)
      return
    }
    this.values.push({ kind: 'error', value: error })
  }

  clearErrors(): void {
    for (let index = this.values.length - 1; index >= 0; index -= 1) {
      if (this.values[index]?.kind === 'error') this.values.splice(index, 1)
    }
  }

  next(): Promise<ActiveSessionMessage> {
    const entry = this.values.shift()
    if (entry?.kind === 'error') return Promise.reject(entry.value)
    if (entry?.kind === 'value') return Promise.resolve(entry.value as ActiveSessionMessage)
    if (this.disposed) {
      return Promise.reject(new Error('Cursor ACP session update routing was disposed'))
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const error = new Error('Cursor ACP session update routing was disposed')
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    this.values.length = 0
  }
}

export interface CursorAcpSessionHandle {
  readonly sessionId: string
  prompt(prompt: string): Promise<PromptResponse>
  nextUpdate(): Promise<ActiveSessionMessage>
  dispose(): void
}

class RoutedCursorAcpSession implements CursorAcpSessionHandle {
  private readonly queue = new CursorSessionQueue()
  private disposed = false

  constructor(
    private readonly ctx: ClientContext,
    readonly sessionId: string,
    private readonly unregister: () => void
  ) {}

  accept(notification: SessionNotification): void {
    this.queue.enqueue({
      kind: 'session_update',
      notification,
      update: notification.update
    })
  }

  prompt(prompt: string): Promise<PromptResponse> {
    this.queue.clearErrors()
    const request = this.ctx.request(methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: prompt }]
    })
    void request.then(
      (response) => {
        this.queue.enqueue({
          kind: 'stop',
          response,
          stopReason: response.stopReason
        })
      },
      (error) => this.queue.reject(error)
    )
    return request
  }

  nextUpdate(): Promise<ActiveSessionMessage> {
    return this.queue.next()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unregister()
    this.queue.dispose()
  }
}

export class CursorAcpSessionRouter {
  private readonly sessions = new Map<string, RoutedCursorAcpSession>()

  route(notification: SessionNotification): void {
    this.sessions.get(notification.sessionId)?.accept(notification)
  }

  attach(ctx: ClientContext, sessionId: string): CursorAcpSessionHandle {
    this.sessions.get(sessionId)?.dispose()
    const session = new RoutedCursorAcpSession(ctx, sessionId, () => {
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
    })
    this.sessions.set(sessionId, session)
    return session
  }
}

export function spawnCursorAcpProcess(
  cwd: string,
  env: Record<string, string>,
  cliArgs: readonly string[],
  launch?: {
    executable?: string | undefined
    prefixArgs?: readonly string[] | undefined
    /** Agent binary path for PATH enrichment (may differ from argv0 for `.ps1`). */
    resolvedPath?: string | undefined
  }
): ChildProcess {
  // Turn-plan already embeds optional `-e` endpoint in cliArgs — do not re-append here.
  if (launch?.executable?.trim()) {
    return spawnCursorAgentInvocation(
      {
        executable: launch.executable,
        prefixArgs: launch.prefixArgs,
        pathForEnv: launch.resolvedPath
      },
      cliArgs,
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
  }
  return spawnCursorAgent(resolveCursorAgentBin(), [...cliArgs], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

export function createChildAcpStream(child: ChildProcess): Stream {
  if (!child.stdin || !child.stdout) {
    throw createTurnError('provider.cursor.acp_stdio_unavailable')
  }
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  return ndJsonStream(writable, readable)
}

function parseExtensionParams<Params>(params: unknown): Params {
  return params as Params
}

export function createCodetaskAcpClient(
  isAborted: () => boolean,
  capabilityProfile: AgentCapabilityProfile,
  onSessionUpdate?: (notification: SessionNotification) => void
): ClientApp {
  const approvePermission = createCursorPermissionHandler(capabilityProfile)
  return client({ name: 'codetask' })
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      if (isAborted()) {
        return { outcome: { outcome: 'cancelled' as const } }
      }
      debugCursor('requestPermission', {
        toolCall: ctx.params.toolCall?.title ?? ctx.params.toolCall?.kind
      })
      return approvePermission({
        params: {
          options: ctx.params.options,
          toolCall: {
            ...(ctx.params.toolCall?.title != null ? { title: ctx.params.toolCall.title } : {}),
            ...(ctx.params.toolCall?.kind != null ? { kind: ctx.params.toolCall.kind } : {})
          }
        }
      })
    })
    .onRequest(
      'cursor/ask_question',
      parseExtensionParams<CursorAskQuestionRequest>,
      async ({ params }) => {
        if (isAborted()) {
          return { answers: {} }
        }
        debugCursor('extension request', { method: 'cursor/ask_question' })
        return { answers: autoAnswerCursorAskQuestion(params) }
      }
    )
    .onRequest('cursor/create_plan', parseExtensionParams<Record<string, unknown>>, async () => {
      debugCursor('extension request', { method: 'cursor/create_plan' })
      return { accepted: true }
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      onSessionUpdate?.(params)
    })
}

export async function bootstrapCursorAcp(ctx: ClientContext): Promise<InitializeResponse> {
  debugCursor('initialize start')
  const initialized = await acpRequestWithTimeout(
    'initialize',
    ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true }
      },
      clientInfo: { name: 'codetask', version: '1.0.0' }
    })
  )
  debugCursor('initialize done')

  debugCursor('authenticate start')
  await acpRequestWithTimeout(
    'authenticate',
    ctx.request(methods.agent.authenticate, { methodId: 'cursor_login' }),
    CURSOR_ACP_AUTH_TIMEOUT_MS
  )
  debugCursor('authenticate done')
  return initialized
}

export function toAcpMcpServers(servers: CursorAcpMcpServer[]): McpServer[] {
  const result: McpServer[] = []
  for (const server of servers) {
    if (server.type === 'stdio') {
      result.push({
        name: server.name,
        command: server.command ?? '',
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
      })
      continue
    }
    result.push({
      name: server.name,
      type: 'http',
      url: server.url ?? '',
      headers: server.headers ?? []
    })
  }
  return result
}

export async function openCursorAcpSession(
  ctx: ClientContext,
  initialized: InitializeResponse,
  router: CursorAcpSessionRouter,
  cwd: string,
  runtimeSessionId: string | null | undefined,
  mcpServers: CursorAcpMcpServer[]
): Promise<CursorAcpSessionHandle> {
  const acpMcpServers = toAcpMcpServers(mcpServers)
  if (runtimeSessionId && initialized.agentCapabilities?.loadSession) {
    try {
      await acpRequestWithTimeout(
        'session.load',
        ctx.request(methods.agent.session.load, {
          sessionId: runtimeSessionId,
          cwd,
          additionalDirectories: [],
          mcpServers: acpMcpServers
        })
      )
    } catch (error) {
      throw createTurnError('provider.cursor.acp_failed', {
        detail: `Cursor ACP refused to load session ${runtimeSessionId} in ${cwd}: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
    }
    debugCursor('session/load ok', { sessionId: runtimeSessionId, cwd })
    return router.attach(ctx, runtimeSessionId)
  }

  debugCursor('session/new', { cwd, mcpServers: mcpServers.map((s) => s.name) })
  const created = await acpRequestWithTimeout(
    'session.new',
    ctx.request(methods.agent.session.new, {
      cwd,
      additionalDirectories: [],
      mcpServers: acpMcpServers
    })
  )
  return router.attach(ctx, created.sessionId)
}

export async function applyCursorModel(
  ctx: ClientContext,
  session: Pick<CursorAcpSessionHandle, 'sessionId'>,
  model?: string
): Promise<void> {
  const modelId = resolveCursorAcpModelId(model)
  if (!modelId) {
    debugCursor('model skipped (use cursor cli default)')
    return
  }

  debugCursor('set model', { modelId })
  await Promise.race([
    ctx.request(methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: 'model',
      value: modelId
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('setConfigOption timeout')), 5_000)
    })
  ]).catch((error) => {
    debugCursor('set model skipped', {
      message: error instanceof Error ? error.message : String(error)
    })
  })
}

export async function cancelCursorAcpSession(ctx: ClientContext, sessionId: string): Promise<void> {
  try {
    await ctx.notify(methods.agent.session.cancel, { sessionId })
  } catch (error) {
    debugCursor('session cancel notify failed', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

export function formatAcpError(
  error: unknown,
  context: {
    phase?: string
    stderr?: string
    command?: string
    exitCode?: number | null
  } = {}
): string {
  return classifyCursorAcpError(error, context).message
}
