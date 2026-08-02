import type { ExecutionTreeSnapshot } from '@codetask/contracts'
import { newId } from '../../shared.ts'
import { buildTreeFromOutline } from './planning.ts'

/** Legacy planner MCP outline + contexts → Design ExecutionTreeSnapshot (stable UUID node ids). */
export function registeredPlanToExecutionTree(input: {
  planningSessionId: string
  plan: {
    milestones: Array<{
      title?: string | undefined
      description?: string | undefined
      successCriteria?: string | undefined
      slices: Array<{
        title?: string | undefined
        description?: string | undefined
        successCriteria: string
        tasks: Array<{
          title?: string | undefined
          description?: string | undefined
          taskKind: string
          abilityCode?: string | undefined
          referenceIds?: string[] | undefined
          dependsOnTaskRefs?: string[] | undefined
          successCriteria?: string | undefined
          canRunInParallel?: boolean | undefined
        }>
      }>
    }>
  }
  contexts: Map<string, { taskTitle: string; content: string }>
  defaultCoreCode: string
}): ExecutionTreeSnapshot {
  const coordToId = new Map<string, string>()

  const milestones = input.plan.milestones.map((milestone, mIdx) => {
    const milestoneId = newId('ms')
    return {
      id: milestoneId,
      title: milestone.title?.trim() || `Milestone ${mIdx + 1}`,
      description: milestone.description?.trim() || '',
      successCriteria: milestone.successCriteria?.trim() || 'Milestone complete',
      slices: milestone.slices.map((slice, sIdx) => {
        const sliceId = newId('sl')
        return {
          id: sliceId,
          title: slice.title?.trim() || `Slice ${sIdx + 1}`,
          description: slice.description?.trim() || '',
          successCriteria: slice.successCriteria,
          tasks: slice.tasks.map((task, tIdx) => {
            const coord = `m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`
            const taskId = newId('tk')
            coordToId.set(coord, taskId)
            const context = input.contexts.get(coord)
            const taskSuccess = task.successCriteria?.trim()
            return {
              id: taskId,
              title: task.title?.trim() || context?.taskTitle || coord,
              description: task.description?.trim() || '',
              taskKind: task.taskKind,
              abilityCode: task.abilityCode ?? 'general-implementation',
              coreCode: input.defaultCoreCode,
              contextMarkdown: context?.content ?? '',
              successCriteria: taskSuccess || slice.successCriteria,
              referenceIds: task.referenceIds ?? [],
              dependsOnTaskIds: (task.dependsOnTaskRefs ?? [])
                .map((ref) => coordToId.get(ref))
                .filter((id): id is string => Boolean(id)),
              canRunInParallel: Boolean(task.canRunInParallel)
            }
          })
        }
      })
    }
  })

  // Second pass: dependsOn may reference later-declared coords in same outline.
  for (let mIdx = 0; mIdx < input.plan.milestones.length; mIdx += 1) {
    const milestone = input.plan.milestones[mIdx]!
    for (let sIdx = 0; sIdx < milestone.slices.length; sIdx += 1) {
      const slice = milestone.slices[sIdx]!
      for (let tIdx = 0; tIdx < slice.tasks.length; tIdx += 1) {
        const task = slice.tasks[tIdx]!
        const coord = `m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`
        const taskId = coordToId.get(coord)
        if (!taskId) continue
        const outTask = milestones[mIdx]!.slices[sIdx]!.tasks[tIdx]!
        outTask.dependsOnTaskIds = (task.dependsOnTaskRefs ?? [])
          .map((ref) => coordToId.get(ref))
          .filter((id): id is string => Boolean(id))
      }
    }
  }

  return buildTreeFromOutline({
    planningSessionId: input.planningSessionId,
    treeId: newId('tree'),
    revision: 0,
    milestones
  })
}
