import type { ChildProcess } from 'node:child_process'
import { RequestError, type ActiveSession, type ClientContext } from '@agentclientprotocol/sdk'
import type { ConversationRole } from '../roles'
import type { CursorAcpMcpServer } from '../mcp'
import type { AgentTurnChunk } from '../types'
import { createTurnError } from '../../../shared/turn-errors.ts'
import type { TurnErrorCode } from '../../../shared/turn-errors/codes.ts'
import { classifyCursorAcpError } from './errors'
import { abortReason, createProviderTurnScope } from '../provider-turn'
import { createAsyncQueue } from './async-queue'
import {
  applyCursorModel,
  bootstrapCursorAcp,
  cancelCursorAcpSession,
  createChildAcpStream,
  createChildDiagnostics,
  createCodetaskAcpClient,
  debugCursor,
  formatAcpError,
  killChildTree,
  waitForChildExit,
  openCursorAcpSession,
  spawnCursorAcpProcess,
  type ChildDiagnostics
} from './acp-shared'
import { appendTextPiece, MAX_TURN_TEXT_CHARS } from '../delta-emit'
import { assertTaskWorkerAcpCompletion } from './turn-guards'
import { recordAcpToolCallActivity } from '../turn-scope'

export interface CursorPromptInput {
  role: ConversationRole
  cwd: string
  prompt: string
  systemPrompt?: string | undefined
  model?: string | undefined
  mcpServers: CursorAcpMcpServer[]
  runtimeSessionId?: string | null | undefined
  signal?: AbortSignal | undefined
}

export interface CursorAcpSessionRuntimeOptions {
  cwd: string
  env: Record<string, string>
  cliArgs: string[]
}

export class CursorAcpSessionRuntime {
  readonly sessionId: string | null = null

  private child: ChildProcess | null = null
  private diagnostics: ChildDiagnostics | null = null
  private ctx: ClientContext | null = null
  private closed = false
  private starting: Promise<void> | null = null
  private activeTaskSession: ActiveSession | null = null
  private loadedSessionKey: string | null = null
  private promptInFlight = false
  private executable = ''
  private connectionDone: Promise<void> | null = null
  private releaseConnection: (() => void) | null = null

  constructor(private readonly options: CursorAcpSessionRuntimeOptions) {}

  isClosed(): boolean {
    return this.closed
  }

  isPromptInFlight(): boolean {
    return this.promptInFlight
  }

  async ensureReady(): Promise<void> {
    if (this.closed) {
      throw createTurnError('provider.cursor.acp_failed', { detail: 'Cursor ACP runtime closed' })
    }
    if (this.ctx && this.child) return
    if (this.starting) {
      await this.starting
      return
    }
    this.starting = this.startAgent()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startAgent(): Promise<void> {
    debugCursor('runtime spawn', {
      cwd: this.options.cwd,
      cliArgs: this.options.cliArgs
    })

    const child = spawnCursorAcpProcess(this.options.cwd, this.options.env, this.options.cliArgs)
    const diagnostics = createChildDiagnostics(child)
    this.child = child
    this.diagnostics = diagnostics
    this.executable = child.spawnfile || 'agent'

    const spawnFailure = await diagnostics.waitForSpawnFailure()
    if (spawnFailure) {
      throw spawnFailure
    }

    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })

    let releaseConnection!: () => void
    const connectionDone = new Promise<void>((resolve) => {
      releaseConnection = resolve
    })
    this.connectionDone = connectionDone
    this.releaseConnection = releaseConnection

    const app = createCodetaskAcpClient(() => this.closed)
    void app
      .connectWith(createChildAcpStream(child), async (ctx) => {
        this.ctx = ctx
        debugCursor('runtime connected')
        try {
          await bootstrapCursorAcp(ctx)
          debugCursor('runtime authenticated')
          readyResolve()
          await connectionDone
        } catch (error) {
          const classified = classifyCursorAcpError(error, {
            phase: 'authenticate',
            stderr: diagnostics.getStderrTail(),
            command: this.executable
          })
          const formatted = createTurnError(classified.code, {
            params: classified.params,
            detail: classified.detail ?? undefined
          })
          readyReject(formatted)
          throw formatted
        }
      })
      .catch((error) => {
        const formatted =
          error instanceof Error
            ? error
            : createTurnError('provider.cursor.acp_failed', {
                detail: formatAcpError(error, { stderr: diagnostics.getStderrTail() })
              })
        readyReject(formatted)
      })

    await ready
  }

  private buildSessionKey(input: CursorPromptInput): string {
    const mcpSignature = input.mcpServers
      .map((server) => `${server.name}:${server.type}:${server.url ?? server.command ?? ''}`)
      .join('|')
    return `${input.cwd}\0${input.runtimeSessionId ?? ''}\0${mcpSignature}`
  }

  private async openTaskSession(input: CursorPromptInput): Promise<ActiveSession> {
    const ctx = this.ctx
    if (!ctx) {
      throw createTurnError('provider.cursor.acp_failed', {
        detail: 'Cursor ACP runtime not connected'
      })
    }

    const sessionKey = this.buildSessionKey(input)
    const mcpChanged = this.loadedSessionKey !== null && this.loadedSessionKey !== sessionKey
    const cwdSame =
      this.loadedSessionKey !== null &&
      this.loadedSessionKey.split('\0')[0] === sessionKey.split('\0')[0]
    const sessionIdChanged =
      this.loadedSessionKey !== null &&
      this.loadedSessionKey.split('\0')[1] !== sessionKey.split('\0')[1]
    const canReloadSameConnection =
      Boolean(input.runtimeSessionId) &&
      this.activeTaskSession &&
      cwdSame &&
      this.loadedSessionKey !== sessionKey &&
      (mcpChanged || sessionIdChanged)

    if (this.activeTaskSession && this.loadedSessionKey === sessionKey) {
      debugCursor('runtime task session reused', { sessionId: this.activeTaskSession.sessionId })
      return this.activeTaskSession
    }

    if (canReloadSameConnection && this.activeTaskSession) {
      try {
        this.activeTaskSession.dispose()
      } catch {
        // best-effort, ignore errors
      }
      this.activeTaskSession = null
      const session = await openCursorAcpSession(
        ctx,
        input.cwd,
        input.runtimeSessionId,
        input.mcpServers
      )
      this.activeTaskSession = session
      this.loadedSessionKey = sessionKey
      debugCursor('runtime task session reloaded', {
        sessionId: session.sessionId,
        reason: sessionIdChanged ? 'session_id' : 'mcp'
      })
      return session
    }

    if (this.activeTaskSession) {
      try {
        this.activeTaskSession.dispose()
      } catch {
        // best-effort, ignore errors
      }
      this.activeTaskSession = null
      this.loadedSessionKey = null
    }

    const session = await openCursorAcpSession(
      ctx,
      input.cwd,
      input.runtimeSessionId,
      input.mcpServers
    )
    this.activeTaskSession = session
    this.loadedSessionKey = sessionKey
    debugCursor('runtime task session ready', { sessionId: session.sessionId })
    return session
  }

  async *prompt(input: CursorPromptInput): AsyncGenerator<AgentTurnChunk> {
    if (this.closed) {
      throw createTurnError('provider.cursor.acp_failed', {
        detail: 'Cursor ACP runtime is closed'
      })
    }
    if (this.promptInFlight) {
      throw createTurnError('provider.cursor.acp_failed', {
        detail: 'Cursor ACP prompt already in flight'
      })
    }
    this.promptInFlight = true

    const queue = createAsyncQueue<AgentTurnChunk>({
      softMax: 2048,
      hardMax: 8192,
      onHighWater: () => {
        debugCursor('async queue high water', { softMax: 2048, hardMax: 8192 })
      }
    })
    const run = this.runPrompt(input, (chunk) => queue.push(chunk))
      .then(() => queue.close())
      .catch((error) => {
        const dto =
          error instanceof Error && 'code' in error
            ? (
                error as unknown as {
                  code: string
                  message: string
                  params?: Record<string, unknown>
                  detail?: string
                }
              ).code
              ? {
                  code: (error as unknown as { code: string }).code,
                  message: error.message,
                  params: (error as unknown as { params?: Record<string, unknown> }).params,
                  detail: (error as unknown as { detail?: string }).detail ?? null
                }
              : null
            : null
        const message = error instanceof Error ? error.message : formatAcpError(error)
        queue.push({ type: 'error', message })
        queue.close()
        if (dto) {
          throw createTurnError(dto.code as TurnErrorCode, {
            params: dto.params as Record<string, string | number | boolean> | undefined,
            detail: dto.detail ?? undefined
          })
        }
        throw createTurnError('provider.cursor.acp_failed', { detail: message })
      })
      .finally(() => {
        this.promptInFlight = false
      })

    try {
      for await (const chunk of queue.iterate()) {
        if (chunk.type === 'error') {
          throw new Error(chunk.message)
        }
        yield chunk
      }
    } finally {
      await run.catch(() => {})
    }
  }

  private async runPrompt(
    input: CursorPromptInput,
    emit: (chunk: AgentTurnChunk) => void
  ): Promise<void> {
    await this.ensureReady()
    const ctx = this.ctx
    const diagnostics = this.diagnostics
    const child = this.child
    if (!ctx || !diagnostics || !child) {
      throw createTurnError('provider.cursor.acp_failed', {
        detail: 'Cursor ACP runtime not ready'
      })
    }

    let aborted = false
    const onAbort = (): void => {
      aborted = true
      if (this.activeTaskSession) {
        void cancelCursorAcpSession(ctx, this.activeTaskSession.sessionId)
      }
    }

    let detachExitListener: (() => void) | undefined
    const exitPromise = new Promise<never>((_, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        const dto = classifyCursorAcpError(
          new Error(`Cursor Agent process exited mid-turn${signal ? ` (signal=${signal})` : ''}`),
          {
            exitCode: code,
            stderr: diagnostics.getStderrTail(),
            command: this.executable
          }
        )
        reject(createTurnError(dto.code, { params: dto.params, detail: dto.detail ?? undefined }))
      }
      detachExitListener = diagnostics.onExit(onExit)
      child.once('exit', onExit)
    })

    const turnScope = createProviderTurnScope(
      input.role,
      { signal: input.signal },
      {
        processExit: exitPromise
      }
    )
    turnScope.arm()

    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) {
      onAbort()
      throw abortReason(input.signal)
    }

    const session = await this.openTaskSession(input)
    const userPrompt = input.systemPrompt
      ? `${input.systemPrompt}\n\n---\n\n${input.prompt}`
      : input.prompt

    await applyCursorModel(ctx, session, input.model)

    let reply = ''
    let thinking = ''
    let promptSettled = false
    let promptSettledError: unknown | null = null
    const openToolIds = new Set<string>()

    debugCursor('runtime prompt sending', { promptChars: userPrompt.length })
    const promptPromise = session.prompt(userPrompt).then(
      (result) => {
        promptSettled = true
        return result
      },
      (error) => {
        promptSettled = true
        promptSettledError = error
        throw error
      }
    )

    const pumpUpdates = async (): Promise<void> => {
      while (!promptSettled && !aborted) {
        const message = await turnScope.race(session.nextUpdate())

        if (message.kind === 'session_update') {
          turnScope.recordProgress('provider_event')
          const update = message.update
          if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            recordAcpToolCallActivity(update, turnScope, openToolIds)
            continue
          }
          if (
            update.sessionUpdate === 'agent_thought_chunk' &&
            update.content.type === 'text' &&
            update.content.text
          ) {
            const advanced = appendTextPiece(thinking, update.content.text, {
              maxChars: MAX_TURN_TEXT_CHARS
            })
            thinking = advanced.text
            turnScope.recordProgress('thinking_delta')
            if (advanced.delta) emit({ type: 'thinking_delta', content: advanced.delta })
            continue
          }

          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text
          ) {
            const advanced = appendTextPiece(reply, update.content.text, {
              maxChars: MAX_TURN_TEXT_CHARS
            })
            reply = advanced.text
            turnScope.recordProgress('text_delta')
            if (advanced.delta) emit({ type: 'delta', content: advanced.delta })
          }
          continue
        }

        if (message.kind === 'stop') {
          turnScope.recordProgress('heartbeat')
          debugCursor('runtime stop event (ignored for completion)', {
            stopReason: message.stopReason,
            replyChars: reply.length
          })
        }
      }
    }

    try {
      await Promise.all([pumpUpdates(), promptPromise])
    } catch (error) {
      if (turnScope.graceCancelled && reply.trim()) {
        emit({
          type: 'completed',
          reply: reply.trim(),
          runtimeSessionId: session.sessionId,
          partial: true
        })
        return
      }
      if (aborted) {
        throw abortReason(input.signal)
      }
      const dto = classifyCursorAcpError(error, {
        phase: error instanceof RequestError ? 'rpc' : 'prompt',
        stderr: diagnostics.getStderrTail(),
        command: this.executable,
        exitCode: diagnostics.getEarlyExit()?.code
      })
      throw createTurnError(dto.code, { params: dto.params, detail: dto.detail ?? undefined })
    } finally {
      detachExitListener?.()
      input.signal?.removeEventListener('abort', onAbort)
      turnScope.dispose()
    }

    const completionCheck = assertTaskWorkerAcpCompletion({
      role: input.role,
      reply,
      stderrTail: diagnostics.getStderrTail(),
      promptSettledError
    })

    debugCursor('runtime prompt completed', {
      replyChars: reply.length,
      sessionId: session.sessionId
    })

    emit({
      type: 'completed',
      reply: reply.trim() || '',
      runtimeSessionId: session.sessionId,
      ...(completionCheck.partial ? { partial: true as const } : {})
    })
  }

  async cancel(): Promise<void> {
    const ctx = this.ctx
    const session = this.activeTaskSession
    if (ctx && session) {
      await cancelCursorAcpSession(ctx, session.sessionId)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.activeTaskSession) {
      try {
        this.activeTaskSession.dispose()
      } catch {
        // best-effort, ignore errors
      }
      this.activeTaskSession = null
    }
    this.loadedSessionKey = null
    this.releaseConnection?.()
    if (this.connectionDone) {
      await this.connectionDone.catch(() => {})
    }
    if (this.child) {
      const child = this.child
      this.child = null
      killChildTree(child)
      await waitForChildExit(child, 10_000)
    }
    this.ctx = null
    this.diagnostics = null
    debugCursor('runtime closed')
  }
}
