/**
 * Harness infrastructure budgets.
 *
 * Business turn/job waits default to CodeTask API terminal status only
 * (completed|failed|cancelled) — no wall-clock case kill. OpenCode outer-driver
 * stages still have hard ceilings unless `--no-timeout` is set (forbidden in CI).
 * Positive `timeoutMs` is only for intentional short negative probes.
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
  /**
   * Reference overall for OpenCode outer-driver stage shrink only.
   * Case workers do not use this as a default kill budget.
   */
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
 * - `timeoutMs <= 0` → staged defaults (finite stage ceilings; workerMs unbounded)
 * - positive `timeoutMs` → shrinks each stage to fit under the overall budget
 * - `noTimeout: true` → no deadlines (local debug only; forbidden in CI)
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

  const hasOverall = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
  const overall = hasOverall ? input.timeoutMs : TIMEOUTS.caseWorkerMs

  return {
    noTimeout: false,
    startupMs: Math.min(TIMEOUTS.agentStartupMs, overall),
    promptMs: Math.min(TIMEOUTS.opencodePromptMs, overall),
    capabilityReportMs: Math.min(TIMEOUTS.capabilityReportMs, overall),
    // Default: no wall-clock case kill; wait for business API / agent report.
    workerMs: hasOverall ? overall : Number.MAX_SAFE_INTEGER
  }
}

/**
 * Case worker process budget.
 * - omitted / <=0 / noTimeout → unbounded (wait for CodeTask business terminal)
 * - positive timeoutMs → explicit short/overall probe ceiling
 */
export function resolveCaseWorkerBudget(input: {
  timeoutMs?: number
  noTimeout?: boolean
}): number {
  if (input.noTimeout) return Number.MAX_SAFE_INTEGER
  return typeof input.timeoutMs === 'number' && input.timeoutMs > 0
    ? input.timeoutMs
    : Number.MAX_SAFE_INTEGER
}

/**
 * `--no-timeout` unlocks OpenCode stage ceilings (startup/prompt/report).
 * Case-worker and turn/job business waits are already unbounded by default;
 * the flag remains forbidden in CI for the outer-driver stage unlock.
 */
export function assertNoTimeoutAllowed(noTimeout: boolean): void {
  if (!noTimeout) return
  const ci = process.env.CI?.trim().toLowerCase()
  if (ci === '1' || ci === 'true') {
    throw new Error('business_e2e_no_timeout_forbidden_in_ci')
  }
}
