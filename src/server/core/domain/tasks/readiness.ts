import type { Task } from './types'

/**
 * A task is ready only when every dependency id is present in completedTaskIds.
 */
export function isTaskReady(task: Task, completedTaskIds: Set<string>): boolean {
  return task.dependencyIds.every((depId) => completedTaskIds.has(depId))
}
