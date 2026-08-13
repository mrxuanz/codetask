/**
 * Harness infrastructure budgets.
 *
 * Business turn/job waits default to CodeTask API terminal status only
 * (completed|failed|cancelled) — no wall-clock case kill. Live outer-operator
 * stages still have hard ceilings unless `--no-timeout` is set (forbidden in CI).
 * Positive `timeoutMs` is only for intentional short negative probes.
 */
export const TIMEOUTS = {
  serverStartupMs: 120_000,
  httpRequestMs: 30_000,
  /** Local-server operator process bootstrap only — not turn execution. */
  agentStartupMs: 60_000,
  /** Single outer SDK/ACP/local-server turn hard ceiling. */
  agentPromptMs: 5 * 60_000,
  /** @deprecated compatibility name for OpenCode-specific guard tests. */
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

export type AgentBudgets = {
  /** Explicit infinite mode (`--no-timeout`). Forbidden when CI=1/true. */
  noTimeout: boolean
  startupMs: number
  promptMs: number
  capabilityReportMs: number
  workerMs: number
}

/** @deprecated use AgentBudgets for protocol-neutral outer operators. */
export type OpencodeBudgets = AgentBudgets

/**
 * Resolve staged live-operator budgets.
 * - `timeoutMs <= 0` → staged defaults (finite stage ceilings; workerMs unbounded)
 * - positive `timeoutMs` → shrinks each stage to fit under the overall budget
 * - `noTimeout: true` → no deadlines (local debug only; forbidden in CI)
 */
export function resolveAgentBudgets(input: {
  timeoutMs?: number
  noTimeout?: boolean
}): AgentBudgets {
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
    promptMs: Math.min(TIMEOUTS.agentPromptMs, overall),
    capabilityReportMs: Math.min(TIMEOUTS.capabilityReportMs, overall),
    // Default: no wall-clock case kill; wait for business API / agent report.
    workerMs: hasOverall ? overall : Number.MAX_SAFE_INTEGER
  }
}

/** Compatibility wrapper retained for the existing OpenCode isolated harness. */
export const resolveOpencodeBudgets = resolveAgentBudgets

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
 * `--no-timeout` unlocks live-operator stage ceilings (startup/prompt/report).
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
