import type {
  PlanningSessionViewDto,
  TaskProgressDto,
  ThreadDraftSummaryDto
} from '@codetask/contracts'
import { toPlanningSessionStatus } from '@codetask/contracts'
import type { DesignDraftDto, DesignExecutionTreeSnapshot, PlanningSessionDto } from './design'
import type { ExecutionJob } from './jobs-api'

/** Convert an Execution job to the read-only plan view used by legacy UI surfaces. */
export function mapExecutionJobToPlanView(job: ExecutionJob): PlanningSessionViewDto {
  const state = job.state
  const status =
    state === 'succeeded'
      ? 'completed'
      : state === 'queued'
        ? 'pending'
        : state === 'cancelling'
          ? 'cancelled'
          : toPlanningSessionStatus(state)
  const workItems =
    job.tree?.milestones.flatMap((milestone) =>
      milestone.slices.flatMap((slice) => slice.workItems)
    ) ?? []
  const taskItems: TaskProgressDto['tasks'] = workItems.map((work) => ({
    id: work.id,
    title: work.title,
    status:
      work.state === 'succeeded'
        ? 'completed'
        : work.state === 'failed' || work.state === 'blocked'
          ? 'failed'
          : work.state === 'skipped' || work.state === 'cancelled'
            ? 'skipped'
            : work.state === 'running' || work.state === 'leased' || work.state === 'reported'
              ? 'running'
              : 'queued',
    abilityCode: work.abilityCode,
    providerCode: work.providerCode,
    executionStatus: work.state
  }))
  const currentTaskId = workItems.find((work) =>
    ['leased', 'running', 'reported'].includes(work.state)
  )?.id
  const abilities = Array.from(
    new Map(
      workItems.map((work) => [
        work.abilityCode,
        { abilityCode: work.abilityCode, recommendedCoreCode: work.providerCode }
      ])
    ).values()
  )
  return {
    id: job.id,
    draftMessageId: job.sourceDraftId || '',
    title: job.title,
    summary: job.summary ?? '',
    status,
    abilities,
    plan: job.tree,
    workspacePath: job.workspaceRoot,
    planProgress: {
      phase: status === 'failed' ? 'failed' : 'plan_ready',
      status: status === 'failed' ? 'failed' : 'completed',
      contextsRegistered: 0,
      contextsTotal: 0
    },
    taskProgress: {
      phase: state === 'running' || state === 'pausing' ? 'running' : 'idle',
      status:
        state === 'running' || state === 'pausing'
          ? 'running'
          : state === 'failed'
            ? 'failed'
            : status === 'completed'
              ? 'completed'
              : 'pending',
      currentIndex: Math.max(
        0,
        taskItems.findIndex((task) => task.id === currentTaskId)
      ),
      total: taskItems.length,
      currentTaskId: currentTaskId ?? null,
      tasks: taskItems,
      slices: job.tree?.milestones.flatMap((milestone) =>
        milestone.slices.map((slice) => ({
          id: slice.id,
          runtimeStatus: slice.state,
          verificationStatus: slice.verificationState
        }))
      ),
      milestones: job.tree?.milestones.map((milestone) => ({
        id: milestone.id,
        verificationStatus: milestone.state
      }))
    },
    queue:
      job.queuePosition != null
        ? { position: job.queuePosition, ahead: Math.max(0, job.queuePosition - 1) }
        : undefined,
    designSessionId: job.sourcePlanningSessionId || null,
    stateRevision: job.stateRevision,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  }
}

export function mapDesignDraftToSummary(draft: DesignDraftDto): ThreadDraftSummaryDto {
  return {
    messageId: draft.id,
    draftId: draft.id,
    title: draft.title,
    summary: draft.summary,
    status: draft.status,
    linkedPlanId: null,
    designSessionId: null,
    launchedJobId: null,
    createdAt: new Date(draft.createdAt).toISOString(),
    plan: null
  }
}

export function mapPlanningSessionToJob(
  session: PlanningSessionDto,
  tree: DesignExecutionTreeSnapshot | null = null,
  draft?: DesignDraftDto
): PlanningSessionViewDto {
  const status = toPlanningSessionStatus(
    session.status === 'plan_editing' || session.status === 'ready_to_publish'
      ? 'plan_editing'
      : session.status === 'planning' || session.status === 'queued'
        ? 'planning'
        : session.status === 'published'
          ? 'pending'
          : session.status
  )
  const planning =
    status === 'planning' || session.status === 'queued' || session.status === 'planning'
  const treeTasks =
    tree?.milestones.flatMap((milestone) => milestone.slices.flatMap((slice) => slice.tasks)) ?? []
  const confirmedCount = tree
    ? tree.milestones.reduce(
        (total, milestone) =>
          total +
          Number(milestone.confirmed) +
          milestone.slices.reduce(
            (sliceTotal, slice) =>
              sliceTotal +
              Number(slice.confirmed) +
              slice.tasks.filter((task) => task.confirmed).length,
            0
          ),
        0
      )
    : 0
  const nodeCount = tree
    ? tree.milestones.reduce(
        (total, milestone) =>
          total +
          1 +
          milestone.slices.reduce((sliceTotal, slice) => sliceTotal + 1 + slice.tasks.length, 0),
        0
      )
    : 0
  const abilities =
    draft?.abilities.map((ability) => ({
      abilityCode: ability.abilityCode,
      label: ability.label,
      recommendedCoreCode: ability.recommendedCoreCode
    })) ??
    Array.from(
      new Map(
        treeTasks.map((task) => [
          task.abilityCode,
          { abilityCode: task.abilityCode, recommendedCoreCode: task.providerCode }
        ])
      ).values()
    )
  return {
    id: session.id,
    draftMessageId: session.sourceDraftId,
    title: draft?.title ?? `Planning ${session.id}`,
    summary: draft?.summary ?? '',
    status,
    workspaceRoot: draft?.workspaceRoot,
    workspacePath: draft?.workspaceRoot ?? '',
    abilities,
    plan: tree,
    planProgress: {
      phase: planning ? 'planning' : status === 'failed' ? 'failed' : 'plan_ready',
      status: planning ? 'running' : status === 'failed' ? 'failed' : 'completed',
      contextsRegistered: planning ? confirmedCount : nodeCount,
      contextsTotal: nodeCount,
      milestones: tree?.milestones.length,
      slices: tree?.milestones.reduce((total, milestone) => total + milestone.slices.length, 0),
      tasks: treeTasks.length
    },
    taskProgress: {
      phase: 'idle',
      status: 'pending',
      currentIndex: 0,
      total: treeTasks.length,
      tasks: treeTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: 'queued',
        abilityCode: task.abilityCode,
        providerCode: task.providerCode
      }))
    },
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    planRevision: session.treeRevision,
    designSessionId: session.id,
    planConfirmedAt: session.publishedJobId ? Math.floor(session.updatedAt / 1000) : null
  }
}
