/**
 * Harness infrastructure budgets.
 *
 * OpenCode outer-driver stages always have hard ceilings unless `--no-timeout`
 * is explicitly set (forbidden in CI). `timeoutMs: 0` means "use these defaults",
 * never infinite wait.
 */
export const TIMEOUTS = {
  serverStartupMs: 120_000,
  httpRequestMs: 30_000,
  /** OpenCode `serve` / process bootstrap only — not turn execution. */
  agentStartupMs: 60_000,
  /** Single `session.prompt` hard ceiling. */
  opencodePromptMs: 5 * 60_000,
  /** After prompt returns successfully, wait at most this long for report_case_result. */
  capabilityReportMs: 30_000,
  /** Case worker process kill budget for every driver. */
  caseWorkerMs: 10 * 60_000,
  /** Minimal host-config/model/MCP preflight. */
  opencodeCanaryMs: 90_000,
  mcpCallMs: 60_000,
  gracefulShutdownMs: 15_000,
  healthPollMs: 500,
  turnPollMs: 500
} as const

export type OpencodeBudgets = {
  /** Explicit infinite mode (`--no-timeout`). Forbidden when CI=1/true. */
  noTimeout: boolean
  startupMs: number
  promptMs: number
  capabilityReportMs: number
  workerMs: number
}

/**
 * Resolve staged OpenCode budgets.
 * - `timeoutMs <= 0` → defaults (never infinite)
 * - positive `timeoutMs` → shrinks each stage to fit under the overall budget
 * - `noTimeout: true` → no deadlines (local debug only)
 */
export function resolveOpencodeBudgets(input: {
  timeoutMs?: number
  noTimeout?: boolean
}): OpencodeBudgets {
  const noTimeout = Boolean(input.noTimeout)
  if (noTimeout) {
    return {
      noTimeout: true,
      // setTimeout cannot use Infinity; MAX_SAFE_INTEGER is effectively unbounded.
      startupMs: Number.MAX_SAFE_INTEGER,
      promptMs: Number.MAX_SAFE_INTEGER,
      capabilityReportMs: Number.MAX_SAFE_INTEGER,
      workerMs: Number.MAX_SAFE_INTEGER
    }
  }

  const overall =
    typeof input.timeoutMs === 'number' && input.timeoutMs > 0
      ? input.timeoutMs
      : TIMEOUTS.caseWorkerMs

  return {
    noTimeout: false,
    startupMs: Math.min(TIMEOUTS.agentStartupMs, overall),
    promptMs: Math.min(TIMEOUTS.opencodePromptMs, overall),
    capabilityReportMs: Math.min(TIMEOUTS.capabilityReportMs, overall),
    workerMs: overall
  }
}

export function resolveCaseWorkerBudget(input: {
  timeoutMs?: number
  noTimeout?: boolean
}): number {
  if (input.noTimeout) return Number.MAX_SAFE_INTEGER
  return typeof input.timeoutMs === 'number' && input.timeoutMs > 0
    ? input.timeoutMs
    : TIMEOUTS.caseWorkerMs
}

export function assertNoTimeoutAllowed(noTimeout: boolean): void {
  if (!noTimeout) return
  const ci = process.env.CI?.trim().toLowerCase()
  if (ci === '1' || ci === 'true') {
    throw new Error('business_e2e_no_timeout_forbidden_in_ci')
  }
}
