import type { TaskProgressDto, ThreadJobDto } from '../jobs/types'
import { slimTaskEvidence } from './evidence/store'
import { slimSliceVerdict } from '../retention/lifecycle-helpers'

export function slimTaskProgressForSse(progress: TaskProgressDto): TaskProgressDto {
  return {
    ...progress,
    tasks: progress.tasks.map((task) => ({
      ...task,
      evidence: task.evidence ? slimTaskEvidence(task.evidence) : task.evidence
    })),
    slices: progress.slices?.map((slice) => ({
      ...slice,
      verdict: slice.verdict ? slimSliceVerdict(slice.verdict) : slice.verdict
    }))
  }
}

export function slimJobForSse(job: ThreadJobDto): ThreadJobDto {
  return {
    ...job,
    taskProgress: slimTaskProgressForSse(job.taskProgress)
  }
}
