import { randomBytes } from 'node:crypto'

export type FixturePhaseState = {
  fixtureId: string
  phaseOrder: string[]
  phases: Record<string, { message?: string; [key: string]: unknown }>
  nextIndex: number
  unlocked: string[]
}

export type Capability = {
  capabilityId: string
  caseRunId: string
  caseId: string
  allowedTools: Set<string>
  createdAt: number
  revoked: boolean
  workspaceRoot?: string
  checkpoints: string[]
  fixtureState?: FixturePhaseState
  agentReport?: {
    caseId: string
    status: string
    summary: string
    observations?: unknown
    artifacts?: unknown
  }
}

export class CapabilityStore {
  private readonly byId = new Map<string, Capability>()
  private readonly byCase = new Map<string, string>()

  issue(input: {
    caseRunId: string
    caseId: string
    allowedTools: string[]
    workspaceRoot?: string
    fixtureState?: FixturePhaseState
  }): Capability {
    const capabilityId = `cap_${randomBytes(12).toString('hex')}`
    const capability: Capability = {
      capabilityId,
      caseRunId: input.caseRunId,
      caseId: input.caseId,
      allowedTools: new Set(input.allowedTools),
      createdAt: Date.now(),
      revoked: false,
      workspaceRoot: input.workspaceRoot,
      checkpoints: [],
      fixtureState: input.fixtureState
    }
    this.byId.set(capabilityId, capability)
    this.byCase.set(input.caseRunId, capabilityId)
    return capability
  }

  get(capabilityId: string): Capability | undefined {
    return this.byId.get(capabilityId)
  }

  getByCase(caseRunId: string): Capability | undefined {
    const id = this.byCase.get(caseRunId)
    return id ? this.byId.get(id) : undefined
  }

  assertAllowed(capabilityId: string, toolName: string): Capability {
    const capability = this.byId.get(capabilityId)
    if (!capability || capability.revoked) {
      throw new Error('mcp.capability_invalid')
    }
    if (!capability.allowedTools.has(toolName)) {
      throw new Error(`mcp.tool_not_allowed:${toolName}`)
    }
    return capability
  }

  revoke(caseRunId: string): void {
    const id = this.byCase.get(caseRunId)
    if (!id) return
    const capability = this.byId.get(id)
    if (capability) capability.revoked = true
  }

  revokeAll(): void {
    for (const capability of this.byId.values()) capability.revoked = true
  }
}
