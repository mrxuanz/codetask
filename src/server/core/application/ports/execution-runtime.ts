import type { StdioOptions } from 'node:child_process'

/**
 * Minimal child handle returned from a live openTurn spawn.
 * Prefer this over leaking full ChildProcess into domain callers.
 */
export interface RuntimeChildHandle {
  readonly pid?: number | undefined
  kill(signal?: NodeJS.Signals | number): boolean
  readonly stdin: unknown
  readonly stdout: unknown
  readonly stderr: unknown
  on(event: string | symbol, listener: (...args: unknown[]) => void): unknown
  once(event: string | symbol, listener: (...args: unknown[]) => void): unknown
}

/** Spawn argv0 + optional wrapper prefix (e.g. PowerShell / cmd). */
export interface OpenTurnInvocation {
  readonly executable: string
  readonly prefixArgs?: readonly string[]
}

export interface OpenTurnRequest {
  readonly jobId: string
  readonly providerCode?: string
  readonly prompt?: string
  readonly timeoutMs?: number
  readonly abortSignal?: AbortSignal
  /** Live spawn payload — required when RuntimeAdapter runs with dryRun:false. */
  readonly invocation?: OpenTurnInvocation
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdio?: StdioOptions
  /** Passed through to the underlying spawn (e.g. AbortSignal). */
  readonly signal?: AbortSignal
}

export interface OpenTurnResult {
  readonly turnId: string
  /** Present only for live (non-dryRun) protected spawns. */
  readonly child?: RuntimeChildHandle
}

/**
 * Minimal execution runtime port (重构.md §1.2).
 * Business layer only opens turns — no sandbox / path details.
 */
export interface ExecutionRuntimePort {
  openTurn(req: OpenTurnRequest): Promise<OpenTurnResult>
  /**
   * Sync live spawn for provider custom-spawn callbacks (Claude SDK / Cursor ACP).
   * Optional: dry-run / fake runtimes omit this and fail closed via protected-spawn.
   */
  openTurnSync?(req: OpenTurnRequest): OpenTurnResult
}
