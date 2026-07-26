import type { PlanEdge, PlanNode, PlanNodeId } from './types'

export type PlanNodePatch = Partial<
  Pick<PlanNode, 'title' | 'parentId' | 'abilityCode' | 'successCriteria' | 'kind'>
>

export type PlanOperation =
  | { readonly type: 'add_node'; readonly node: PlanNode }
  | { readonly type: 'remove_node'; readonly nodeId: PlanNodeId }
  | { readonly type: 'update_node'; readonly nodeId: PlanNodeId; readonly patch: PlanNodePatch }
  | { readonly type: 'add_edge'; readonly edge: PlanEdge }
  | { readonly type: 'remove_edge'; readonly from: PlanNodeId; readonly to: PlanNodeId }
  | {
      readonly type: 'replace_tree'
      readonly nodes: readonly PlanNode[]
      readonly edges: readonly PlanEdge[]
    }
