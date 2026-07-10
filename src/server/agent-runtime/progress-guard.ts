import type { ConversationRole } from './roles'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import type { TurnActivityKind } from './turn-scope'
import { stalledAfterMsForRole } from './turn-timeouts'
import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from '../sandbox/session-state'

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

function progressWindowMs(): number {
  const env = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
  if (env) {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 5 * 60_000
}

/**
 * Absolute single-tool grace cap. After this elapses, open tools no longer
 * suppress stall — even if `_openToolCount > 0` (the C.2 hole).
 * Env: CODETASK_LONG_TOOL_CAP_MS (preferred) or CODETASK_TURN_TOOL_WALL_MS.
 */
export function longRunningToolCapMs(): number {
  for (const key of ['CODETASK_LONG_TOOL_CAP_MS', 'CODETASK_TURN_TOOL_WALL_MS'] as const) {
    const env = process.env[key]
    if (env) {
      const parsed = Number(env)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }
  return DEFAULT_SANDBOX_TURN_TIMEOUT_MS
}

/** @deprecated Prefer longRunningToolCapMs — kept for existing test imports. */
export const toolWallMs = longRunningToolCapMs

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
  /** Wall clock start for the current open-tool grace window. */
  private _toolGraceStartedAt: number | null = null
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
        this._ensureToolGraceClock()
        break
      case 'tool_completed':
        this._openToolCount = Math.max(0, this._openToolCount - 1)
        this._clearToolGraceClockIfIdle()
        break
      case 'tool_updated':
      case 'text_delta':
      case 'thinking_delta':
        this._windowHadActivity = true
        break
    }
  }

  /**
   * Mark an in-flight tool/command as long-running so the stall watchdog
   * treats the turn as progressing. Any non-empty command/title qualifies.
   * Idempotent while already long-running.
   */
  enterLongRunningTool(command?: string | null): void {
    if (this._disposed) return
    const trimmed = command?.trim()
    if (!trimmed) return
    if (this._longRunningTool) return
    this._longRunningTool = true
    this.recordActivity('tool_started')
    sandboxTurnDebug('progress-guard: long-running tool grace', { command: trimmed })
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

  private _hasOpenTool(): boolean {
    return this._openToolCount > 0 || this._longRunningTool
  }

  private _ensureToolGraceClock(): void {
    if (this._toolGraceStartedAt == null) {
      this._toolGraceStartedAt = Date.now()
    }
  }

  private _clearToolGraceClockIfIdle(): void {
    if (!this._hasOpenTool()) {
      this._toolGraceStartedAt = null
    }
  }

  /**
   * Open tools suppress stall only while within the absolute wall-cap.
   * After the cap, `_openToolCount > 0` must NOT keep the turn alive (C.2 hole).
   */
  private _isToolGraceActive(): boolean {
    if (!this._hasOpenTool()) return false
    const startedAt = this._toolGraceStartedAt
    if (startedAt == null) return true
    const elapsed = Date.now() - startedAt
    if (elapsed > longRunningToolCapMs()) {
      return false
    }
    return true
  }

  private _isProgressing(): boolean {
    if (this._isToolGraceActive()) return true
    return this._windowHadActivity
  }

  private _tick(windowMs = progressWindowMs()): void {
    if (this._disposed || this._stalledEmitted) return

    const graceActive = this._isToolGraceActive()
    if (this._isProgressing()) {
      this._stalledAccum = 0
    } else {
      this._stalledAccum += windowMs
      if (this._hasOpenTool() && !graceActive) {
        sandboxTurnDebug('progress-guard: tool wall expired', {
          role: this._role,
          wallMs: longRunningToolCapMs(),
          openToolCount: this._openToolCount,
          longRunningTool: this._longRunningTool,
          stalledAccumMs: this._stalledAccum
        })
      }
    }

    this._windowHadActivity = false

    const threshold = stalledAfterMsForRole(this._role)
    if (this._stalledAccum >= threshold) {
      sandboxTurnDebug('progress-guard: stalled', {
        role: this._role,
        stalledAccumMs: this._stalledAccum,
        thresholdMs: threshold,
        openToolCount: this._openToolCount,
        longRunningTool: this._longRunningTool,
        toolGraceActive: graceActive
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
