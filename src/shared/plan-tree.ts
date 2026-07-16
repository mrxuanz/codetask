import type { JobReferenceManifestDto, TaskAssignedReference } from './job-references'
import type { TaskEvidenceDto } from './contracts/evidence'
import { resolveAssignedReferencesFromDto } from './job-references'

export type PlanUnitStatus =
  | 'pending'
  | 'planned'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface UnifiedTaskNode {
  id: string
  title: string
  description: string
  taskKind: string
  abilityCode: string
  contextMarkdown: string
  successCriteria: string
  order: number

  planStatus: PlanUnitStatus

  status: string
  executionStatus?: string | null | undefined
  evidenceStatus?: string | null | undefined
  errorMessage?: string | null | undefined
  error?: import('./contracts/turn-errors').TurnErrorDto | null | undefined
  evidence?: TaskEvidenceDto | null | undefined
  evidenceArtifactId?: string | null | undefined
  evidenceSummary?: string | null | undefined
  coreCode?: string | null | undefined
  referenceIds?: string[] | undefined
  referenceReason?: string | undefined
  assignedReferences?: TaskAssignedReference[] | undefined
}

export interface UnifiedSliceNode {
  id: string
  title: string
  description: string
  successCriteria: string
  order: number
  status: string
  runtimeStatus?: string | null | undefined
  verificationStatus?: string | null | undefined
  tasks: UnifiedTaskNode[]
}

export interface UnifiedMilestoneNode {
  id: string
  title: string
  description: string
  successCriteria: string
  order: number
  status: string
  verificationStatus?: string | null | undefined
  slices: UnifiedSliceNode[]
}

export interface UnifiedProgressTree {
  jobId: string
  title: string
  status: string
  milestones: UnifiedMilestoneNode[]
}

export interface FlatPlanTask {
  id: string
  milestoneIndex: number
  sliceIndex: number
  taskIndex: number
  title: string
  description: string
  taskKind: string
  abilityCode: string
  contextMarkdown: string
  successCriteria?: string | undefined
  coreCode?: string | undefined
  referenceIds?: string[] | undefined
  referenceReason?: string | undefined
  dependsOnTaskRefs?: string[] | undefined
  canRunInParallel?: boolean | undefined
}

export interface SavedPlanShape {
  milestones: Array<{
    title?: string | undefined
    description?: string | undefined
    successCriteria?: string | undefined
    slices: Array<{
      title?: string | undefined
      description?: string | undefined
      successCriteria?: string | undefined
      acceptanceSignals?: string[] | undefined
      expectedArtifacts?: string[] | undefined
      dependsOnSliceRefs?: string[] | undefined
      tasks: Array<{
        title?: string | undefined
        description?: string | undefined
        taskKind?: string | undefined
        abilityCode?: string | undefined
        dependsOnTaskRefs?: string[] | undefined
        canRunInParallel?: boolean | undefined
      }>
    }>
  }>
  tasks: FlatPlanTask[]
}

function resolveSliceSuccessCriteria(slice: {
  successCriteria?: string | undefined
  acceptanceSignals?: string[] | undefined
  expectedArtifacts?: string[] | undefined
}): string {
  if (slice.successCriteria?.trim()) return slice.successCriteria.trim()
  const parts = [
    ...(slice.acceptanceSignals ?? []).map((s) => `Acceptance: ${s}`),
    ...(slice.expectedArtifacts ?? []).map((a) => `Expected artifact: ${a}`)
  ]
  return parts.join('\n')
}

export interface TaskProgressItemShape {
  id: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
  abilityCode?: string | undefined
  executionStatus?: string | null | undefined
  evidenceStatus?: string | null | undefined
  errorMessage?: string | null | undefined
  error?: import('./contracts/turn-errors').TurnErrorDto | null | undefined
  evidence?: TaskEvidenceDto | null | undefined
  evidenceArtifactId?: string | null | undefined
  evidenceSummary?: string | null | undefined
  coreCode?: string | null | undefined
}

export interface BuildTreeInput {
  jobId: string
  title: string
  jobStatus: string
  plan: SavedPlanShape | null | undefined
  taskProgressItems?: TaskProgressItemShape[] | null | undefined

  currentTaskId?: string | null | undefined
  verification?:
    | {
        slices?:
          | Array<{
              id: string
              runtimeStatus?: string | null | undefined
              verificationStatus?: string | null | undefined
            }>
          | undefined
        milestones?:
          | Array<{ id: string; verificationStatus?: string | null | undefined }>
          | undefined
      }
    | null
    | undefined
  abilities?: Array<{ abilityCode: string; recommendedCoreCode?: string | undefined }> | undefined
  referenceManifest?: JobReferenceManifestDto | null | undefined
}

function taskKey(mIdx: number, sIdx: number, tIdx: number): string {
  return `m${mIdx}-s${sIdx}-t${tIdx}`
}

function resolvePlanStatus(jobStatus: string, hasContext: boolean): PlanUnitStatus {
  if (jobStatus === 'plan_ready' || jobStatus === 'running' || jobStatus === 'completed') {
    return 'queued'
  }
  if (jobStatus === 'planning') {
    if (hasContext) return 'planned'
    return 'pending'
  }
  return 'pending'
}

function mapExecutionStatus(
  item: TaskProgressItemShape | undefined,
  planStatus: PlanUnitStatus,
  options?: { isCurrentTask?: boolean; jobRunning?: boolean }
): Pick<
  UnifiedTaskNode,
  | 'status'
  | 'executionStatus'
  | 'evidenceStatus'
  | 'errorMessage'
  | 'error'
  | 'evidence'
  | 'evidenceArtifactId'
  | 'evidenceSummary'
  | 'coreCode'
> {
  if (!item) {
    return {
      status: planStatus === 'queued' ? 'pending' : 'pending',
      executionStatus: planStatus === 'queued' ? 'queued' : null,
      evidenceStatus: null,
      errorMessage: null,
      error: null,
      evidence: null,
      evidenceArtifactId: null,
      evidenceSummary: null,
      coreCode: null
    }
  }
  const treatAsRunning =
    options?.isCurrentTask === true &&
    options?.jobRunning === true &&
    (item.status === 'queued' || item.status === 'running' || item.executionStatus === 'running')
  const status = treatAsRunning
    ? 'in_progress'
    : item.status === 'running'
      ? 'in_progress'
      : item.status === 'queued'
        ? 'pending'
        : item.status
  return {
    status,
    executionStatus: treatAsRunning ? 'running' : (item.executionStatus ?? item.status),
    evidenceStatus: item.evidenceStatus ?? null,
    errorMessage: item.error?.message ?? item.errorMessage ?? null,
    error: item.error ?? null,
    evidence: item.evidence ?? null,
    evidenceArtifactId: item.evidenceArtifactId ?? null,
    evidenceSummary: item.evidenceSummary ?? item.evidence?.summary ?? null,
    coreCode: item.coreCode ?? null
  }
}

function sliceAggregateStatus(tasks: UnifiedTaskNode[]): string {
  if (tasks.length === 0) return 'pending'
  if (tasks.every((t) => t.status === 'completed' || t.status === 'skipped')) return 'completed'
  if (tasks.some((t) => t.status === 'in_progress')) return 'in_progress'
  if (tasks.some((t) => t.status === 'failed')) return 'failed'
  if (tasks.some((t) => t.status === 'completed')) return 'in_progress'
  return 'pending'
}

function sliceFullyVerified(slice: UnifiedSliceNode): boolean {
  return slice.runtimeStatus === 'progress-ok' || slice.verificationStatus === 'passed'
}

function sliceInVerification(slice: UnifiedSliceNode): boolean {
  return (
    slice.runtimeStatus === 'verifying' ||
    slice.runtimeStatus === 'ready-for-verification' ||
    slice.verificationStatus === 'verifying' ||
    slice.verificationStatus === 'ready-for-verification'
  )
}

function milestoneAggregateStatus(slices: UnifiedSliceNode[]): string {
  if (slices.length === 0) return 'pending'
  if (slices.every(sliceFullyVerified)) return 'completed'
  if (
    slices.some(
      (s) =>
        s.status === 'failed' ||
        s.runtimeStatus === 'verification-blocked' ||
        s.verificationStatus === 'blocked' ||
        s.verificationStatus === 'inconclusive'
    )
  ) {
    return 'failed'
  }
  if (
    slices.some(
      (s) =>
        s.status === 'in_progress' ||
        s.runtimeStatus === 'running' ||
        sliceInVerification(s) ||
        (s.status === 'completed' && !sliceFullyVerified(s))
    )
  ) {
    return 'in_progress'
  }
  return 'pending'
}

export function buildUnifiedProgressTree(input: BuildTreeInput): UnifiedProgressTree {
  const plan = input.plan
  if (!plan?.milestones?.length) {
    return { jobId: input.jobId, title: input.title, status: input.jobStatus, milestones: [] }
  }

  const flatById = new Map<string, FlatPlanTask>()
  for (const task of plan.tasks ?? []) {
    flatById.set(task.id, task)
  }

  const progressById = new Map<string, TaskProgressItemShape>()
  for (const item of input.taskProgressItems ?? []) {
    progressById.set(item.id, item)
  }

  const sliceProgress = new Map((input.verification?.slices ?? []).map((s) => [s.id, s]))
  const milestoneProgress = new Map((input.verification?.milestones ?? []).map((m) => [m.id, m]))

  const jobRunning =
    input.jobStatus === 'running' || input.jobStatus === 'pending' || input.jobStatus === 'paused'
  const currentTaskId = input.currentTaskId ?? null

  const milestones: UnifiedMilestoneNode[] = plan.milestones.map((milestone, mIdx) => {
    const mNum = mIdx + 1
    const slicesRaw = Array.isArray(milestone.slices) ? milestone.slices : []

    const slices: UnifiedSliceNode[] = slicesRaw.map((slice, sIdx) => {
      const sNum = sIdx + 1
      const sliceId = `m${mNum}-s${sNum}`
      const tasksRaw = Array.isArray(slice.tasks) ? slice.tasks : []

      const tasks: UnifiedTaskNode[] = tasksRaw.map((_task, tIdx) => {
        const tNum = tIdx + 1
        const id = taskKey(mNum, sNum, tNum)
        const flat = flatById.get(id)
        const progress = progressById.get(id)
        const hasContext = Boolean(flat?.contextMarkdown?.trim())
        const planStatus = resolvePlanStatus(input.jobStatus, hasContext)
        const exec = mapExecutionStatus(progress, planStatus, {
          isCurrentTask: currentTaskId === id,
          jobRunning
        })
        const referenceIds = flat?.referenceIds ?? []
        const assignedReferences = resolveAssignedReferencesFromDto(
          input.referenceManifest,
          referenceIds
        )

        return {
          id,
          title: flat?.title ?? String((_task as { title?: string }).title ?? id),
          description:
            flat?.description ?? String((_task as { description?: string }).description ?? ''),
          taskKind: flat?.taskKind ?? String((_task as { taskKind?: string }).taskKind ?? ''),
          abilityCode:
            flat?.abilityCode ?? String((_task as { abilityCode?: string }).abilityCode ?? ''),
          contextMarkdown: flat?.contextMarkdown ?? '',
          successCriteria: flat?.successCriteria?.trim() || resolveSliceSuccessCriteria(slice),
          order: tNum,
          planStatus,
          referenceIds: referenceIds.length > 0 ? referenceIds : undefined,
          referenceReason: flat?.referenceReason,
          assignedReferences: assignedReferences.length > 0 ? assignedReferences : undefined,
          ...exec,
          coreCode:
            flat?.coreCode?.trim() ||
            exec.coreCode ||
            input.abilities?.find((a) => a.abilityCode === flat?.abilityCode)
              ?.recommendedCoreCode ||
            null
        }
      })

      const sliceStatus = sliceAggregateStatus(tasks)
      const sliceRow = sliceProgress.get(sliceId)
      const allTasksDone = tasks.length > 0 && tasks.every((t) => t.status === 'completed')
      return {
        id: sliceId,
        title: slice.title?.trim() || '',
        description: slice.description ?? '',
        successCriteria: resolveSliceSuccessCriteria(slice),
        order: sNum,
        status: sliceRow?.runtimeStatus === 'progress-ok' ? 'completed' : sliceStatus,
        runtimeStatus:
          sliceRow?.runtimeStatus ??
          (allTasksDone
            ? 'ready-for-verification'
            : sliceStatus === 'in_progress'
              ? 'running'
              : null),
        verificationStatus: sliceRow?.verificationStatus ?? null,
        tasks
      }
    })

    const milestoneRow = milestoneProgress.get(`m${mNum}`)
    return {
      id: `m${mNum}`,
      title: milestone.title?.trim() || '',
      description: milestone.description ?? '',
      successCriteria: milestone.successCriteria?.trim() ?? '',
      order: mNum,
      status: milestoneAggregateStatus(slices),
      verificationStatus:
        milestoneRow?.verificationStatus ??
        (slices.length > 0 && slices.every((s) => s.runtimeStatus === 'progress-ok')
          ? 'ready-for-verification'
          : null),
      slices
    }
  })

  return {
    jobId: input.jobId,
    title: input.title,
    status: input.jobStatus,
    milestones
  }
}
