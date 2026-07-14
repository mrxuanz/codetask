export type PlanNodeRef =
  | { kind: 'milestone'; indices: [number] }
  | { kind: 'slice'; indices: [number, number] }
  | { kind: 'task'; indices: [number, number, number] }

export interface PlanNodeLookupPlan {
  tasks: Array<{
    id: string
    milestoneIndex: number
    sliceIndex: number
    taskIndex: number
  }>
}

export function resolvePlanNode(plan: PlanNodeLookupPlan, ref: string): PlanNodeRef | null {
  const task = plan.tasks.find((t) => t.id === ref)
  if (task) {
    return {
      kind: 'task',
      indices: [task.milestoneIndex - 1, task.sliceIndex - 1, task.taskIndex - 1]
    }
  }
  if (ref.startsWith('m') && ref.includes('-s')) {
    const [mStr, sStr] = ref.slice(1).split('-s')
    const m = Number(mStr)
    const s = Number(sStr)
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null
    return { kind: 'slice', indices: [m - 1, s - 1] }
  }
  if (ref.startsWith('m')) {
    const m = Number(ref.slice(1))
    if (!Number.isFinite(m)) return null
    return { kind: 'milestone', indices: [m - 1] }
  }
  return null
}
