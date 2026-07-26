import { planError } from './errors'
import type { PlanEdge, PlanNode, PlanNodeId } from './types'

/** Returns true when dependency edges form a cycle among the given nodes. */
export function detectCycle(
  nodes: readonly PlanNode[],
  edges: readonly PlanEdge[]
): boolean {
  const ids = new Set(nodes.map((n) => n.id))
  const adj = new Map<PlanNodeId, PlanNodeId[]>()
  for (const id of ids) adj.set(id, [])
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    adj.get(edge.from)!.push(edge.to)
  }

  const visiting = new Set<PlanNodeId>()
  const visited = new Set<PlanNodeId>()

  const dfs = (id: PlanNodeId): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of adj.get(id) ?? []) {
      if (dfs(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  for (const id of ids) {
    if (dfs(id)) return true
  }
  return false
}

export function assertAcyclic(
  nodes: readonly PlanNode[],
  edges: readonly PlanEdge[]
): void {
  if (detectCycle(nodes, edges)) {
    throw planError('plan.cycle', 'Plan dependency graph contains a cycle')
  }
}
