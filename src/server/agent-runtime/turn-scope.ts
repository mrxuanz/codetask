import type { ConversationRole } from './roles'
import { roleRequiresOuterSandbox } from './roles'
import { createTurnError, TURN_CANCELLED } from '../../shared/turn-errors.ts'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import type { ProgressGuard } from './progress-guard'
import type { AgentTurnChunk } from './types'
import { noFirstSignalMsForRole } from './turn-timeouts'

export type TurnActivityKind =
  | 'provider_event'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_started'
  | 'tool_updated'
  | 'tool_completed'
  | 'mcp_call'
  | 'shell_running'
  | 'heartbeat'

const KEEPALIVE_INTERVAL_MS = 60_000

export interface TurnScopeInput {
  role: ConversationRole
  externalSignal?: AbortSignal | undefined
  processExit?: Promise<never> | undefined
  noFirstSignalMs?: number | null | undefined
  progressGuard?: ProgressGuard | undefined
  onKeepAlive?: (() => void | Promise<void>) | undefined
}

export class TurnScope {
  readonly role: ConversationRole
  readonly signal: AbortSignal

  private readonly _abort = new AbortController()
  private readonly _processExit?: Promise<never> | undefined
  private readonly _onKeepAlive?: (() => void | Promise<void>) | undefined
  private readonly _progressGuard?: ProgressGuard | undefined
  private readonly _configuredNoFirstSignalMs?: number | null | undefined

  private _disposed = false
  private _armed = false
  private _keepalivePending = false
  private _sawFirstSignal = false
  private _noFirstTimer: ReturnType<typeof setTimeout> | null = null
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private _lastKeepAlive = 0
  private _noFirstSignalMs: number | null = null
  private _abortError: Error | null = null
  private _graceCancelled = false
  private _suspectedStall = false

  constructor(input: TurnScopeInput) {
    this.role = input.role
    this.signal = this._abort.signal
    this._processExit = input.processExit
    this._onKeepAlive = input.onKeepAlive
    this._progressGuard = input.progressGuard
    this._configuredNoFirstSignalMs = input.noFirstSignalMs

    if (input.externalSignal?.aborted) {
      this._abortExternal(input.externalSignal.reason)
    } else if (input.externalSignal) {
      input.externalSignal.addEventListener(
        'abort',
        () => this._abortExternal(input.externalSignal?.reason),
        { once: true }
      )
    }

    if (this._processExit) {
      this._processExit.catch(() => {})
    }
  }

  arm(): void {
    if (this._armed || this._disposed) return
    this._armed = true
    if (!this._processExit) {
      const noFirstSignalMs =
        this._configuredNoFirstSignalMs === undefined
          ? noFirstSignalMsForRole(this.role)
          : this._configuredNoFirstSignalMs
      if (noFirstSignalMs != null) {
        this._noFirstSignalMs = noFirstSignalMs
        this._scheduleNoFirstSignal()
      }
    }
    this._startKeepalive()
    this._progressGuard?.start()

    if (this._progressGuard) {
      this._progressGuard.on('stalled', () => {
        this._markSuspectedStall('stalled')
      })
    }
  }

  recordProgress(kind: TurnActivityKind): void {
    if (this._disposed || this.signal.aborted) return
    this._sawFirstSignal = true
    this._clearNoFirstSignalTimer()
    this._tryKeepAlive()
    this._progressGuard?.recordActivity(kind)
  }

  enterLongRunningTool(command?: string | null): void {
    this._progressGuard?.enterLongRunningTool(command)
  }

  exitLongRunningTool(): void {
    this._progressGuard?.exitLongRunningTool()
  }

  async race<T>(prompt: Promise<T>): Promise<T> {
    if (this._abortError) throw this._abortError
    if (this.signal.aborted) {
      throw this._abortError ?? TURN_CANCELLED
    }

    return await this._raceImpl(prompt)
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._clearNoFirstSignalTimer()
    this._stopKeepalive()
    this._progressGuard?.dispose()
  }

  get graceCancelled(): boolean {
    return this._graceCancelled
  }

  get suspectedStall(): boolean {
    return this._suspectedStall
  }

  private _raceImpl<T>(prompt: Promise<T>): Promise<T> {
    if (this._processExit) {
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = (): void => {
          reject(this._abortError ?? TURN_CANCELLED)
        }
        if (this.signal.aborted) {
          onAbort()
          return
        }
        this.signal.addEventListener('abort', onAbort, { once: true })
      })

      return Promise.race([prompt, this._processExit, abortPromise])
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup()
        reject(this._abortError ?? TURN_CANCELLED)
      }
      const cleanup = (): void => {
        this.signal.removeEventListener('abort', onAbort)
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
      prompt.then(
        (value) => {
          cleanup()
          if (this.signal.aborted) {
            reject(this._abortError ?? TURN_CANCELLED)
            return
          }
          resolve(value)
        },
        (error) => {
          cleanup()
          reject(error)
        }
      )
    })
  }

  private _tryKeepAlive(): void {
    if (!this._onKeepAlive || this._keepalivePending) return
    const now = Date.now()
    if (now - this._lastKeepAlive < KEEPALIVE_INTERVAL_MS) return
    this._lastKeepAlive = now
    this._runKeepAlive()
  }

  private _runKeepAlive(): void {
    if (!this._onKeepAlive || this._keepalivePending || this._disposed || this.signal.aborted)
      return
    this._keepalivePending = true
    try {
      void Promise.resolve(this._onKeepAlive()).then(
        () => {
          this._keepalivePending = false
        },
        (error) => {
          this._keepalivePending = false
          this._abortInternal(error)
        }
      )
    } catch (error) {
      this._keepalivePending = false
      this._abortInternal(error)
    }
  }

  private _startKeepalive(): void {
    if (!this._onKeepAlive) return
    this._keepaliveTimer = setInterval(() => {
      if (this._disposed || this.signal.aborted) {
        this._stopKeepalive()
        return
      }
      const now = Date.now()
      if (now - this._lastKeepAlive >= KEEPALIVE_INTERVAL_MS) {
        this._lastKeepAlive = now
        this._runKeepAlive()
      }
    }, KEEPALIVE_INTERVAL_MS)
    this._keepaliveTimer?.unref?.()
  }

  private _stopKeepalive(): void {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer)
      this._keepaliveTimer = null
    }
  }

  private _scheduleNoFirstSignal(): void {
    const timeoutMs = this._noFirstSignalMs
    if (timeoutMs == null) return
    this._clearNoFirstSignalTimer()
    this._noFirstTimer = setTimeout(() => {
      if (!this._sawFirstSignal) {
        this._markSuspectedStall('no_first_signal')
      }
    }, timeoutMs)
  }

  private _clearNoFirstSignalTimer(): void {
    if (!this._noFirstTimer) return
    clearTimeout(this._noFirstTimer)
    this._noFirstTimer = null
  }

  private _abortExternal(reason?: unknown): void {
    if (this.signal.aborted) return
    this._abortError = reason instanceof Error ? reason : TURN_CANCELLED
    this._abort.abort(this._abortError)
    this.dispose()
  }

  private _abortInternal(reason: unknown): void {
    if (this._disposed || this.signal.aborted) return
    this._abortError = reason instanceof Error ? reason : TURN_CANCELLED
    this._abort.abort(this._abortError)
    this.dispose()
  }

  private _markSuspectedStall(reason: 'no_first_signal' | 'stalled'): void {
    if (this._disposed || this.signal.aborted || this._suspectedStall) return
    this._suspectedStall = true
    sandboxTurnDebug('turn-scope: suspected stall (observe only)', {
      reason,
      role: this.role,
      noFirstSignalMs: this._noFirstSignalMs
    })
    // A heuristic inactivity signal is not proof that the agent is dead. Keep
    // the turn alive; only explicit cancellation or deterministic provider /
    // process failure may terminate it.
    this._tryKeepAlive()
  }
}

export function assertRoleTurnReply(input: {
  role: ConversationRole
  reply: string
  providerLabel: string
  partial?: true
}): void {
  if (!roleRequiresOuterSandbox(input.role)) return
  if (input.partial) return
  const trimmed = input.reply.trim()
  if (!trimmed) {
    throw createTurnError('turn.empty_reply', {
      detail: `${input.providerLabel} task turn produced no valid output`
    })
  }
}

export function partialCompletedChunk(input: {
  reply: string
  runtimeSessionId: string | null
  graceCancelled: boolean
}): Extract<AgentTurnChunk, { type: 'completed' }> | null {
  if (!input.graceCancelled || !input.reply.trim()) return null
  return {
    type: 'completed',
    reply: input.reply.trim(),
    runtimeSessionId: input.runtimeSessionId,
    partial: true
  }
}

export function recordClaudeStreamActivity(message: unknown, scope: TurnScope): void {
  scope.recordProgress('provider_event')
  const typed = message as {
    type?: string
    event?: { type?: string; content_block?: { type?: string; name?: string } }
    message?: { content?: Array<{ type?: string; name?: string; input?: { command?: string } }> }
  }

  if (typed.type === 'stream_event') {
    const blockType = typed.event?.content_block?.type
    if (blockType === 'tool_use') {
      scope.recordProgress('tool_started')
    }
    return
  }

  const blocks = typed.message?.content
  if (!blocks?.length) return

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      scope.recordProgress('tool_started')
      const command =
        typeof block.input === 'object' && block.input && 'command' in block.input
          ? String((block.input as { command?: string }).command ?? '')
          : block.name === 'Bash'
            ? String((block.input as { command?: string } | undefined)?.command ?? '')
            : ''
      if (command) {
        scope.enterLongRunningTool(command)
      }
    }
    if (block.type === 'tool_result') {
      scope.exitLongRunningTool()
      scope.recordProgress('tool_completed')
    }
  }
}

export function recordCodexThreadItemActivity(
  item: {
    type?: string
    status?: string
    command?: string
    tool?: string
    server?: string
  },
  scope: TurnScope
): void {
  scope.recordProgress('provider_event')

  if (item.type === 'command_execution') {
    scope.recordProgress('tool_started')
    if (item.status === 'in_progress') {
      scope.enterLongRunningTool(item.command)
    } else {
      scope.exitLongRunningTool()
      scope.recordProgress('tool_completed')
    }
    return
  }

  if (item.type === 'mcp_tool_call') {
    scope.recordProgress('mcp_call')
    if (item.status === 'in_progress') {
      scope.recordProgress('tool_started')
      const label =
        [item.server, item.tool]
          .filter((part) => typeof part === 'string' && part.trim())
          .join('/') || 'mcp'
      scope.enterLongRunningTool(label)
    } else {
      scope.exitLongRunningTool()
      scope.recordProgress('tool_completed')
    }
  }
}

function extractOpencodeToolCommand(part: {
  tool?: string
  state?: {
    status?: string
    title?: string
    input?: { [key: string]: unknown }
  }
}): string {
  const input = part.state?.input
  if (input && typeof input === 'object') {
    for (const key of ['command', 'cmd', 'script'] as const) {
      const value = input[key]
      if (typeof value === 'string' && value.trim()) return value
    }
  }
  if (typeof part.state?.title === 'string' && part.state.title.trim()) {
    return part.state.title
  }
  return typeof part.tool === 'string' ? part.tool : ''
}

/**
 * Feed OpenCode tool part status into the turn watchdog.
 * Tracks open call IDs so repeated running updates do not double-count.
 */
export function recordOpencodeToolPartActivity(
  part: {
    id?: string
    callID?: string
    type?: string
    tool?: string
    state?: {
      status?: string
      title?: string
      input?: { [key: string]: unknown }
    }
  },
  scope: TurnScope,
  openToolIds: Set<string>
): void {
  if (part.type !== 'tool' || !part.state?.status) return

  const id = part.callID || part.id
  if (!id) return

  const status = part.state.status
  if (status === 'pending' || status === 'running') {
    if (!openToolIds.has(id)) {
      openToolIds.add(id)
      scope.recordProgress('tool_started')
      // Interactive question hangs the turn with no UI; do not grant stall grace.
      const command = extractOpencodeToolCommand(part)
      if (command !== 'question' && part.tool !== 'question') {
        scope.enterLongRunningTool(command)
      }
    } else {
      scope.recordProgress('tool_updated')
    }
    return
  }

  if (status === 'completed' || status === 'error') {
    if (!openToolIds.has(id)) return
    openToolIds.delete(id)
    scope.exitLongRunningTool()
    scope.recordProgress('tool_completed')
  }
}

/**
 * Feed Cursor ACP tool_call / tool_call_update into the turn watchdog.
 */
export function recordAcpToolCallActivity(
  update: {
    sessionUpdate?: string
    toolCallId?: string
    status?: string | null
    title?: string | null
    kind?: string | null
  },
  scope: TurnScope,
  openToolIds: Set<string>
): void {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return
  }

  const id = update.toolCallId
  if (!id) return

  const status = update.status ?? (update.sessionUpdate === 'tool_call' ? 'pending' : null)
  if (!status) {
    if (openToolIds.has(id)) scope.recordProgress('tool_updated')
    return
  }

  if (status === 'pending' || status === 'in_progress') {
    if (!openToolIds.has(id)) {
      openToolIds.add(id)
      scope.recordProgress('tool_started')
      const label =
        (typeof update.title === 'string' && update.title.trim()) ||
        (typeof update.kind === 'string' ? update.kind : '') ||
        id
      scope.enterLongRunningTool(label)
    } else {
      scope.recordProgress('tool_updated')
    }
    return
  }

  if (status === 'completed' || status === 'failed') {
    if (!openToolIds.has(id)) return
    openToolIds.delete(id)
    scope.exitLongRunningTool()
    scope.recordProgress('tool_completed')
  }
}
