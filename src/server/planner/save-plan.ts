import type { PlanProgressDto, TaskProgressDto } from '@shared/contracts/jobs'
import type {
  PlannerRegisteredPlan,
  PlannerRegisteredTaskContext,
  SavedJobPlan
} from './plan-types'

function taskSuccessCriteria(taskSuccess: string | undefined, sliceSuccess: string): string {
  const trimmed = taskSuccess?.trim()
  return trimmed || sliceSuccess
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
