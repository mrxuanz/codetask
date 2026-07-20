/**
 * Harness infrastructure budgets only.
 *
 * Agent turn / job / case waits intentionally have no script-side ceiling:
 * poll until CodeTask reports a terminal API status (completed|failed|cancelled).
 * Product ProgressGuard + sandbox wall clocks own hang detection.
 */
export const TIMEOUTS = {
  serverStartupMs: 120_000,
  httpRequestMs: 30_000,
  /** OpenCode `serve` / process bootstrap only — not turn execution. */
  agentStartupMs: 60_000,
  mcpCallMs: 60_000,
  gracefulShutdownMs: 15_000,
  healthPollMs: 500,
  turnPollMs: 500
} as const
