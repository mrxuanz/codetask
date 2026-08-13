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
import { findExecutionTreeLimitViolation } from '@codetask/contracts'
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
      dependsOnSliceIds: string[]
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
        referenceReason: string
        requiredInputs: string[]
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
        dependsOnSliceIds: s.dependsOnSliceIds,
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
            referenceReason: t.referenceReason,
            requiredInputs: t.requiredInputs,
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
  const limitViolation = findExecutionTreeLimitViolation(input.tree)
  if (limitViolation) throw new DesignValidationError(limitViolation)
  const validProviders = new Set(['opencode', 'cursor', 'codex', 'claude'])
  const abilityCodes = new Set(input.abilities.map((a) => a.abilityCode))
  const refIds = new Set((input.manifest?.references ?? input.references).map((r) => r.id))
  const nodeIds = new Set<string>()
  const sliceIds = new Set<string>()
  const taskIds = new Set<string>()

  const requireUniqueNode = (id: string): void => {
    if (!id.trim()) throw new DesignValidationError('Execution tree contains an empty node id')
    if (nodeIds.has(id)) throw new DesignValidationError(`Duplicate node id ${id}`)
    nodeIds.add(id)
  }

  if (input.tree.milestones.length === 0) {
    throw new DesignValidationError('Execution tree must contain at least one milestone')
  }

  for (const milestone of input.tree.milestones) {
    requireUniqueNode(milestone.id)
    if (!milestone.title.trim() || !milestone.successCriteria.trim()) {
      throw new DesignValidationError(`Milestone ${milestone.id} is incomplete`)
    }
    if (milestone.slices.length === 0) {
      throw new DesignValidationError(`Milestone ${milestone.id} has no slices`)
    }
    for (const slice of milestone.slices) {
      requireUniqueNode(slice.id)
      sliceIds.add(slice.id)
      if (slice.milestoneId !== milestone.id) {
        throw new DesignValidationError(`Slice ${slice.id} has an invalid milestoneId`)
      }
      if (!slice.title.trim() || !slice.successCriteria.trim()) {
        throw new DesignValidationError(`Slice ${slice.id} is incomplete`)
      }
      if (slice.tasks.length === 0) {
        throw new DesignValidationError(`Slice ${slice.id} has no tasks`)
      }
      for (const task of slice.tasks) {
        requireUniqueNode(task.id)
        taskIds.add(task.id)
        if (task.sliceId !== slice.id) {
          throw new DesignValidationError(`Task ${task.id} has an invalid sliceId`)
        }
        if (!task.title.trim() || !task.taskKind.trim() || !task.successCriteria.trim()) {
          throw new DesignValidationError(`Task ${task.id} is incomplete`)
        }
        if (!abilityCodes.has(task.abilityCode)) {
          throw new DesignValidationError(`Unknown ability ${task.abilityCode}`)
        }
        if (!validProviders.has(task.coreCode.trim().toLowerCase())) {
          throw new DesignValidationError(`Unsupported provider ${task.coreCode}`)
        }
        if (new Set(task.referenceIds).size !== task.referenceIds.length) {
          throw new DesignValidationError(`Task ${task.id} has duplicate references`)
        }
        for (const refId of task.referenceIds) {
          if (!refIds.has(refId)) {
            throw new DesignValidationError(`Unknown reference ${refId}`)
          }
        }
        if (!task.contextMarkdown.trim()) {
          throw new DesignValidationError(`Task ${task.id} missing context`)
        }
        if (task.requiredInputs.some((value) => !value.trim())) {
          throw new DesignValidationError(`Task ${task.id} has an empty required input`)
        }
      }
    }
  }

  const sliceEdges = new Map<string, string[]>()
  const taskEdges = new Map<string, string[]>()
  for (const milestone of input.tree.milestones) {
    for (const slice of milestone.slices) {
      if (new Set(slice.dependsOnSliceIds).size !== slice.dependsOnSliceIds.length) {
        throw new DesignValidationError(`Slice ${slice.id} has duplicate dependencies`)
      }
      sliceEdges.set(slice.id, slice.dependsOnSliceIds)
      for (const dep of slice.dependsOnSliceIds) {
        if (!sliceIds.has(dep)) throw new DesignValidationError(`Unknown slice dependency ${dep}`)
        if (dep === slice.id) throw new DesignValidationError(`Slice ${slice.id} depends on itself`)
      }
      for (const task of slice.tasks) {
        if (new Set(task.dependsOnTaskIds).size !== task.dependsOnTaskIds.length) {
          throw new DesignValidationError(`Task ${task.id} has duplicate dependencies`)
        }
        taskEdges.set(task.id, task.dependsOnTaskIds)
        for (const dep of task.dependsOnTaskIds) {
          if (!taskIds.has(dep)) {
            throw new DesignValidationError(`Unknown dependency ${dep}`)
          }
          if (dep === task.id) throw new DesignValidationError(`Task ${task.id} depends on itself`)
        }
      }
    }
  }

  const assertAcyclic = (edges: Map<string, string[]>, label: string): void => {
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new DesignValidationError(`${label} dependencies contain a cycle`)
      if (visited.has(id)) return
      visiting.add(id)
      for (const dep of edges.get(id) ?? []) visit(dep)
      visiting.delete(id)
      visited.add(id)
    }
    for (const id of edges.keys()) visit(id)
  }
  assertAcyclic(sliceEdges, 'Slice')
  assertAcyclic(taskEdges, 'Task')
}
