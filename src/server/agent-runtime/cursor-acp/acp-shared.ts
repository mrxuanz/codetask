import { spawnSync, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ClientApp,
  type ClientContext,
  type McpServer,
  type NewSessionResponse,
  type Stream
} from '@agentclientprotocol/sdk'
import { resolveCursorAcpModelId } from '../../conversation/models'
import type { CursorAcpMcpServer } from '../mcp'
import { autoAnswerCursorAskQuestion, type CursorAskQuestionRequest } from './extensions'
import { sandboxTurnDebug } from '../../debug/sandbox-turn'
import { resolveCursorAgentBin, appendCursorApiEndpointArgs } from './config'
import { spawnCursorAgent } from './command'
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

export function attachAcpSession(ctx: ClientContext, response: NewSessionResponse): ActiveSession {
  const attachSession = Reflect.get(ctx, 'attachSession')
  if (typeof attachSession !== 'function') {
    throw createTurnError('provider.cursor.acp_failed', {
      detail: 'Cursor ACP client does not support attaching an existing session'
    })
  }
  return Reflect.apply(attachSession, ctx, [response])
}

export function spawnCursorAcpProcess(
  cwd: string,
  env: Record<string, string>,
  cliArgs: string[]
): ChildProcess {
  const command = resolveCursorAgentBin()
  const args = appendCursorApiEndpointArgs(cliArgs)
  return spawnCursorAgent(command, args, {
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
  capabilityProfile: AgentCapabilityProfile
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
            title: ctx.params.toolCall?.title ?? undefined,
            kind: ctx.params.toolCall?.kind ?? undefined
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
}

export async function bootstrapCursorAcp(ctx: ClientContext): Promise<void> {
  debugCursor('initialize start')
  await acpRequestWithTimeout(
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
  cwd: string,
  runtimeSessionId: string | null | undefined,
  mcpServers: CursorAcpMcpServer[]
): Promise<ActiveSession> {
  const acpMcpServers = toAcpMcpServers(mcpServers)
  if (runtimeSessionId) {
    try {
      const loaded = await acpRequestWithTimeout(
        'session.load',
        ctx.request(methods.agent.session.load, {
          sessionId: runtimeSessionId,
          cwd,
          mcpServers: acpMcpServers
        })
      )
      if (loaded && typeof loaded === 'object' && 'sessionId' in loaded) {
        debugCursor('session/load ok', { sessionId: runtimeSessionId })
        return attachAcpSession(ctx, loaded as NewSessionResponse)
      }
    } catch (error) {
      debugCursor('session/load failed, fallback session/new', {
        sessionId: runtimeSessionId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  debugCursor('session/new', { mcpServers: mcpServers.map((s) => s.name) })
  return acpRequestWithTimeout(
    'session.new',
    ctx.buildSession({ cwd, mcpServers: acpMcpServers }).start()
  )
}

export async function applyCursorModel(
  ctx: ClientContext,
  session: ActiveSession,
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
