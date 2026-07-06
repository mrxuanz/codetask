import type { PlanProgressDto, TaskProgressDto } from '@shared/contracts/jobs'
import type {
  PlannerRegisteredPlan,
  PlannerRegisteredTaskContext,
  PlannerRegisteredSlice,
  SavedJobPlan
} from './plan-types'

function parseContextKey(key: string): { m: number; s: number; t: number } | null {
  const match = /^m(\d+)-s(\d+)-t(\d+)$/i.exec(key.trim())
  if (!match) return null
  return { m: Number(match[1]), s: Number(match[2]), t: Number(match[3]) }
}

function taskSuccessCriteria(taskSuccess: string | undefined, sliceSuccess: string): string {
  const trimmed = taskSuccess?.trim()
  return trimmed || sliceSuccess
}

export function buildPartialPlanFromContexts(
  contexts: Map<string, PlannerRegisteredTaskContext>
): SavedJobPlan {
  const entries = [...contexts.entries()]
    .map(([key, ctx]) => {
      const coords = parseContextKey(key)
      if (!coords) return null
      return { key, coords, ctx }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => {
      if (a.coords.m !== b.coords.m) return a.coords.m - b.coords.m
      if (a.coords.s !== b.coords.s) return a.coords.s - b.coords.s
      return a.coords.t - b.coords.t
    })

  const tasks: SavedJobPlan['tasks'] = entries.map(({ key, coords, ctx }) => ({
    id: key,
    milestoneIndex: coords.m,
    sliceIndex: coords.s,
    taskIndex: coords.t,
    title: ctx.taskTitle,
    description: '',
    taskKind: 'general-implementation',
    abilityCode: 'general-implementation',
    contextMarkdown: ctx.content,
    successCriteria: ''
  }))

  const milestoneMap = new Map<number, Map<number, SavedJobPlan['tasks']>>()
  for (const task of tasks) {
    if (!milestoneMap.has(task.milestoneIndex)) {
      milestoneMap.set(task.milestoneIndex, new Map())
    }
    const sliceMap = milestoneMap.get(task.milestoneIndex)!
    if (!sliceMap.has(task.sliceIndex)) {
      sliceMap.set(task.sliceIndex, [])
    }
    sliceMap.get(task.sliceIndex)!.push(task)
  }

  const milestones = [...milestoneMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, sliceMap]) => ({
      title: '',
      successCriteria: '',
      slices: [...sliceMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, sliceTasks]) => {
          const slice: PlannerRegisteredSlice = {
            title: '',
            successCriteria: '',
            tasks: sliceTasks
              .sort((a, b) => a.taskIndex - b.taskIndex)
              .map((task) => ({
                title: task.title,
                description: task.description,
                taskKind: task.taskKind,
                abilityCode: task.abilityCode
              }))
          }
          return slice
        })
    }))

  return { milestones, tasks }
}

export function flattenRegisteredPlan(
  plan: PlannerRegisteredPlan,
  contexts: Map<string, PlannerRegisteredTaskContext>
): SavedJobPlan {
  const tasks: SavedJobPlan['tasks'] = []

  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      slice.tasks.forEach((task, tIdx) => {
        const key = `m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`
        const context = contexts.get(key)
        tasks.push({
          id: key,
          milestoneIndex: mIdx + 1,
          sliceIndex: sIdx + 1,
          taskIndex: tIdx + 1,
          title: task.title ?? context?.taskTitle ?? key,
          description: task.description ?? '',
          taskKind: task.taskKind,
          abilityCode: task.abilityCode ?? 'general-implementation',
          contextMarkdown: context?.content ?? '',
          successCriteria: taskSuccessCriteria(task.successCriteria, slice.successCriteria),
          referenceIds: task.referenceIds?.length ? task.referenceIds : undefined,
          referenceReason: task.referenceReason,
          dependsOnTaskRefs: task.dependsOnTaskRefs,
          canRunInParallel: task.canRunInParallel
        })
      })
    })
  })

  return { milestones: plan.milestones, tasks }
}

export function defaultPlanProgress(): PlanProgressDto {
  return {
    phase: 'idle',
    status: 'pending',
    contextsRegistered: 0,
    contextsTotal: 0,
    message: null
  }
}

export function defaultTaskProgress(tasks: SavedJobPlan['tasks'] = []): TaskProgressDto {
  return {
    phase: 'idle',
    status: 'pending',
    currentIndex: 0,
    total: tasks.length,
    currentTaskId: null,
    message: null,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: 'queued',
      abilityCode: task.abilityCode,
      executionStatus: 'queued',
      evidenceStatus: null,
      errorMessage: null,
      coreCode: null
    }))
  }
}
