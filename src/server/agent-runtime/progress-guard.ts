import type { ConversationRole } from './roles'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import type { TurnActivityKind } from './turn-scope'

const LONG_RUNNING_COMMAND_RE =
  /\b(npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|bun\s+test|pytest|cargo\s+test|go\s+test|jest|vitest|playwright\s+test|mvn\s+test|gradle\s+test|make\s+test|ctest)\b/i

export function isLongRunningTestCommand(command: string | undefined | null): boolean {
  const trimmed = command?.trim()
  if (!trimmed) return false
  return LONG_RUNNING_COMMAND_RE.test(trimmed)
}

interface StalledListener {
  (): void
}

function stalledAfterMs(role: ConversationRole): number {
  const env = process.env.CODETASK_TURN_STALLED_MS
  if (env) {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  if (role === 'task-worker') return 60 * 60_000
  if (role === 'planner') return 20 * 60_000
  if (role === 'milestone-verifier' || role === 'slice-verifier') return 15 * 60_000
  return 20 * 60_000
}

function progressWindowMs(): number {
  const env = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
  if (env) {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 5 * 60_000
}

export class ProgressGuard {
  private readonly _role: ConversationRole
  private readonly _stalledListeners = new Set<StalledListener>()
  private _openToolCount = 0
  private _windowHadActivity = false
  private _stalledAccum = 0
  private _tickTimer: ReturnType<typeof setInterval> | null = null
  private _started = false
  private _disposed = false
  private _longRunningTool = false
  private _stalledEmitted = false

  constructor(role: ConversationRole) {
    this._role = role
  }

  get isStarted(): boolean {
    return this._started
  }

  start(): void {
    if (this._started || this._disposed) return
    this._started = true
    const windowMs = progressWindowMs()
    this._tickTimer = setInterval(() => this._tick(windowMs), windowMs)
    this._tickTimer?.unref?.()
  }

  recordActivity(kind: TurnActivityKind): void {
    if (this._disposed) return

    switch (kind) {
      case 'tool_started':
        this._openToolCount += 1
        break
      case 'tool_completed':
        this._openToolCount = Math.max(0, this._openToolCount - 1)
        break
      case 'text_delta':
      case 'thinking_delta':
        this._windowHadActivity = true
        break
    }
  }

  enterLongRunningTool(command?: string | null): void {
    if (!isLongRunningTestCommand(command)) return
    this._longRunningTool = true
    this.recordActivity('tool_started')
    sandboxTurnDebug('progress-guard: long-running tool grace', { command: command?.trim() })
  }

  exitLongRunningTool(): void {
    if (!this._longRunningTool) return
    this._longRunningTool = false
    this.recordActivity('tool_completed')
  }

  on(event: 'stalled', listener: () => void): void {
    if (event !== 'stalled') return
    this._stalledListeners.add(listener)
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    if (this._tickTimer) {
      clearInterval(this._tickTimer)
      this._tickTimer = null
    }
    this._stalledListeners.clear()
  }

  private _isProgressing(): boolean {
    return this._openToolCount > 0 || this._windowHadActivity || this._longRunningTool
  }

  private _tick(windowMs = progressWindowMs()): void {
    if (this._disposed || this._stalledEmitted) return

    if (this._isProgressing()) {
      this._stalledAccum = 0
    } else {
      this._stalledAccum += windowMs
    }

    this._windowHadActivity = false

    const threshold = stalledAfterMs(this._role)
    if (this._stalledAccum >= threshold) {
      sandboxTurnDebug('progress-guard: stalled', {
        role: this._role,
        stalledAccumMs: this._stalledAccum,
        thresholdMs: threshold,
        openToolCount: this._openToolCount,
        longRunningTool: this._longRunningTool
      })
      this._emitStalled()
    }
  }

  private _emitStalled(): void {
    if (this._stalledEmitted) return
    this._stalledEmitted = true
    if (this._tickTimer) {
      clearInterval(this._tickTimer)
      this._tickTimer = null
    }
    for (const listener of this._stalledListeners) {
      try {
        listener()
      } catch {
        // best-effort
      }
    }
  }
}
