export type DriverStartInput = {
  caseId: string
  caseRunId: string
  skillPaths: string[]
  mcpUrl: string
  capabilityId: string
  workspaceRoot: string
  agentRoot: string
  fixture?: Record<string, unknown>
  timeoutMs: number
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
