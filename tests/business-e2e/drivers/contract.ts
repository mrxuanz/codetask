export type DriverStartInput = {
  caseId: string
  caseRunId: string
  skillPaths: string[]
  mcpUrl: string
  capabilityId: string
  workspaceRoot: string
  agentRoot: string
  fixture?: Record<string, unknown>
  /** Worker kill budget; <=0 means wait for driver exit / CodeTask terminal only. */
  timeoutMs: number
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
