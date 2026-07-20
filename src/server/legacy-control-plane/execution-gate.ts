import type { FlatPlanTask, SavedPlanShape } from '../../shared/plan-tree'

export const TASK_EVIDENCE_BASIC_FACTS_OK = 'basic-facts-ok'

export interface GateTaskState {
  id: string
  status: string
  executionStatus?: string | null | undefined
  evidenceStatus?: string | null | undefined
  order: number
  milestoneIndex: number
  sliceIndex: number
  taskIndex: number
  dependsOnTaskIds: string[]
  canRunInParallel: boolean
}

export interface GateSliceState {
  id: string
  milestoneId: string
  status: string
  runtimeStatus?: string | null | undefined
  verificationStatus?: string | null | undefined
  dependsOnSliceIds: string[]
  tasks: GateTaskState[]
}

export interface GateMilestoneState {
  id: string
  title: string
  status: string
  verificationStatus?: string | null | undefined
  sliceIds: string[]
}

const TERMINAL_UNIT = new Set(['completed', 'failed', 'skipped', 'cancelled', 'aborted', 'blocked'])
const BLOCKING_EXECUTION = new Set(['failed', 'blocked', 'cancelled', 'lost', 'timed-out'])

function normalizeRef(value: string): string {
  return value.trim().toLowerCase()
}

export function buildGateStates(plan: SavedPlanShape): {
  slices: GateSliceState[]
  tasks: GateTaskState[]
  milestones: GateMilestoneState[]
} {
  const refToId = new Map<string, string>()
  const tasks: GateTaskState[] = []

  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      const m = mIdx + 1
      const s = sIdx + 1
      slice.tasks.forEach((_task, tIdx) => {
        const id = `m${m}-s${s}-t${tIdx + 1}`
        refToId.set(normalizeRef(id), id)
      })
    })
  })

  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      const m = mIdx + 1
      const s = sIdx + 1
      slice.tasks.forEach((task, tIdx) => {
        const id = `m${m}-s${s}-t${tIdx + 1}`
        const flat = plan.tasks.find((item) => item.id === id)
        const dependsOnTaskIds = (task.dependsOnTaskRefs ?? flat?.dependsOnTaskRefs ?? [])
          .map((ref) => refToId.get(normalizeRef(ref)) ?? ref)
          .filter(Boolean)
        tasks.push({
          id,
          status: 'pending',
          executionStatus: 'queued',
          evidenceStatus: null,
          order: tIdx + 1,
          milestoneIndex: m,
          sliceIndex: s,
          taskIndex: tIdx + 1,
          dependsOnTaskIds,
          canRunInParallel: task.canRunInParallel === true || flat?.canRunInParallel === true
        })
      })
    })
  })

  const slices: GateSliceState[] = []
  const milestones: GateMilestoneState[] = []

  plan.milestones.forEach((milestone, mIdx) => {
    const mNum = mIdx + 1
    const milestoneId = `m${mNum}`
    const sliceIds: string[] = []
    milestone.slices.forEach((slice, sIdx) => {
      const sNum = sIdx + 1
      const sliceId = `m${mNum}-s${sNum}`
      sliceIds.push(sliceId)
      const dependsOnSliceIds = (slice.dependsOnSliceRefs ?? [])
        .map((ref) => {
          const normalized = normalizeRef(ref)
          if (refToId.has(normalized)) return ref
          return ref
        })
        .filter(Boolean)
      slices.push({
        id: sliceId,
        milestoneId,
        status: 'pending',
        runtimeStatus: null,
        verificationStatus: null,
        dependsOnSliceIds,
        tasks: tasks.filter((t) => t.milestoneIndex === mNum && t.sliceIndex === sNum)
      })
    })
    milestones.push({
      id: milestoneId,
      title: milestone.title?.trim() || '',
      status: 'pending',
      verificationStatus: null,
      sliceIds
    })
  })

  return { slices, tasks, milestones }
}

function findTask(tasks: GateTaskState[], id: string): GateTaskState | undefined {
  return tasks.find((t) => t.id === id)
}

function findSlice(slices: GateSliceState[], id: string): GateSliceState | undefined {
  return slices.find((s) => s.id === id)
}

function evaluateTaskDependency(dep: GateTaskState | undefined, depId: string): string | null {
  if (!dep) return `task dependency ${depId} is missing`
  if (dep.executionStatus && BLOCKING_EXECUTION.has(dep.executionStatus)) {
    return `task dependency ${depId} execution is ${dep.executionStatus}`
  }
  if (TERMINAL_UNIT.has(dep.status) && dep.status !== 'completed' && dep.status !== 'skipped') {
    return `task dependency ${depId} is ${dep.status}`
  }
  if (dep.status !== 'completed') {
    return `task dependency ${depId} is ${dep.status}`
  }
  if (dep.executionStatus !== 'completed') {
    return `task dependency ${depId} is completed but execution is ${dep.executionStatus ?? 'unknown'}`
  }
  if (dep.evidenceStatus !== TASK_EVIDENCE_BASIC_FACTS_OK) {
    return `task dependency ${depId} evidence is ${dep.evidenceStatus ?? 'not-submitted'}`
  }
  return null
}

function evaluateSliceDependency(slices: GateSliceState[], depId: string): string | null {
  const dep = findSlice(slices, depId)
  if (!dep) return `slice dependency ${depId} is missing`
  if (dep.runtimeStatus === 'progress-ok') return null
  if (dep.status === 'skipped') return null
  if (dep.status === 'completed' && (dep.runtimeStatus === 'progress-ok' || !dep.runtimeStatus)) {
    return null
  }
  return `slice dependency ${depId} is ${dep.runtimeStatus ?? dep.status}, not progress-ok`
}

function effectiveTaskDependencyIds(
  task: GateTaskState,
  target: GateTaskState,
  tasks: GateTaskState[]
): string[] {
  if (task.dependsOnTaskIds.length > 0) return task.dependsOnTaskIds
  if (task.canRunInParallel) return []
  if (
    task.milestoneIndex === target.milestoneIndex &&
    task.sliceIndex === target.sliceIndex &&
    task.order >= target.order
  ) {
    return []
  }
  return tasks
    .filter(
      (candidate) =>
        candidate.milestoneIndex === task.milestoneIndex &&
        candidate.sliceIndex === task.sliceIndex &&
        candidate.order < task.order
    )
    .map((candidate) => candidate.id)
}

/**
 * Explicit dependencies take precedence over the legacy implicit slice order.
 *
 * Task-level PREP/REPAIR recovery is appended to a slice and the blocked task is
 * changed to depend on it. Applying the ordinary "later tasks wait for every
 * earlier task" fallback to that injected prerequisite would close a cycle.
 * Detect the reverse dependency path (including implicit predecessors between
 * the blocked task and its recovery task) before applying the fallback edge.
 */
function hasEffectiveDependencyPath(
  fromTaskId: string,
  target: GateTaskState,
  tasksById: Map<string, GateTaskState>,
  allTasks: GateTaskState[],
  visiting: Set<string>,
  memo: Map<string, boolean>
): boolean {
  if (fromTaskId === target.id) return true
  const cached = memo.get(fromTaskId)
  if (cached !== undefined) return cached
  if (visiting.has(fromTaskId)) return false

  const from = tasksById.get(fromTaskId)
  if (!from) {
    memo.set(fromTaskId, false)
    return false
  }

  visiting.add(fromTaskId)
  const found = effectiveTaskDependencyIds(from, target, allTasks).some(
    (dependencyId) =>
      dependencyId === target.id ||
      hasEffectiveDependencyPath(dependencyId, target, tasksById, allTasks, visiting, memo)
  )
  visiting.delete(fromTaskId)
  memo.set(fromTaskId, found)
  return found
}

export function findNextReadyTask(
  slices: GateSliceState[],
  tasks: GateTaskState[]
): GateTaskState | null {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))

  for (const slice of slices) {
    if (TERMINAL_UNIT.has(slice.status) && slice.status !== 'completed') continue

    for (const depId of slice.dependsOnSliceIds) {
      const blocker = evaluateSliceDependency(slices, depId)
      if (blocker) continue
    }

    for (const task of slice.tasks) {
      if (task.status !== 'pending') continue

      const blockers: string[] = []
      for (const depId of slice.dependsOnSliceIds) {
        const msg = evaluateSliceDependency(slices, depId)
        if (msg) blockers.push(msg)
      }

      if (!task.canRunInParallel && task.dependsOnTaskIds.length === 0) {
        const dependencyPathMemo = new Map<string, boolean>()
        for (const pred of slice.tasks) {
          if (pred.order < task.order) {
            if (
              hasEffectiveDependencyPath(
                pred.id,
                task,
                tasksById,
                tasks,
                new Set(),
                dependencyPathMemo
              )
            ) {
              continue
            }
            const msg = evaluateTaskDependency(pred, pred.id)
            if (msg) blockers.push(msg)
          }
        }
      }

      for (const depId of task.dependsOnTaskIds) {
        const msg = evaluateTaskDependency(findTask(tasks, depId), depId)
        if (msg) blockers.push(msg)
      }

      if (blockers.length === 0) {
        return task
      }
    }
  }
  return null
}

export function applyTaskProgressToGate(
  gateTasks: GateTaskState[],
  items: Array<{
    id: string
    status: string
    executionStatus?: string | null | undefined
    evidenceStatus?: string | null | undefined
  }>
): void {
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const task of gateTasks) {
    const item = byId.get(task.id)
    if (!item) continue
    task.status =
      item.status === 'running' ? 'in_progress' : item.status === 'queued' ? 'pending' : item.status
    task.executionStatus = item.executionStatus ?? item.status
    task.evidenceStatus = item.evidenceStatus ?? null
  }
}

export function reconcileSliceStatuses(slices: GateSliceState[]): void {
  for (const slice of slices) {
    if (slice.tasks.length === 0) {
      slice.status = 'pending'
      continue
    }
    if (slice.runtimeStatus === 'progress-ok' || slice.runtimeStatus === 'verification-blocked') {
      slice.status = 'completed'
      continue
    }
    const allDone = slice.tasks.every((t) => t.status === 'completed' || t.status === 'skipped')
    const anyFailed = slice.tasks.some((t) => t.status === 'failed')
    const anyRunning = slice.tasks.some((t) => t.status === 'in_progress')
    if (anyFailed) {
      slice.status = 'failed'
    } else if (allDone) {
      slice.status = 'completed'
      if (!slice.runtimeStatus || slice.runtimeStatus === 'running') {
        slice.runtimeStatus = 'ready-for-verification'
      }
    } else if (anyRunning) {
      slice.status = 'in_progress'
      slice.runtimeStatus = 'running'
    } else {
      slice.status = 'pending'
    }
  }
}

export function reconcileMilestoneStatuses(
  milestones: GateMilestoneState[],
  slices: GateSliceState[]
): void {
  for (const milestone of milestones) {
    if (
      milestone.verificationStatus === 'blocked' ||
      milestone.verificationStatus === 'inconclusive'
    ) {
      milestone.status = 'failed'
      continue
    }
    if (milestone.verificationStatus === 'passed') {
      milestone.status = 'completed'
      continue
    }
    const milestoneSlices = milestone.sliceIds
      .map((id) => slices.find((s) => s.id === id))
      .filter((s): s is GateSliceState => Boolean(s))
    if (milestoneSlices.length === 0) {
      milestone.status = 'pending'
      continue
    }
    if (milestoneSlices.every((s) => s.runtimeStatus === 'progress-ok')) {
      milestone.status = 'completed'
      if (!milestone.verificationStatus) {
        milestone.verificationStatus = 'ready-for-verification'
      }
    } else if (milestoneSlices.some((s) => s.status === 'failed')) {
      milestone.status = 'failed'
    } else if (
      milestoneSlices.some((s) => s.status === 'in_progress' || s.runtimeStatus === 'running')
    ) {
      milestone.status = 'in_progress'
    } else {
      milestone.status = 'pending'
    }
  }
}

export function findSliceReadyForVerification(slices: GateSliceState[]): GateSliceState | null {
  for (const slice of slices) {
    if (slice.runtimeStatus !== 'ready-for-verification') continue
    if (slice.verificationStatus === 'passed') continue
    if (slice.verificationStatus === 'blocked') continue

    let blocked = false
    for (const depId of slice.dependsOnSliceIds) {
      if (evaluateSliceDependency(slices, depId)) {
        blocked = true
        break
      }
    }
    if (blocked) continue

    for (const task of slice.tasks) {
      if (task.status !== 'completed' && task.status !== 'skipped') {
        blocked = true
        break
      }
      if (task.evidenceStatus !== TASK_EVIDENCE_BASIC_FACTS_OK) {
        blocked = true
        break
      }
    }
    if (!blocked) return slice
  }
  return null
}

export function findMilestoneReadyForVerification(
  milestones: GateMilestoneState[],
  slices: GateSliceState[]
): GateMilestoneState | null {
  for (const milestone of milestones) {
    if (
      milestone.verificationStatus === 'blocked' ||
      milestone.verificationStatus === 'inconclusive'
    ) {
      continue
    }
    if (milestone.verificationStatus !== 'ready-for-verification') continue
    const milestoneSlices = milestone.sliceIds
      .map((id) => slices.find((s) => s.id === id))
      .filter((s): s is GateSliceState => Boolean(s))
    if (!milestoneSlices.every((s) => s.runtimeStatus === 'progress-ok')) continue
    return milestone
  }
  return null
}

export function isWorkflowComplete(
  milestones: GateMilestoneState[],
  slices: GateSliceState[]
): boolean {
  return (
    milestones.length > 0 &&
    milestones.every((m) => m.verificationStatus === 'passed') &&
    slices.every((s) => s.runtimeStatus === 'progress-ok')
  )
}

export function applyVerificationProgress(
  slices: GateSliceState[],
  milestones: GateMilestoneState[],
  progress?:
    | {
        slices?:
          | Array<{
              id: string
              runtimeStatus?: string | null | undefined
              verificationStatus?: string | null | undefined
              verdict?:
                | import('@shared/contracts/evidence').SliceVerificationRecordDto
                | null
                | undefined
            }>
          | undefined
        milestones?:
          | Array<{ id: string; verificationStatus?: string | null | undefined }>
          | undefined
      }
    | null
    | undefined
): void {
  if (!progress) return
  for (const row of progress.slices ?? []) {
    const slice = slices.find((s) => s.id === row.id)
    if (!slice) continue
    if (row.runtimeStatus) slice.runtimeStatus = row.runtimeStatus
    if (row.verificationStatus) slice.verificationStatus = row.verificationStatus
  }
  for (const row of progress.milestones ?? []) {
    const milestone = milestones.find((m) => m.id === row.id)
    if (!milestone) continue
    if (row.verificationStatus) milestone.verificationStatus = row.verificationStatus
  }
}

export function exportVerificationProgress(
  slices: GateSliceState[],
  milestones: GateMilestoneState[],
  existing?: {
    slices?:
      | Array<{
          id: string
          verdict?:
            | import('@shared/contracts/evidence').SliceVerificationRecordDto
            | null
            | undefined
        }>
      | undefined
  }
): {
  slices: Array<{
    id: string
    runtimeStatus?: string | null | undefined
    verificationStatus?: string | null | undefined
    verdict?: import('@shared/contracts/evidence').SliceVerificationRecordDto | null | undefined
  }>
  milestones: Array<{ id: string; verificationStatus?: string | null | undefined }>
} {
  return {
    slices: slices.map((s) => {
      const prev = existing?.slices?.find((row) => row.id === s.id)
      return {
        id: s.id,
        runtimeStatus: s.runtimeStatus,
        verificationStatus: s.verificationStatus,
        verdict: prev?.verdict ?? null
      }
    }),
    milestones: milestones.map((m) => ({
      id: m.id,
      verificationStatus: m.verificationStatus
    }))
  }
}

export function findFlatTask(plan: SavedPlanShape, taskId: string): FlatPlanTask | undefined {
  return plan.tasks.find((t) => t.id === taskId)
}
