import type {
  PlannerRegisteredMilestone,
  PlannerRegisteredPlan,
  PlannerRegisteredSlice,
  PlannerRegisteredTask,
  PlannerRegisteredTaskContext
} from '../plan-types'
import {
  collectPlanReferenceIds,
  validateReferenceCoverage,
  type JobReferenceManifest
} from '@shared/job-references'

const TASK_KINDS = new Set([
  'project-setup',
  'dependency-management',
  'scaffolding',
  'backend-implementation',
  'frontend-implementation',
  'data-modeling',
  'testing-validation',
  'documentation-handoff',
  'general-implementation'
])

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolveSuccessCriteria(obj: Record<string, unknown>): string {
  const direct = nonEmptyString(obj.successCriteria)
  if (direct) return direct
  const legacySignals = stringList(obj.acceptanceSignals)
  const legacyArtifacts = stringList(obj.expectedArtifacts)
  const parts = [
    ...legacySignals.map((s) => `Acceptance: ${s}`),
    ...legacyArtifacts.map((a) => `Expected artifact: ${a}`)
  ]
  return parts.join('\n')
}

export function normalizeRegisteredPlan(value: unknown): PlannerRegisteredPlan {
  if (!value || typeof value !== 'object') {
    throw new Error('milestones must be a non-empty array')
  }
  const milestonesRaw = (value as Record<string, unknown>).milestones
  if (!Array.isArray(milestonesRaw) || milestonesRaw.length === 0) {
    throw new Error('milestones must be a non-empty array')
  }

  const milestones: PlannerRegisteredMilestone[] = milestonesRaw.map((milestone, mIdx) => {
    if (!milestone || typeof milestone !== 'object') {
      throw new Error(`milestones[${mIdx}] must be an object`)
    }
    const mobj = milestone as Record<string, unknown>
    const slicesRaw = mobj.slices
    if (!Array.isArray(slicesRaw) || slicesRaw.length === 0) {
      throw new Error(`milestones[${mIdx}].slices must be a non-empty array`)
    }

    const slices: PlannerRegisteredSlice[] = slicesRaw.map((slice, sIdx) => {
      if (!slice || typeof slice !== 'object') {
        throw new Error(`milestones[${mIdx}].slices[${sIdx}] must be an object`)
      }
      const sobj = slice as Record<string, unknown>
      const tasksRaw = sobj.tasks
      if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
        throw new Error(`milestones[${mIdx}].slices[${sIdx}].tasks must be a non-empty array`)
      }

      const tasks: PlannerRegisteredTask[] = tasksRaw.map((task, tIdx) => {
        if (!task || typeof task !== 'object') {
          throw new Error(`task at m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1} must be an object`)
        }
        const tobj = task as Record<string, unknown>
        const taskKind = nonEmptyString(tobj.taskKind)
        if (!taskKind || !TASK_KINDS.has(taskKind)) {
          throw new Error(`taskKind is required at m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`)
        }
        const title = nonEmptyString(tobj.title)
        const description = nonEmptyString(tobj.description)
        if (!title || !description) {
          throw new Error(
            `title and description required at m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`
          )
        }
        const abilityCode = nonEmptyString(tobj.abilityCode)
        if (!abilityCode) {
          throw new Error(`abilityCode required at m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`)
        }
        return {
          title,
          description,
          taskKind,
          abilityCode,
          referenceIds: stringList(tobj.referenceIds),
          referenceReason: nonEmptyString(tobj.referenceReason) ?? undefined,
          dependsOnTaskRefs: stringList(tobj.dependsOnTaskRefs),
          requiredInputs: stringList(tobj.requiredInputs),
          successCriteria: resolveSuccessCriteria(tobj) || undefined,
          canRunInParallel: tobj.canRunInParallel === true
        }
      })

      const successCriteria = resolveSuccessCriteria(sobj)
      if (!successCriteria) {
        throw new Error(`slice m${mIdx + 1}-s${sIdx + 1} needs successCriteria`)
      }

      return {
        title: nonEmptyString(sobj.title) ?? undefined,
        description: nonEmptyString(sobj.description) ?? undefined,
        successCriteria,
        dependsOnSliceRefs: stringList(sobj.dependsOnSliceRefs),
        tasks
      }
    })

    const successCriteria = resolveSuccessCriteria(mobj)
    if (!successCriteria) {
      throw new Error(`milestone[${mIdx}] needs successCriteria`)
    }

    return {
      title: nonEmptyString(mobj.title) ?? undefined,
      description: nonEmptyString(mobj.description) ?? undefined,
      successCriteria,
      slices
    }
  })

  return { milestones }
}

export function listMissingTaskContexts(
  plan: PlannerRegisteredPlan,
  contexts: Map<string, PlannerRegisteredTaskContext>
): string[] {
  const missing: string[] = []
  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      slice.tasks.forEach((_task, tIdx) => {
        const key = `m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`
        if (!contexts.has(key)) missing.push(key)
      })
    })
  })
  return missing
}

export function countPlanUnits(plan: PlannerRegisteredPlan): {
  milestones: number
  slices: number
  tasks: number
} {
  let slices = 0
  let tasks = 0
  for (const milestone of plan.milestones) {
    slices += milestone.slices.length
    for (const slice of milestone.slices) {
      tasks += slice.tasks.length
    }
  }
  return { milestones: plan.milestones.length, slices, tasks }
}

export function validatePlanShape(plan: PlannerRegisteredPlan): void {
  const counts = countPlanUnits(plan)
  if (counts.milestones === 0 || counts.slices === 0 || counts.tasks === 0) {
    throw new Error('plan must contain at least one milestone, slice, and task')
  }
  if (counts.milestones === 1 && counts.slices === 1 && counts.tasks === 1) {
    throw new Error(
      'plan has only 1 milestone / 1 slice / 1 task. Break the work into multiple milestones, slices, and small tasks per the planner prompt.'
    )
  }
  if (counts.tasks <= 2) {
    throw new Error(
      `plan has only ${counts.tasks} tasks. Break scaffolding, per-component implementation, styling, and integration into separate small tasks (~10 minutes each).`
    )
  }
  const hasFrontendOrBackend = plan.milestones.some((milestone) =>
    milestone.slices.some((slice) =>
      slice.tasks.some((task) =>
        ['frontend-implementation', 'backend-implementation', 'data-modeling'].includes(
          task.taskKind
        )
      )
    )
  )
  if (hasFrontendOrBackend && counts.tasks < 3) {
    throw new Error(
      'implementation work must be split into at least 3 small tasks (e.g. scaffold, component/file units, composition/integration).'
    )
  }
}

export function validatePlanOutlineCompleteness(plan: PlannerRegisteredPlan): void {
  const issues: string[] = []
  plan.milestones.forEach((milestone, mIdx) => {
    const milestoneRef = `m${mIdx + 1}`
    if (!milestone.title?.trim()) issues.push(`${milestoneRef}.title`)
    if (!milestone.description?.trim()) issues.push(`${milestoneRef}.description`)
    milestone.slices.forEach((slice, sIdx) => {
      const sliceRef = `${milestoneRef}-s${sIdx + 1}`
      if (!slice.title?.trim()) issues.push(`${sliceRef}.title`)
      if (!slice.description?.trim()) issues.push(`${sliceRef}.description`)
      slice.tasks.forEach((task, tIdx) => {
        const taskRef = `${sliceRef}-t${tIdx + 1}`
        if (!task.successCriteria?.trim()) {
          issues.push(`${taskRef}.successCriteria`)
        }
        if ((task.referenceIds?.length ?? 0) > 0 && !task.referenceReason?.trim()) {
          issues.push(`${taskRef}.referenceReason`)
        }
      })
    })
  })
  if (issues.length > 0) {
    throw new Error(`plan outline is incomplete; missing required values at: ${issues.join(', ')}`)
  }
}

function normalizePlannerRef(value: string): string {
  return value.trim().toLowerCase()
}

interface SliceCoord {
  milestone: number
  slice: number
}

interface TaskCoord {
  slice: SliceCoord
  task: number
}

function buildPlannerRefGraph(plan: PlannerRegisteredPlan): {
  sliceCoords: Map<string, SliceCoord>
  taskCoords: Map<string, TaskCoord>
} {
  const sliceCoords = new Map<string, SliceCoord>()
  const taskCoords = new Map<string, TaskCoord>()

  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      const coord: SliceCoord = { milestone: mIdx + 1, slice: sIdx + 1 }
      const sliceRef = `m${coord.milestone}-s${coord.slice}`
      sliceCoords.set(normalizePlannerRef(sliceRef), coord)
      slice.tasks.forEach((_task, tIdx) => {
        const taskRef = `${sliceRef}-t${tIdx + 1}`
        taskCoords.set(normalizePlannerRef(taskRef), { slice: coord, task: tIdx + 1 })
      })
    })
  })

  return { sliceCoords, taskCoords }
}

function taskComesBefore(dependency: TaskCoord, current: TaskCoord): boolean {
  if (dependency.slice.milestone !== current.slice.milestone) {
    return dependency.slice.milestone < current.slice.milestone
  }
  if (dependency.slice.slice !== current.slice.slice) {
    return dependency.slice.slice < current.slice.slice
  }
  return dependency.task < current.task
}

function resolveSliceRef(
  sliceCoords: Map<string, SliceCoord>,
  sliceRef: string,
  at: SliceCoord
): SliceCoord {
  const coord = sliceCoords.get(normalizePlannerRef(sliceRef))
  if (!coord) {
    throw new Error(`unknown slice ref "${sliceRef}" referenced from m${at.milestone}-s${at.slice}`)
  }
  return coord
}

function countInitiallyReadySliceRoots(plan: PlannerRegisteredPlan): number {
  let readyRoots = 0
  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      if (slice.tasks.length === 0) return
      const current: SliceCoord = { milestone: mIdx + 1, slice: sIdx + 1 }
      if (slice.dependsOnSliceRefs && slice.dependsOnSliceRefs.length > 0) return

      const firstTask = slice.tasks[0]
      if (!firstTask) return
      const { taskCoords } = buildPlannerRefGraph(plan)
      let blockedByCrossSliceTask = false
      for (const taskRef of firstTask.dependsOnTaskRefs ?? []) {
        const dep = taskCoords.get(normalizePlannerRef(taskRef))
        if (
          !dep ||
          dep.slice.milestone !== current.milestone ||
          dep.slice.slice !== current.slice
        ) {
          blockedByCrossSliceTask = true
          break
        }
      }
      if (!blockedByCrossSliceTask) readyRoots += 1
    })
  })
  return readyRoots
}

export function validateRegisteredPlanDependencyGraph(plan: PlannerRegisteredPlan): void {
  const sliceCount = plan.milestones.reduce((sum, milestone) => sum + milestone.slices.length, 0)

  const { sliceCoords, taskCoords } = buildPlannerRefGraph(plan)

  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      const current: SliceCoord = { milestone: mIdx + 1, slice: sIdx + 1 }
      for (const sliceRef of slice.dependsOnSliceRefs ?? []) {
        const dependency = resolveSliceRef(sliceCoords, sliceRef, current)
        if (dependency.milestone === current.milestone && dependency.slice === current.slice) {
          throw new Error(`slice ${sliceRef} cannot depend on itself via dependsOnSliceRefs`)
        }
        if (
          dependency.milestone > current.milestone ||
          (dependency.milestone === current.milestone && dependency.slice >= current.slice)
        ) {
          throw new Error(
            `slice m${current.milestone}-s${current.slice} depends on later or same slice ${sliceRef}; dependsOnSliceRefs must point to earlier slices only`
          )
        }
      }
      slice.tasks.forEach((task, tIdx) => {
        const currentTask: TaskCoord = {
          slice: current,
          task: tIdx + 1
        }
        for (const taskRef of task.dependsOnTaskRefs ?? []) {
          const dependency = taskCoords.get(normalizePlannerRef(taskRef))
          if (!dependency) {
            throw new Error(
              `unknown task ref "${taskRef}" referenced from m${current.milestone}-s${current.slice}-t${tIdx + 1}`
            )
          }
          if (!taskComesBefore(dependency, currentTask)) {
            throw new Error(
              `task m${current.milestone}-s${current.slice}-t${tIdx + 1} depends on later or same task ${taskRef}; dependsOnTaskRefs must point to earlier tasks only`
            )
          }
        }
      })
    })
  })

  const initiallyReadyRoots = sliceCount > 1 ? countInitiallyReadySliceRoots(plan) : 0
  if (initiallyReadyRoots > 1) {
    throw new Error(
      `multi-slice plan would expose ${initiallyReadyRoots} concurrently ready slice roots (expected at most 1). Add dependsOnSliceRefs so only one slice can start first, e.g. m1-s2 -> ["m1-s1"].`
    )
  }
}

export function validatePlanReferenceIds(
  plan: PlannerRegisteredPlan,
  validReferenceIds: string[],
  manifest?: JobReferenceManifest | null
): void {
  const available = new Set(validReferenceIds)
  const invalid: string[] = []
  let taskCount = 0
  let assignedTaskCount = 0

  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      slice.tasks.forEach((task, tIdx) => {
        taskCount += 1
        const referenceIds = task.referenceIds ?? []
        if (referenceIds.length > 0) assignedTaskCount += 1
        for (const referenceId of referenceIds) {
          if (!available.has(referenceId)) {
            invalid.push(
              `m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1} "${task.title}" requested unknown referenceId "${referenceId}"`
            )
          }
        }
      })
    })
  })

  if (invalid.length > 0) {
    if (available.size === 0) {
      throw new Error(
        `invalid task referenceIds. No frozen draft referenceIds are available; every task.referenceIds must be [] or omitted. Errors: ${invalid.join('; ')}`
      )
    }
    throw new Error(
      `invalid task referenceIds. Available referenceIds: [${validReferenceIds.join(', ')}]. Errors: ${invalid.join('; ')}`
    )
  }

  if (available.size > 0 && taskCount > 0 && assignedTaskCount === 0) {
    throw new Error(
      `frozen references exist but no task received referenceIds. Available referenceIds: [${validReferenceIds.join(', ')}]`
    )
  }

  if (manifest) {
    const coverageErrors = validateReferenceCoverage(collectPlanReferenceIds(plan), manifest)
    if (coverageErrors.length > 0) {
      throw new Error(`incomplete reference coverage. ${coverageErrors.join('; ')}`)
    }
  }
}
