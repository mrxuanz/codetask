import type { Plan, PlanEdge, PlanNode } from '../../domain/plans/types'
import type { PlanRepo } from '../ports/repositories'
import { fail, type QueryResult } from '../results'

export type PlanNodeProjection = {
  readonly id: string
  readonly kind: PlanNode['kind']
  readonly title: string
  readonly parentId: string | null
  readonly abilityCode?: string | null
  readonly successCriteria?: string
}

export type PlanEdgeProjection = {
  readonly from: string
  readonly to: string
}

export type PlanProjection = {
  readonly id: string
  readonly revision: number
  readonly status: Plan['status']
  readonly nodes: readonly PlanNodeProjection[]
  readonly edges: readonly PlanEdgeProjection[]
  readonly executionGeneration: number
  readonly threadId: string
  readonly draftId?: string
}

function projectNode(node: PlanNode): PlanNodeProjection {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    parentId: node.parentId,
    abilityCode: node.abilityCode,
    successCriteria: node.successCriteria
  }
}

function projectEdge(edge: PlanEdge): PlanEdgeProjection {
  return { from: edge.from, to: edge.to }
}

export function projectPlan(plan: Plan): PlanProjection {
  return {
    id: plan.id,
    revision: Number(plan.revision),
    status: plan.status,
    nodes: plan.nodes.map(projectNode),
    edges: plan.edges.map(projectEdge),
    executionGeneration: plan.executionGeneration,
    threadId: plan.threadId,
    draftId: plan.draftId
  }
}

export async function getPlanQuery(
  deps: { readonly plans: PlanRepo },
  input: { readonly planId: string }
): Promise<QueryResult<PlanProjection>> {
  const plan = await deps.plans.get(input.planId)
  if (!plan) {
    return fail('plan.not_found', `Plan not found: ${input.planId}`)
  }
  return { ok: true, value: projectPlan(plan) }
}
