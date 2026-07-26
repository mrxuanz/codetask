import { planError } from './errors'
import type { PlanOperation } from './operations'
import type { Plan, PlanEdge, PlanNode, PlanNodeId, PlanRevision } from './types'
import { asPlanRevision } from './types'

function assertMutable(plan: Plan): void {
  if (plan.status === 'confirmed') {
    throw planError(
      'plan.immutable',
      'Confirmed plan cannot be modified; create a new revision flow instead',
      { planId: plan.id, executionGeneration: plan.executionGeneration }
    )
  }
}

function bumpRevision(plan: Plan): PlanRevision {
  return asPlanRevision(Number(plan.revision) + 1)
}

function findNodeIndex(nodes: readonly PlanNode[], nodeId: PlanNodeId): number {
  return nodes.findIndex((n) => n.id === nodeId)
}

function edgeKey(edge: PlanEdge): string {
  return `${edge.from}->${edge.to}`
}

function applyAddNode(plan: Plan, node: PlanNode): Plan {
  if (findNodeIndex(plan.nodes, node.id) >= 0) {
    throw planError('plan.duplicate_node', `Node ${node.id} already exists`, { nodeId: node.id })
  }
  if (node.parentId != null && findNodeIndex(plan.nodes, node.parentId) < 0) {
    throw planError('plan.invalid_parent', `Parent ${node.parentId} not found`, {
      parentId: node.parentId
    })
  }
  return {
    ...plan,
    revision: bumpRevision(plan),
    nodes: [...plan.nodes, node]
  }
}

function applyRemoveNode(plan: Plan, nodeId: PlanNodeId): Plan {
  if (findNodeIndex(plan.nodes, nodeId) < 0) {
    throw planError('plan.node_not_found', `Node ${nodeId} not found`, { nodeId })
  }
  const nodes = plan.nodes.filter((n) => n.id !== nodeId && n.parentId !== nodeId)
  const edges = plan.edges.filter((e) => e.from !== nodeId && e.to !== nodeId)
  return {
    ...plan,
    revision: bumpRevision(plan),
    nodes,
    edges
  }
}

function applyUpdateNode(
  plan: Plan,
  nodeId: PlanNodeId,
  patch: Extract<PlanOperation, { type: 'update_node' }>['patch']
): Plan {
  const index = findNodeIndex(plan.nodes, nodeId)
  if (index < 0) {
    throw planError('plan.node_not_found', `Node ${nodeId} not found`, { nodeId })
  }
  if (patch.parentId != null && findNodeIndex(plan.nodes, patch.parentId) < 0) {
    throw planError('plan.invalid_parent', `Parent ${patch.parentId} not found`, {
      parentId: patch.parentId
    })
  }
  const current = plan.nodes[index]!
  const updated: PlanNode = {
    ...current,
    ...patch,
    id: current.id
  }
  const nodes = [...plan.nodes]
  nodes[index] = updated
  return {
    ...plan,
    revision: bumpRevision(plan),
    nodes
  }
}

function applyAddEdge(plan: Plan, edge: PlanEdge): Plan {
  if (findNodeIndex(plan.nodes, edge.from) < 0 || findNodeIndex(plan.nodes, edge.to) < 0) {
    throw planError('plan.invalid_edge', `Edge endpoints missing for ${edgeKey(edge)}`, {
      from: edge.from,
      to: edge.to
    })
  }
  if (plan.edges.some((e) => e.from === edge.from && e.to === edge.to)) {
    throw planError('plan.duplicate_edge', `Edge ${edgeKey(edge)} already exists`, {
      from: edge.from,
      to: edge.to
    })
  }
  return {
    ...plan,
    revision: bumpRevision(plan),
    edges: [...plan.edges, edge]
  }
}

function applyRemoveEdge(plan: Plan, from: PlanNodeId, to: PlanNodeId): Plan {
  const next = plan.edges.filter((e) => !(e.from === from && e.to === to))
  if (next.length === plan.edges.length) {
    throw planError('plan.edge_not_found', `Edge ${from}->${to} not found`, { from, to })
  }
  return {
    ...plan,
    revision: bumpRevision(plan),
    edges: next
  }
}

function applyReplaceTree(
  plan: Plan,
  nodes: readonly PlanNode[],
  edges: readonly PlanEdge[]
): Plan {
  return {
    ...plan,
    revision: bumpRevision(plan),
    nodes: [...nodes],
    edges: [...edges]
  }
}

/** Pure plan mutation via explicit operation. Throws PlanDomainError on illegal ops. */
export function applyOperation(plan: Plan, op: PlanOperation): Plan {
  assertMutable(plan)
  switch (op.type) {
    case 'add_node':
      return applyAddNode(plan, op.node)
    case 'remove_node':
      return applyRemoveNode(plan, op.nodeId)
    case 'update_node':
      return applyUpdateNode(plan, op.nodeId, op.patch)
    case 'add_edge':
      return applyAddEdge(plan, op.edge)
    case 'remove_edge':
      return applyRemoveEdge(plan, op.from, op.to)
    case 'replace_tree':
      return applyReplaceTree(plan, op.nodes, op.edges)
    default: {
      const _exhaustive: never = op
      throw planError('plan.unknown_operation', `Unknown plan operation`, {
        op: _exhaustive
      })
    }
  }
}
