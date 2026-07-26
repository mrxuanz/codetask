/**
 * Maps new-core query projections / work DTOs onto legacy-shaped API objects
 * (docs/refactor/fixtures/api/*.json). Pure — no DB / repository access.
 */
import type { ThreadProjection } from '../core/application/queries/get-thread'
import type { DraftProjection } from '../core/application/queries/get-draft'
import type { PlanProjection } from '../core/application/queries/get-plan'
import type { JobProjection } from '../core/application/queries/get-job'

/** Legacy list_messages message row (conversation.sample.json). */
export type LegacyConversationMessage = {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly kind: string
  readonly content: string
  readonly attachments: readonly unknown[]
  readonly coreCode: string | null
  readonly sessionId?: string | null
  readonly conversationId?: string | null
  readonly runtimeSessionId?: string | null
  readonly wizardPhase: string | null
  readonly thinking?: string | null
  readonly thinkingDurationMs?: number | null
  readonly payload?: unknown
  readonly createdAt: string
}

/** Legacy GET /api/threads/:id/agent data shape. */
export type LegacyThreadAgentData = {
  readonly configured: boolean
  readonly agent: {
    readonly name: string
    readonly workspacePath: string
    readonly coreCode: string
    readonly createdAt: string
    readonly updatedAt: string
  } | null
  readonly sessionId: string | null
  readonly conversationId: string | null
  readonly runtimeSessionId: string | null
  readonly runtimeStatus: string | null
  readonly lastError: string | null
  readonly pendingCount: number
  readonly core: {
    readonly code: string
    readonly label: string
    readonly description: string
    readonly available: boolean
  } | null
}

/** Legacy turn start / get_turn data fragments. */
export type LegacyTurnQueuedData = {
  readonly turnId: string
  readonly status: string
  readonly revision: number
  readonly queuePosition: number | null
}

export type LegacyTurnRecord = {
  readonly id: string
  readonly threadId: string
  readonly username: string
  readonly kind: string
  readonly status: string
  readonly workspaceAccess: string
  readonly provider: string | null
  readonly messagePreview: string
  readonly queuePosition: number | null
  readonly stateRevision: number
  readonly lastError: unknown
  readonly createdAt: number
  readonly startedAt: number | null
  readonly completedAt: number | null
}

/** Legacy thread draft summary (draft-job.sample.json list_thread_drafts). */
export type LegacyThreadDraftSummary = {
  readonly messageId: string
  readonly draftId: string
  readonly title: string
  readonly summary: string
  readonly status: string
  readonly linkedPlanId: string | null
  readonly designSessionId: string | null
  readonly launchedJobId: string | null
  readonly createdAt: string
  readonly collecting: boolean
  readonly plan: { readonly id: string; readonly status: string; readonly title: string } | null
}

/** Legacy plan list item (plan-confirm.sample.json list_thread_plans). */
export type LegacyPlanListItem = {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly planRevision: number
  readonly planConfirmedAt: number | null
}

export type LegacyPlanNode = {
  readonly nodeRef: string
  readonly title: string
  readonly description?: string
  readonly successCriteria?: string
  readonly abilityCode?: string | null
  readonly coreCode?: string | null
  readonly confirmed?: boolean
}

export type MapConversationTurnInput = {
  readonly turnId: string
  readonly threadId: string
  readonly message: string
  readonly status?: string
  readonly kind?: string
  readonly username?: string
  readonly provider?: string | null
  readonly createdAtSec?: number
}

function firstLine(content: string): string {
  const line = content.split('\n').find((part) => part.trim().length > 0)
  return line?.trim() || 'Draft'
}

function mapDraftStatusToLegacy(status: DraftProjection['status']): string {
  switch (status) {
    case 'collecting':
      return 'collecting'
    case 'confirmed':
      return 'ready'
    case 'abandoned':
      return 'abandoned'
    default:
      return status
  }
}

function mapPlanStatusToLegacy(status: PlanProjection['status']): string {
  switch (status) {
    case 'editing':
      return 'plan_editing'
    case 'in_review':
      return 'plan_editing'
    case 'confirmed':
      return 'pending'
    default:
      return status
  }
}

/**
 * Map thread projection → legacy agent payload (conversation.sample.json get_thread_agent).
 * No DB access — caller supplies projection + optional display hints.
 */
export function mapThreadToLegacyAgent(
  thread: ThreadProjection,
  options?: {
    readonly coreCode?: string
    readonly workspacePath?: string
    readonly createdAt?: string
    readonly updatedAt?: string
  }
): LegacyThreadAgentData {
  const coreCode = options?.coreCode ?? 'cursor'
  const stamp = options?.createdAt ?? '1970-01-01T00:00:00.000Z'
  return {
    configured: true,
    agent: {
      name: coreCode,
      workspacePath: options?.workspacePath ?? `workspace/${thread.projectId}`,
      coreCode,
      createdAt: stamp,
      updatedAt: options?.updatedAt ?? stamp
    },
    sessionId: null,
    conversationId: null,
    runtimeSessionId: null,
    runtimeStatus: null,
    lastError: null,
    pendingCount: 0,
    core: {
      code: coreCode,
      label: coreCode === 'cursor' ? 'Cursor Agent' : coreCode,
      description: `${coreCode} runtime`,
      available: true
    }
  }
}

/** Map a user message string into a legacy conversation message row. */
export function mapUserMessageToLegacy(
  input: {
    readonly id: string
    readonly content: string
    readonly createdAt: string
    readonly coreCode?: string | null
    readonly wizardPhase?: string | null
  }
): LegacyConversationMessage {
  return {
    id: input.id,
    role: 'user',
    kind: 'text',
    content: input.content,
    attachments: [],
    coreCode: input.coreCode ?? null,
    sessionId: null,
    conversationId: null,
    runtimeSessionId: null,
    wizardPhase: input.wizardPhase ?? 'chat',
    thinking: null,
    thinkingDurationMs: null,
    payload: null,
    createdAt: input.createdAt
  }
}

export function mapAssistantMessageToLegacy(
  input: {
    readonly id: string
    readonly content: string
    readonly createdAt: string
    readonly coreCode?: string | null
    readonly wizardPhase?: string | null
    readonly kind?: string
  }
): LegacyConversationMessage {
  return {
    id: input.id,
    role: 'assistant',
    kind: input.kind ?? 'text',
    content: input.content,
    attachments: [],
    coreCode: input.coreCode ?? null,
    wizardPhase: input.wizardPhase ?? 'chat',
    createdAt: input.createdAt
  }
}

export function mapTurnToLegacyQueued(
  input: MapConversationTurnInput & { readonly revision?: number; readonly queuePosition?: number }
): LegacyTurnQueuedData {
  return {
    turnId: input.turnId,
    status: input.status ?? 'queued',
    revision: input.revision ?? 1,
    queuePosition: input.queuePosition ?? 1
  }
}

export function mapTurnToLegacyRecord(input: MapConversationTurnInput): LegacyTurnRecord {
  const createdAt = input.createdAtSec ?? 0
  return {
    id: input.turnId,
    threadId: input.threadId,
    username: input.username ?? 'demo',
    kind: input.kind ?? 'chat',
    status: input.status ?? 'completed',
    workspaceAccess: 'read_write',
    provider: input.provider ?? 'cursor',
    messagePreview: input.message.slice(0, 200),
    queuePosition: null,
    stateRevision: 1,
    lastError: null,
    createdAt,
    startedAt: createdAt || null,
    completedAt: createdAt || null
  }
}

/**
 * Map draft projection → legacy thread draft summary (draft-job.sample.json).
 */
export function mapDraftToLegacySummary(
  draft: DraftProjection,
  options?: {
    readonly messageId?: string
    readonly createdAt?: string
    readonly linkedPlanId?: string | null
    readonly plan?: LegacyThreadDraftSummary['plan']
  }
): LegacyThreadDraftSummary {
  const title = firstLine(draft.content)
  const linkedPlanId =
    options?.linkedPlanId !== undefined
      ? options.linkedPlanId
      : (draft.payload?.planId ?? null)
  return {
    messageId: options?.messageId ?? draft.id,
    draftId: draft.id,
    title,
    summary: draft.content,
    status: mapDraftStatusToLegacy(draft.status),
    linkedPlanId,
    designSessionId: linkedPlanId,
    launchedJobId: draft.payload?.jobId ?? null,
    createdAt: options?.createdAt ?? '1970-01-01T00:00:00.000Z',
    collecting: draft.status === 'collecting',
    plan: options?.plan ?? null
  }
}

/**
 * Map plan projection → legacy plan list item (plan-confirm.sample.json).
 */
export function mapPlanToLegacyListItem(plan: PlanProjection): LegacyPlanListItem {
  const rootTitle =
    plan.nodes.find((n) => n.kind === 'milestone')?.title ??
    plan.nodes[0]?.title ??
    'Plan'
  return {
    id: plan.id,
    title: rootTitle,
    status: mapPlanStatusToLegacy(plan.status),
    planRevision: plan.revision,
    planConfirmedAt: plan.status === 'confirmed' ? 1 : null
  }
}

/** Map plan nodes to legacy job.plan.nodes shape. */
export function mapPlanNodesToLegacy(plan: PlanProjection): readonly LegacyPlanNode[] {
  return plan.nodes
    .filter((n) => n.kind === 'task')
    .map((n) => ({
      nodeRef: `task:${n.id}`,
      title: n.title,
      successCriteria: n.successCriteria,
      abilityCode: n.abilityCode ?? null,
      coreCode: null,
      confirmed: plan.status === 'confirmed'
    }))
}

/**
 * Legacy ThreadJobDto-shaped fragment (job-control.sample.json / draft-job.sample.json).
 * Keys align with fixture samples; progress bags are stubs until query hydration lands.
 */
export type LegacyJobDto = {
  readonly id: string
  readonly threadId: string
  readonly draftMessageId: string
  readonly title: string
  readonly summary: string
  readonly status: string
  readonly planRevision: number | null
  readonly stateRevision: number
  readonly suspensionKind: string | null
  readonly continueAfterPause: boolean
  readonly availableActions: readonly string[]
  readonly planProgress: {
    readonly phase: string
    readonly status: string
    readonly contextsRegistered: number
    readonly contextsTotal: number
    readonly message: string | null
  }
  readonly taskProgress: {
    readonly phase: string
    readonly status: string
    readonly currentIndex: number
    readonly total: number
    readonly tasks: readonly unknown[]
  }
  readonly abilities: readonly unknown[]
  readonly createdAt: number
  readonly updatedAt: number
}

function mapJobStatusToLegacy(status: JobProjection['status']): string {
  switch (status) {
    case 'queued':
      return 'pending'
    case 'verification':
      return 'running'
    default:
      return status
  }
}

function availableActionsFor(status: JobProjection['status']): readonly string[] {
  switch (status) {
    case 'queued':
    case 'running':
    case 'verification':
      return ['pause', 'cancel']
    case 'pausing':
      return []
    case 'paused':
      return ['continue', 'cancel']
    case 'completed':
    case 'failed':
    case 'cancelled':
      return ['restart_execution', 'delete']
    default:
      return []
  }
}

/**
 * Map job projection → legacy job DTO keys (job-control.sample.json).
 */
export function mapJobToLegacy(job: JobProjection): LegacyJobDto {
  const status = mapJobStatusToLegacy(job.status)
  const now = job.updatedAt ?? job.createdAt ?? 0
  return {
    id: job.id,
    threadId: job.threadId ?? '',
    draftMessageId: job.draftMessageId ?? '',
    title: job.title ?? '',
    summary: job.summary ?? '',
    status,
    planRevision: job.planRevision,
    stateRevision: job.stateRevision,
    suspensionKind: job.status === 'pausing' || job.status === 'paused' ? 'user_requested' : null,
    continueAfterPause: false,
    availableActions: availableActionsFor(job.status),
    planProgress: {
      phase: 'idle',
      status: 'pending',
      contextsRegistered: 0,
      contextsTotal: 0,
      message: null
    },
    taskProgress: {
      phase: status === 'running' ? 'running' : 'idle',
      status: status === 'running' ? 'running' : 'pending',
      currentIndex: 0,
      total: 0,
      tasks: []
    },
    abilities: [],
    createdAt: job.createdAt ?? now,
    updatedAt: now
  }
}
