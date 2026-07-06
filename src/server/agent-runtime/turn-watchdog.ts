import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { createTurnError, TURN_CANCELLED } from '../../shared/turn-errors.ts'
import type { TurnError } from '../../shared/turn-errors.ts'
import type { ConversationRole } from './roles'
import { roleRequiresOuterSandbox } from './roles'

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

export interface TurnWatchdogPolicy {
  noFirstSignalMs: number

  idleMs: number

  wallMs: number

  longRunningToolMs: number
}

const DEFAULT_NO_FIRST_SIGNAL_MS = 120_000
const DEFAULT_IDLE_CONVERSATION_MS = 3 * 60_000
const DEFAULT_IDLE_TASK_WORKER_MS = 10 * 60_000
const DEFAULT_WALL_CONVERSATION_MS = 30 * 60_000
const DEFAULT_WALL_TASK_WORKER_MS = 45 * 60_000
const DEFAULT_LONG_RUNNING_TOOL_MS = 30 * 60_000

const LONG_RUNNING_COMMAND_RE =
  /\b(npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|bun\s+test|pytest|cargo\s+test|go\s+test|jest|vitest|playwright\s+test|mvn\s+test|gradle\s+test|make\s+test|ctest)\b/i

export function isLongRunningTestCommand(command: string | undefined | null): boolean {
  const trimmed = command?.trim()
  if (!trimmed) return false
  return LONG_RUNNING_COMMAND_RE.test(trimmed)
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return parsed
}

export function resolveTurnWatchdogPolicy(role: ConversationRole): TurnWatchdogPolicy {
  const isWorker = roleRequiresOuterSandbox(role)
  return {
    noFirstSignalMs: parsePositiveInt(
      process.env.CODETASK_TURN_NO_FIRST_SIGNAL_MS,
      DEFAULT_NO_FIRST_SIGNAL_MS
    ),
    idleMs: parsePositiveInt(
      process.env.CODETASK_TURN_IDLE_MS,
      isWorker ? DEFAULT_IDLE_TASK_WORKER_MS : DEFAULT_IDLE_CONVERSATION_MS
    ),
    wallMs: parsePositiveInt(
      process.env.CODETASK_TURN_WALL_MS,
      isWorker ? DEFAULT_WALL_TASK_WORKER_MS : DEFAULT_WALL_CONVERSATION_MS
    ),
    longRunningToolMs: parsePositiveInt(
      process.env.CODETASK_TURN_LONG_RUNNING_TOOL_MS,
      DEFAULT_LONG_RUNNING_TOOL_MS
    )
  }
}

export type TurnWatchdogAbortReason = 'no_first_signal' | 'idle' | 'wall' | 'external'

export function turnWatchdogTimeoutError(
  reason: TurnWatchdogAbortReason,
  policy: TurnWatchdogPolicy
): TurnError {
  switch (reason) {
    case 'no_first_signal':
      return createTurnError('turn.watchdog_no_signal', {
        params: { seconds: Math.max(1, Math.round(policy.noFirstSignalMs / 1000)) }
      })
    case 'idle':
      return createTurnError('turn.watchdog_idle')
    case 'wall':
      return createTurnError('turn.watchdog_wall', {
        params: { minutes: Math.max(1, Math.round(policy.wallMs / 60_000)) }
      })
    case 'external':
      return TURN_CANCELLED
    default:
      return createTurnError('turn.timed_out')
  }
}

export function turnWatchdogTimeoutMessage(
  reason: TurnWatchdogAbortReason,
  policy: TurnWatchdogPolicy
): string {
  return turnWatchdogTimeoutError(reason, policy).message
}

export class TurnWatchdog {
  readonly policy: TurnWatchdogPolicy
  readonly signal: AbortSignal

  private readonly abort = new AbortController()
  private readonly onAbortCallback?: () => void
  private disposed = false
  private sawFirstSignal = false
  private longRunningTool = false
  private noFirstTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private wallTimer: NodeJS.Timeout | null = null
  private abortError: Error | null = null

  constructor(options: {
    role: ConversationRole
    externalSignal?: AbortSignal
    onAbort?: () => void
    policy?: TurnWatchdogPolicy
  }) {
    this.policy = options.policy ?? resolveTurnWatchdogPolicy(options.role)
    this.onAbortCallback = options.onAbort
    this.signal = this.abort.signal

    if (options.externalSignal?.aborted) {
      this.abortExternal()
    } else {
      options.externalSignal?.addEventListener('abort', () => this.abortExternal(), { once: true })
    }
  }

  arm(): void {
    this.scheduleNoFirstSignal()
    this.scheduleWall()
    this.scheduleIdle()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  recordActivity(_kind: TurnActivityKind = 'provider_event'): void {
    if (this.disposed || this.signal.aborted) return
    this.sawFirstSignal = true
    this.clearNoFirstSignalTimer()
    this.scheduleIdle()
  }

  enterLongRunningTool(command?: string | null): void {
    if (!isLongRunningTestCommand(command)) return
    this.longRunningTool = true
    this.recordActivity('shell_running')
    sandboxTurnDebug('turn-watchdog: long-running tool grace', { command: command?.trim() })
  }

  exitLongRunningTool(): void {
    if (!this.longRunningTool) return
    this.longRunningTool = false
    this.recordActivity('tool_completed')
  }

  async race<T>(promise: Promise<T>): Promise<T> {
    if (this.abortError) throw this.abortError
    if (this.signal.aborted) {
      throw this.abortError ?? TURN_CANCELLED
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup()
        reject(this.abortError ?? TURN_CANCELLED)
      }

      const cleanup = (): void => {
        this.signal.removeEventListener('abort', onAbort)
      }

      this.signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          cleanup()
          if (this.signal.aborted) {
            reject(this.abortError ?? TURN_CANCELLED)
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearNoFirstSignalTimer()
    this.clearIdleTimer()
    if (this.wallTimer) {
      clearTimeout(this.wallTimer)
      this.wallTimer = null
    }
  }

  private currentIdleMs(): number {
    return this.longRunningTool ? this.policy.longRunningToolMs : this.policy.idleMs
  }

  private scheduleNoFirstSignal(): void {
    this.clearNoFirstSignalTimer()
    this.noFirstTimer = setTimeout(() => {
      if (!this.sawFirstSignal) {
        this.fail('no_first_signal')
      }
    }, this.policy.noFirstSignalMs)
  }

  private scheduleIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      if (!this.sawFirstSignal) {
        this.fail('no_first_signal')
        return
      }
      this.fail('idle')
    }, this.currentIdleMs())
  }

  private scheduleWall(): void {
    if (this.wallTimer) clearTimeout(this.wallTimer)
    this.wallTimer = setTimeout(() => this.fail('wall'), this.policy.wallMs)
  }

  private clearNoFirstSignalTimer(): void {
    if (!this.noFirstTimer) return
    clearTimeout(this.noFirstTimer)
    this.noFirstTimer = null
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private abortExternal(): void {
    if (this.signal.aborted) return
    this.abortError = turnWatchdogTimeoutError('external', this.policy)
    this.abort.abort()
    this.dispose()
  }

  private fail(reason: TurnWatchdogAbortReason): void {
    if (this.disposed || this.signal.aborted) return
    const turnError = turnWatchdogTimeoutError(reason, this.policy)
    sandboxTurnDebug('turn-watchdog: abort', {
      reason,
      sawFirstSignal: this.sawFirstSignal,
      longRunningTool: this.longRunningTool,
      code: turnError.code,
      message: turnError.message
    })
    this.abortError = turnError
    try {
      this.onAbortCallback?.()
    } catch {
      // best-effort, ignore errors
    }
    this.abort.abort()
    this.dispose()
  }
}

export function assertRoleTurnReply(input: {
  role: ConversationRole
  reply: string
  providerLabel: string
}): void {
  if (!roleRequiresOuterSandbox(input.role)) return
  const trimmed = input.reply.trim()
  if (!trimmed) {
    throw createTurnError('turn.empty_reply', {
      detail: `${input.providerLabel} task turn produced no valid output`
    })
  }
}

export function recordClaudeStreamActivity(message: unknown, watchdog: TurnWatchdog): void {
  watchdog.recordActivity('provider_event')
  const typed = message as {
    type?: string
    event?: { type?: string; content_block?: { type?: string; name?: string } }
    message?: { content?: Array<{ type?: string; name?: string; input?: { command?: string } }> }
  }

  if (typed.type === 'stream_event') {
    const blockType = typed.event?.content_block?.type
    if (blockType === 'tool_use') {
      watchdog.recordActivity('tool_started')
    }
    return
  }

  const blocks = typed.message?.content
  if (!blocks?.length) return

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      watchdog.recordActivity('tool_started')
      const command =
        typeof block.input === 'object' && block.input && 'command' in block.input
          ? String((block.input as { command?: string }).command ?? '')
          : block.name === 'Bash'
            ? String((block.input as { command?: string } | undefined)?.command ?? '')
            : ''
      if (command) {
        watchdog.enterLongRunningTool(command)
      }
    }
    if (block.type === 'tool_result') {
      watchdog.exitLongRunningTool()
      watchdog.recordActivity('tool_completed')
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
  watchdog: TurnWatchdog
): void {
  watchdog.recordActivity('provider_event')

  if (item.type === 'command_execution') {
    watchdog.recordActivity('tool_started')
    if (item.status === 'in_progress') {
      watchdog.enterLongRunningTool(item.command)
    } else {
      watchdog.exitLongRunningTool()
      watchdog.recordActivity('tool_completed')
    }
    return
  }

  if (item.type === 'mcp_tool_call') {
    watchdog.recordActivity('mcp_call')
    if (item.status === 'in_progress') {
      watchdog.recordActivity('tool_started')
    } else {
      watchdog.recordActivity('tool_completed')
    }
  }
}
