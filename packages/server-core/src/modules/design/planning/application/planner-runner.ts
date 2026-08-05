import { randomUUID } from 'node:crypto'
import {
  CODETASK_MANAGER_MCP_SERVER,
  MCP_HTTP_ACCEPT_HEADER_VALUE,
  toCanonicalProviderCode,
  type AgentRuntime,
  type ProviderCode
} from '@codetask/agent-runtime'
import type { DraftSnapshot, ExecutionTreeSnapshot, ReferenceManifest } from '@codetask/contracts'
import type { PlannerRunnerPort, PlanningApplicationPort } from './planning-application.ts'
import { buildTreeFromOutline, validateTreeAgainstDraft } from '../domain/planning.ts'
import { newId } from '../../shared.ts'
import {
  buildPlannerMcpUrl,
  buildPlannerSystemPrompt,
  buildPlannerUserMessage,
  getPlannerMcpBackendPort,
  isPlannerPlanCommitted,
  isPlannerSilentEmptyTurnError,
  registerPlannerMcpSession,
  resolvePlannerMissingFinalizeError,
  unregisterPlannerMcpSession,
  type PlannerMcpSession
} from '../mcp/index.ts'

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

function sleepPlannerRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Planner turn cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Planner turn cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function resolveSystemPrompt(plannerSettingsSnapshotJson?: string): string {
  let frozenPrompt = buildPlannerSystemPrompt()
  if (!plannerSettingsSnapshotJson) return frozenPrompt
  try {
    const snap = JSON.parse(plannerSettingsSnapshotJson) as { promptBody?: string }
    if (typeof snap.promptBody === 'string' && snap.promptBody.trim()) {
      frozenPrompt = snap.promptBody
    }
  } catch {
    // keep default when snapshot is empty/malformed
  }
  return frozenPrompt
}

function resolveUserMcpServers(plannerSettingsSnapshotJson?: string): Record<string, unknown> {
  if (!plannerSettingsSnapshotJson) return {}
  try {
    const snap = JSON.parse(plannerSettingsSnapshotJson) as {
      mcpServers?: Record<string, unknown>
    }
    if (snap.mcpServers && typeof snap.mcpServers === 'object') {
      return snap.mcpServers
    }
  } catch {
    // keep empty
  }
  return {}
}

/**
 * Planner that drives AgentRuntime with Design Planner MCP.
 * Success path commits only via finalize_plan → registeredPlanToExecutionTree → commitExecutionTree.
 */
export class AgentRuntimePlannerRunner implements PlannerRunnerPort {
  constructor(
    private readonly planningPort: () => PlanningApplicationPort,
    private readonly agentRuntime: AgentRuntime,
    private readonly options: {
      /** Max silent-empty turn retries (default 3). */
      maxSilentEmptyAttempts?: number
      getMcpBackendPort?: () => number
      signal?: AbortSignal
    } = {}
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
      toCanonicalProviderCode(input.executionProfile.plannerCoreCode) ?? ('codex' as ProviderCode)
    const scopeId = `planning:${input.sessionId}:provider:${provider}`
    const systemPrompt = resolveSystemPrompt(input.plannerSettingsSnapshotJson)
    const userMcpServers = resolveUserMcpServers(input.plannerSettingsSnapshotJson)
    const userPrompt = buildPlannerUserMessage({
      draft: input.draftSnapshot,
      workspacePath: input.draftSnapshot.workspaceRoot
    })
    const defaultCoreCode =
      input.draftSnapshot.abilities[0]?.recommendedCoreCode ??
      input.executionProfile.plannerCoreCode
    const maxSilentEmptyAttempts = Math.max(1, this.options.maxSilentEmptyAttempts ?? 3)
    const getPort = this.options.getMcpBackendPort ?? getPlannerMcpBackendPort

    let planCommitted = false
    let plannerSession: PlannerMcpSession | null = null
    let lastSilentEmptyError: Error | null = null

    for (let attempt = 1; attempt <= maxSilentEmptyAttempts; attempt += 1) {
      if (attempt > 1) {
        const delayMs = Math.min(2_000 * 2 ** Math.max(0, attempt - 2), 60_000)
        await sleepPlannerRetry(delayMs, this.options.signal)
      }

      const mcpSessionId = `plan-mcp-${randomUUID()}`
      const abortController = new AbortController()
      if (this.options.signal) {
        if (this.options.signal.aborted) {
          throw this.options.signal.reason instanceof Error
            ? this.options.signal.reason
            : new Error('Planner turn cancelled')
        }
        this.options.signal.addEventListener(
          'abort',
          () => abortController.abort(this.options.signal?.reason),
          { once: true }
        )
      }

      plannerSession = {
        sessionId: mcpSessionId,
        planningSessionId: input.sessionId,
        runId: input.runId,
        fencingToken: input.fencingToken,
        allowedAbilityCodes: input.draftSnapshot.abilities.map((a) => a.abilityCode),
        validReferenceIds: input.referenceManifest.references.map((r) => r.id),
        draftSnapshot: input.draftSnapshot,
        referenceManifest: input.referenceManifest,
        defaultCoreCode,
        planning: this.planningPort(),
        taskContexts: new Map(),
        planOutline: null,
        abortTurn: () => {
          if (!abortController.signal.aborted) {
            try {
              abortController.abort('finalize_plan')
            } catch {
              // ignore
            }
          }
        },
        onPlanOutlineRegistered: async (counts) => {
          this.planningPort().notifyPlannerProgress?.({
            sessionId: input.sessionId,
            contextsRegistered: 0,
            contextsTotal: counts.tasks,
            milestones: counts.milestones,
            slices: counts.slices,
            tasks: counts.tasks
          })
        },
        onTaskContextRegistered: async (_key, done) => {
          const outline = plannerSession?.planOutline
          if (!outline) return
          let milestones = 0
          let slices = 0
          let tasks = 0
          for (const m of outline.milestones) {
            milestones += 1
            for (const s of m.slices) {
              slices += 1
              tasks += s.tasks.length
            }
          }
          this.planningPort().notifyPlannerProgress?.({
            sessionId: input.sessionId,
            contextsRegistered: done,
            contextsTotal: tasks,
            milestones,
            slices,
            tasks
          })
        }
      }

      registerPlannerMcpSession(plannerSession)

      let mcpUrl: string
      try {
        mcpUrl = buildPlannerMcpUrl({
          sessionId: mcpSessionId,
          planningSessionId: input.sessionId,
          port: getPort()
        })
      } catch (error) {
        unregisterPlannerMcpSession(mcpSessionId)
        throw new Error(
          `Planner MCP unavailable: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      let runtimeFailed: string | null = null
      try {
        for await (const event of this.agentRuntime.runTurn({
          role: 'planner',
          provider,
          capabilityProfile: 'planner-read',
          prompt: userPrompt,
          systemPrompt,
          mcpServers: [
            {
              name: CODETASK_MANAGER_MCP_SERVER,
              url: mcpUrl,
              headers: { Accept: MCP_HTTP_ACCEPT_HEADER_VALUE }
            }
          ],
          userMcpServers,
          scopeId,
          turnId: `${input.runId}:attempt:${attempt}`,
          workspaceRoot: input.draftSnapshot.workspaceRoot || undefined,
          signal: abortController.signal
        })) {
          if (event.type === 'failed') {
            runtimeFailed = event.message
          }
          if (plannerSession.planCommitted) break
        }
      } catch (error) {
        if (isPlannerPlanCommitted(planCommitted, plannerSession)) {
          planCommitted = true
          return
        }
        const abortedForFinalize =
          abortController.signal.aborted && abortController.signal.reason === 'finalize_plan'
        if (!abortedForFinalize) {
          runtimeFailed = error instanceof Error ? error.message : String(error)
        }
      } finally {
        unregisterPlannerMcpSession(mcpSessionId)
      }

      if (plannerSession.finalizerPromise) {
        await plannerSession.finalizerPromise
      }

      if (plannerSession.planCommitted) {
        planCommitted = true
        return
      }

      if (plannerSession.finalizerError) {
        throw plannerSession.finalizerError
      }

      const missingFinalizeError = resolvePlannerMissingFinalizeError(plannerSession)
      if (isPlannerSilentEmptyTurnError(missingFinalizeError) && attempt < maxSilentEmptyAttempts) {
        lastSilentEmptyError = missingFinalizeError
        void lastSilentEmptyError
        void runtimeFailed
        continue
      }

      if (runtimeFailed && !plannerSessionTouched(plannerSession)) {
        // Prefer missing-finalize semantics when MCP was never touched.
      }
      throw missingFinalizeError
    }

    throw lastSilentEmptyError ?? new Error('Planner failed to finalize execution tree')
  }
}

function plannerSessionTouched(session: PlannerMcpSession): boolean {
  return Boolean(session.planOutline) || session.taskContexts.size > 0
}

/** @internal test/stub helper — not used on AgentRuntimePlannerRunner success path. */
export { buildSnapshotOutlineTree }

export type { ExecutionTreeSnapshot }
