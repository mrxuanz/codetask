export type DriverStartInput = {
  caseId: string
  caseRunId: string
  skillPaths: string[]
  mcpUrl: string
  capabilityId: string
  workspaceRoot: string
  agentRoot: string
  fixture?: Record<string, unknown>
  /**
   * Worker / driver budget.
   * `<=0` → unbounded case wait (CodeTask business API terminal); OpenCode
   * startup/prompt/report stages stay finite.
   * Positive value → explicit overall ceiling.
   * `noTimeout: true` unlocks OpenCode stage ceilings (`--no-timeout`, forbidden in CI).
   */
  timeoutMs: number
  /** Explicit infinite OpenCode stage ceilings for local debugging only. */
  noTimeout?: boolean
  /** Selected SUT conversation SDK / core for every thread created by this case. */
  conversationCore: string
  expectedHtmlFile?: string
  /** Phase-3 settings probe base URL (http://127.0.0.1:port). */
  probeMcpUrl?: string
  probeMcpName?: string
}

export type DriverEvent = {
  type: string
  at: string
  detail?: unknown
}

export type DriverResult = {
  ok: boolean
  classification?: string
  error?: string
  events: DriverEvent[]
}

export interface AgentDriver {
  readonly name: string
  start(input: DriverStartInput): Promise<DriverResult>
  cleanup(): Promise<void>
}
