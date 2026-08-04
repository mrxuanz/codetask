import type Database from 'better-sqlite3'
import type { AgentRuntime } from '@codetask/agent-runtime'
import type {
  DesignRealtimeEventName,
  DesignSettingsSnapshot,
  ExecutionSettingsSnapshot
} from '@codetask/contracts'
import { DraftApplication } from './draft/application/draft-application.ts'
import type { ProjectWorkspacePort } from './draft/application/ports.ts'
import { SqliteDraftRepository } from './draft/infrastructure/sqlite-draft-repository.ts'
import { createDraftRoutes, createPlanningRoutes } from './draft/http/routes.ts'
import {
  PlanningApplication,
  type PlanningEventPort
} from './planning/application/planning-application.ts'
import {
  AgentRuntimePlannerRunner,
  SnapshotPlannerRunner
} from './planning/application/planner-runner.ts'
import { SqlitePlanningCapacity } from './planning/infrastructure/planning-capacity.ts'
import { SqlitePlanningRepository } from './planning/infrastructure/sqlite-planning-repository.ts'
import { JobSubmissionOutbox } from './handoff/job-submission-outbox.ts'
import type { JobSubmissionPort } from './planning/application/planning-application.ts'
import { Hono } from 'hono'
import type { DesignHttpEnv } from './draft/http/routes.ts'
import type { Actor } from './shared.ts'

export type DesignModule = {
  drafts: DraftApplication
  planning: PlanningApplication
  outbox: JobSubmissionOutbox
  routes: Hono<DesignHttpEnv>
  /** Shared AgentRuntime for Provider-backed planner swap (03). */
  agentRuntime: AgentRuntime | null
}

export type DesignModuleDeps = {
  db: Database.Database
  resolveWorkspaceRoot: ProjectWorkspacePort['resolveWorkspaceRoot']
  publishEvent?: PlanningEventPort['publish']
  jobSubmission: JobSubmissionPort
  /**
   * Shared AgentRuntime port. When provided, planning runs through
   * AgentRuntimePlannerRunner (03); otherwise SnapshotPlannerRunner.
   */
  agentRuntime?: AgentRuntime
  /** HTTP port for Planner MCP URLs (defaults to initPlannerMcpBackend). */
  getMcpBackendPort?: () => number
  capturePlannerSettings?: (providerCode: string) => DesignSettingsSnapshot
  captureExecutionSettings?: (
    taskProvider: string,
    verificationProvider: string
  ) => ExecutionSettingsSnapshot
}

export function composeDesignModule(deps: DesignModuleDeps): DesignModule {
  const draftRepo = new SqliteDraftRepository(deps.db)
  const planningRepo = new SqlitePlanningRepository(deps.db)
  const capacity = new SqlitePlanningCapacity(deps.db)
  const outbox = new JobSubmissionOutbox(deps.db, deps.jobSubmission)
  const events: PlanningEventPort = {
    publish(sessionId, event, payload) {
      deps.publishEvent?.(sessionId, event, payload)
    }
  }

  const planningHolder: { app?: PlanningApplication } = {}
  const getPlanningApp = (): PlanningApplication => {
    if (!planningHolder.app) throw new Error('Planning application is not initialized')
    return planningHolder.app
  }
  const planner = deps.agentRuntime
    ? new AgentRuntimePlannerRunner(getPlanningApp, deps.agentRuntime, {
        ...(deps.getMcpBackendPort ? { getMcpBackendPort: deps.getMcpBackendPort } : {})
      })
    : new SnapshotPlannerRunner(getPlanningApp)
  const planningApp = new PlanningApplication(
    planningRepo,
    capacity,
    outbox.asPort(),
    events,
    planner,
    {
      ...(deps.capturePlannerSettings
        ? { capturePlannerSettings: deps.capturePlannerSettings }
        : {}),
      ...(deps.captureExecutionSettings
        ? { captureExecutionSettings: deps.captureExecutionSettings }
        : {})
    }
  )
  planningHolder.app = planningApp
  const drafts = new DraftApplication(draftRepo, {
    resolveWorkspaceRoot: deps.resolveWorkspaceRoot
  })

  const routes = new Hono<DesignHttpEnv>()
  routes.route('/drafts', createDraftRoutes(drafts, planningApp))
  routes.route('/planning-sessions', createPlanningRoutes(planningApp))

  return {
    drafts,
    planning: planningApp,
    outbox,
    routes,
    agentRuntime: deps.agentRuntime ?? null
  }
}

export type { Actor, DesignRealtimeEventName }
export {
  DesignConflictError,
  DesignForbiddenError,
  DesignNotFoundError,
  DesignValidationError
} from './shared.ts'
export { registeredPlanToExecutionTree } from './planning/domain/registered-plan-to-tree.ts'
export {
  AgentRuntimePlannerRunner,
  SnapshotPlannerRunner
} from './planning/application/planner-runner.ts'
export {
  authorizePlannerMcpRequest,
  buildPlannerMcpUrl,
  buildPlannerSystemPrompt,
  buildPlannerUserMessage,
  dispatchPlannerToolForTests,
  getPlannerMcpBackendPort,
  handlePlannerMcpJsonRpc,
  initPlannerMcpBackend,
  registerPlannerMcpSession,
  unregisterPlannerMcpSession
} from './planning/mcp/index.ts'
