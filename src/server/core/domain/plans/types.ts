export type PlanId = string & { readonly __brand: 'PlanId' }
export type PlanRevision = number & { readonly __brand: 'PlanRevision' }
export type PlanNodeId = string & { readonly __brand: 'PlanNodeId' }

export type PlanStatus = 'editing' | 'in_review' | 'confirmed'
export type PlanNodeKind = 'milestone' | 'slice' | 'task'

export function asPlanId(value: string): PlanId {
  return value as PlanId
}

export function asPlanRevision(value: number): PlanRevision {
  return value as PlanRevision
}

export function asPlanNodeId(value: string): PlanNodeId {
  return value as PlanNodeId
}

export interface PlanNode {
  readonly id: PlanNodeId
  readonly kind: PlanNodeKind
  readonly title: string
  readonly parentId: PlanNodeId | null
  readonly abilityCode?: string | null
  readonly successCriteria?: string
}

export interface PlanEdge {
  readonly from: PlanNodeId
  readonly to: PlanNodeId
}

export interface Plan {
  readonly id: PlanId
  readonly revision: PlanRevision
  readonly status: PlanStatus
  readonly nodes: readonly PlanNode[]
  readonly edges: readonly PlanEdge[]
  /** Bumped on confirm; immutable for a confirmed generation. */
  readonly executionGeneration: number
  readonly threadId: string
  readonly draftId?: string
}
