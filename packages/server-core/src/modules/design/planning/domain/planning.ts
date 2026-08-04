import type {
  DraftAbility,
  DraftReference,
  ExecutionMilestone,
  ExecutionProfile,
  ExecutionSlice,
  ExecutionTask,
  ExecutionTreeSnapshot,
  PlanningSessionStatus,
  ReferenceManifest
} from '@codetask/contracts'
import { DesignValidationError } from '../../shared.ts'

export type PlanningSessionRecord = {
  id: string
  actorId: string
  projectId: string
  sourceDraftId: string
  draftSnapshotJson: string
  referenceSnapshotId: string | null
  executionProfile: ExecutionProfile
  plannerSettingsSnapshotJson: string
  plannerSettingsHash: string
  status: PlanningSessionStatus
  activeRunId: string | null
  treeRevision: number
  publishedJobId: string | null
  lastErrorJson: string | null
  createdAt: number
  updatedAt: number
  publishedAt: number | null
}

export type PlanningRunRecord = {
  id: string
  planningSessionId: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  attemptNo: number
  provider: string
  model: string | null
  fencingToken: string
  startedAt: number
  finishedAt: number | null
  errorJson: string | null
}

const ACTIVE_PLANNING = new Set<PlanningSessionStatus>([
  'queued',
  'planning',
  'plan_editing',
  'ready_to_publish',
  'publishing'
])

export function isActivePlanningStatus(status: PlanningSessionStatus): boolean {
  return ACTIVE_PLANNING.has(status)
}

export function assertTransition(from: PlanningSessionStatus, to: PlanningSessionStatus): void {
  const allowed: Record<PlanningSessionStatus, PlanningSessionStatus[]> = {
    queued: ['planning', 'cancelled'],
    planning: ['plan_editing', 'failed', 'cancelled'],
    plan_editing: ['ready_to_publish', 'queued', 'cancelled'],
    ready_to_publish: ['publishing', 'plan_editing', 'cancelled'],
    publishing: ['published', 'failed'],
    published: [],
    failed: ['queued', 'cancelled'],
    cancelled: []
  }
  if (!allowed[from].includes(to)) {
    throw new DesignValidationError(`Invalid planning transition ${from} → ${to}`)
  }
}

export function allNodesConfirmed(tree: ExecutionTreeSnapshot): boolean {
  for (const milestone of tree.milestones) {
    if (!milestone.confirmed) return false
    for (const slice of milestone.slices) {
      if (!slice.confirmed) return false
      for (const task of slice.tasks) {
        if (!task.confirmed) return false
      }
    }
  }
  return tree.milestones.length > 0
}

export function buildTreeFromOutline(input: {
  planningSessionId: string
  treeId: string
  revision: number
  milestones: Array<{
    id: string
    title: string
    description: string
    successCriteria: string
    slices: Array<{
      id: string
      title: string
      description: string
      successCriteria: string
      tasks: Array<{
        id: string
        title: string
        description: string
        taskKind: string
        abilityCode: string
        coreCode: string
        contextMarkdown: string
        successCriteria: string
        referenceIds: string[]
        dependsOnTaskIds: string[]
        canRunInParallel: boolean
      }>
    }>
  }>
}): ExecutionTreeSnapshot {
  const milestones: ExecutionMilestone[] = input.milestones.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    successCriteria: m.successCriteria,
    confirmed: false,
    slices: m.slices.map(
      (s): ExecutionSlice => ({
        id: s.id,
        milestoneId: m.id,
        title: s.title,
        description: s.description,
        successCriteria: s.successCriteria,
        confirmed: false,
        tasks: s.tasks.map(
          (t): ExecutionTask => ({
            id: t.id,
            sliceId: s.id,
            title: t.title,
            description: t.description,
            taskKind: t.taskKind,
            abilityCode: t.abilityCode,
            coreCode: t.coreCode,
            contextMarkdown: t.contextMarkdown,
            successCriteria: t.successCriteria,
            referenceIds: t.referenceIds,
            dependsOnTaskIds: t.dependsOnTaskIds,
            canRunInParallel: t.canRunInParallel,
            confirmed: false
          })
        )
      })
    )
  }))

  return {
    treeId: input.treeId,
    planningSessionId: input.planningSessionId,
    revision: input.revision,
    milestones
  }
}

export function validateTreeAgainstDraft(input: {
  tree: ExecutionTreeSnapshot
  abilities: DraftAbility[]
  references: DraftReference[]
  manifest: ReferenceManifest | null
}): void {
  const abilityCodes = new Set(input.abilities.map((a) => a.abilityCode))
  const refIds = new Set((input.manifest?.references ?? input.references).map((r) => r.id))
  const taskIds = new Set<string>()

  for (const milestone of input.tree.milestones) {
    for (const slice of milestone.slices) {
      for (const task of slice.tasks) {
        if (taskIds.has(task.id)) {
          throw new DesignValidationError(`Duplicate task id ${task.id}`)
        }
        taskIds.add(task.id)
        if (!abilityCodes.has(task.abilityCode)) {
          throw new DesignValidationError(`Unknown ability ${task.abilityCode}`)
        }
        for (const refId of task.referenceIds) {
          if (!refIds.has(refId)) {
            throw new DesignValidationError(`Unknown reference ${refId}`)
          }
        }
        if (!task.contextMarkdown.trim()) {
          throw new DesignValidationError(`Task ${task.id} missing context`)
        }
      }
    }
  }

  for (const milestone of input.tree.milestones) {
    for (const slice of milestone.slices) {
      for (const task of slice.tasks) {
        for (const dep of task.dependsOnTaskIds) {
          if (!taskIds.has(dep)) {
            throw new DesignValidationError(`Unknown dependency ${dep}`)
          }
        }
      }
    }
  }
}
