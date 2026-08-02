import {
  toCanonicalProviderCode,
  type AgentRuntime,
  type ProviderCode
} from '@codetask/agent-runtime'
import type {
  DraftSnapshot,
  ExecutionTreeSnapshot,
  ReferenceManifest
} from '@codetask/contracts'
import type { PlannerRunnerPort } from '../application/planning-application.ts'
import { buildTreeFromOutline, validateTreeAgainstDraft } from '../domain/planning.ts'
import type { PlanningApplicationPort } from '../application/planning-application.ts'
import { newId } from '../../shared.ts'

function buildSnapshotOutlineTree(input: {
  sessionId: string
  draftSnapshot: DraftSnapshot
  referenceManifest: ReferenceManifest
}): ExecutionTreeSnapshot {
  const ability = input.draftSnapshot.abilities[0]
  if (!ability) {
    throw new Error('Draft snapshot has no abilities')
  }
  const milestoneId = newId('ms')
  const sliceId = newId('sl')
  const taskId = newId('tk')
  return buildTreeFromOutline({
    planningSessionId: input.sessionId,
    treeId: newId('tree'),
    revision: 0,
    milestones: [
      {
        id: milestoneId,
        title: `Deliver ${input.draftSnapshot.title}`,
        description: input.draftSnapshot.summary || input.draftSnapshot.title,
        successCriteria: 'Requirements satisfied and verified',
        slices: [
          {
            id: sliceId,
            title: 'Implementation slice',
            description: input.draftSnapshot.userFlow || 'Implement requirements',
            successCriteria: 'Slice acceptance criteria met',
            tasks: [
              {
                id: taskId,
                title: `Implement: ${input.draftSnapshot.title}`,
                description: input.draftSnapshot.requirementsMarkdown.slice(0, 2000),
                taskKind: 'general-implementation',
                abilityCode: ability.abilityCode,
                coreCode: ability.recommendedCoreCode,
                contextMarkdown: [
                  `# Task context`,
                  input.draftSnapshot.requirementsMarkdown,
                  '',
                  `Tech stack: ${input.draftSnapshot.techStack}`,
                  `User flow: ${input.draftSnapshot.userFlow}`
                ].join('\n'),
                successCriteria: 'Implementation matches requirements contract',
                referenceIds: input.referenceManifest.references.map((r) => r.id),
                dependsOnTaskIds: [],
                canRunInParallel: false
              }
            ]
          }
        ]
      }
    ]
  })
}

/**
 * In-process planner used when AgentRuntime is not injected (unit tests).
 * Produces a minimal valid one-milestone tree from the draft snapshot.
 */
export class SnapshotPlannerRunner implements PlannerRunnerPort {
  constructor(private readonly planningPort: () => PlanningApplicationPort) {}

  async run(input: {
    sessionId: string
    runId: string
    fencingToken: string
    draftSnapshot: DraftSnapshot
    referenceManifest: ReferenceManifest
    executionProfile: { plannerCoreCode: string }
    plannerSettingsSnapshotJson?: string
  }): Promise<void> {
    const tree = buildSnapshotOutlineTree(input)
    validateTreeAgainstDraft({
      tree,
      abilities: input.draftSnapshot.abilities,
      references: input.draftSnapshot.references,
      manifest: input.referenceManifest
    })
    await this.planningPort().commitExecutionTree({
      sessionId: input.sessionId,
      fencingToken: input.fencingToken,
      tree
    })
  }
}

/**
 * Planner that exercises the shared AgentRuntime port (architecture 03),
 * then commits a validated snapshot tree. ScriptedAgentRuntime can observe
 * the planner turn; real providers may fail the probe without blocking commit
 * when `commitEvenIfRuntimeFails` is true (default).
 */
export class AgentRuntimePlannerRunner implements PlannerRunnerPort {
  constructor(
    private readonly planningPort: () => PlanningApplicationPort,
    private readonly agentRuntime: AgentRuntime,
    private readonly options: { commitEvenIfRuntimeFails?: boolean } = {}
  ) {}

  async run(input: {
    sessionId: string
    runId: string
    fencingToken: string
    draftSnapshot: DraftSnapshot
    referenceManifest: ReferenceManifest
    executionProfile: { plannerCoreCode: string }
    plannerSettingsSnapshotJson?: string
  }): Promise<void> {
    const provider =
      toCanonicalProviderCode(input.executionProfile.plannerCoreCode) ??
      ('codex' as ProviderCode)
    const scopeId = `planning:${input.sessionId}:provider:${provider}`
    let runtimeFailed: string | null = null

    let frozenPrompt =
      'You are the Design Planner. Reply with a short confirmation that planning context was received.'
    let userMcpServers: Record<string, unknown> = {}
    if (input.plannerSettingsSnapshotJson) {
      try {
        const snap = JSON.parse(input.plannerSettingsSnapshotJson) as {
          promptBody?: string
          mcpServers?: Record<string, unknown>
        }
        if (typeof snap.promptBody === 'string' && snap.promptBody.trim()) {
          frozenPrompt = snap.promptBody
        }
        if (snap.mcpServers && typeof snap.mcpServers === 'object') {
          userMcpServers = snap.mcpServers
        }
      } catch {
        // keep defaults when snapshot is empty/malformed
      }
    }

    try {
      for await (const event of this.agentRuntime.runTurn({
        role: 'planner',
        provider,
        capabilityProfile: 'planner-read',
        prompt: [
          'Produce an execution outline for this draft.',
          `Title: ${input.draftSnapshot.title}`,
          `Summary: ${input.draftSnapshot.summary}`,
          input.draftSnapshot.requirementsMarkdown.slice(0, 4000)
        ].join('\n'),
        systemPrompt: frozenPrompt,
        userMcpServers,
        scopeId,
        turnId: input.runId,
        workspaceRoot: undefined
      })) {
        if (event.type === 'failed') {
          runtimeFailed = event.message
        }
      }
    } catch (error) {
      runtimeFailed = error instanceof Error ? error.message : String(error)
    }

    if (runtimeFailed && this.options.commitEvenIfRuntimeFails === false) {
      throw new Error(`Planner AgentRuntime failed: ${runtimeFailed}`)
    }

    const tree = buildSnapshotOutlineTree(input)
    validateTreeAgainstDraft({
      tree,
      abilities: input.draftSnapshot.abilities,
      references: input.draftSnapshot.references,
      manifest: input.referenceManifest
    })
    await this.planningPort().commitExecutionTree({
      sessionId: input.sessionId,
      fencingToken: input.fencingToken,
      tree
    })
  }
}

export type { ExecutionTreeSnapshot }
