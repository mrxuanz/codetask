import { assertAcyclic } from './dag'
import { planError } from './errors'
import type { Plan, PlanEdge, PlanNode, PlanNodeId } from './types'

function assertUniqueNodeIds(nodes: readonly PlanNode[]): void {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (!node.id) {
      throw planError('plan.invalid_node', 'Plan node is missing id')
    }
    if (!node.title) {
      throw planError('plan.invalid_node', `Plan node ${node.id} is missing title`, {
        nodeId: node.id
      })
    }
    if (seen.has(node.id)) {
      throw planError('plan.duplicate_node', `Duplicate plan node id: ${node.id}`, {
        nodeId: node.id
      })
    }
    seen.add(node.id)
  }
}

function assertParentsExist(nodes: readonly PlanNode[]): void {
  const ids = new Set(nodes.map((n) => n.id))
  for (const node of nodes) {
    if (node.parentId != null && !ids.has(node.parentId)) {
      throw planError(
        'plan.invalid_parent',
        `Node ${node.id} references missing parent ${node.parentId}`,
        { nodeId: node.id, parentId: node.parentId }
      )
    }
  }
}

function assertEdgesValid(nodes: readonly PlanNode[], edges: readonly PlanEdge[]): void {
  const ids = new Set<PlanNodeId>(nodes.map((n) => n.id))
  const seen = new Set<string>()
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw planError(
        'plan.invalid_edge',
        `Edge ${edge.from} -> ${edge.to} references missing node`,
        { from: edge.from, to: edge.to }
      )
    }
    if (edge.from === edge.to) {
      throw planError('plan.self_dependency', `Node ${edge.from} cannot depend on itself`, {
        nodeId: edge.from
      })
    }
    const key = `${edge.from}->${edge.to}`
    if (seen.has(key)) {
      throw planError('plan.duplicate_edge', `Duplicate edge ${key}`, {
        from: edge.from,
        to: edge.to
      })
    }
    seen.add(key)
  }
}

function assertHasTasks(nodes: readonly PlanNode[]): void {
  if (!nodes.some((n) => n.kind === 'task')) {
    throw planError('plan.no_tasks', 'Plan must contain at least one task node')
  }
}

/** Validates plan structure, acyclicity, and non-empty tasks. Throws PlanDomainError. */
export function validatePlan(plan: Plan): void {
  assertUniqueNodeIds(plan.nodes)
  assertParentsExist(plan.nodes)
  assertEdgesValid(plan.nodes, plan.edges)
  assertHasTasks(plan.nodes)
  assertAcyclic(plan.nodes, plan.edges)
}
