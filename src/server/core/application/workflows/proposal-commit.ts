import type { SkillProposal } from '../skills/contracts'
import {
  asPlanId,
  asPlanNodeId,
  asPlanRevision,
  validatePlan,
  type Plan,
  type PlanEdge,
  type PlanNode,
  type PlanNodeKind
} from '../../domain/plans/index'
import type { PlanRepo } from '../ports/repositories'
import type { IdGenerator } from '../ports/id-generator'
import type { UnitOfWork } from '../ports/unit-of-work'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult } from '../commands/helpers'

export type ProposalCommitDeps = {
  readonly plans: PlanRepo
  readonly ids: IdGenerator
  readonly unitOfWork: UnitOfWork
}

export type CommitPlanTreeInput = {
  readonly proposal: SkillProposal
  readonly threadId: string
  readonly draftId?: string
  readonly planId?: string
  readonly expectedRevision?: number
}

function isPlanNodeKind(value: unknown): value is PlanNodeKind {
  return value === 'milestone' || value === 'slice' || value === 'task'
}

function parsePlanTreePayload(payload: Readonly<Record<string, unknown>>): {
  nodes: PlanNode[]
  edges: PlanEdge[]
} {
  const rawNodes = payload.nodes
  const rawEdges = payload.edges
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
    throw Object.assign(new Error('plan_tree proposal requires nodes and edges arrays'), {
      code: 'proposal.invalid_payload'
    })
  }

  const nodes: PlanNode[] = rawNodes.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw Object.assign(new Error(`Invalid plan node at index ${index}`), {
        code: 'proposal.invalid_node'
      })
    }
    const node = raw as Record<string, unknown>
    if (typeof node.id !== 'string' || typeof node.title !== 'string' || !isPlanNodeKind(node.kind)) {
      throw Object.assign(new Error(`Invalid plan node fields at index ${index}`), {
        code: 'proposal.invalid_node'
      })
    }
    const parentId =
      node.parentId === null || node.parentId === undefined
        ? null
        : asPlanNodeId(String(node.parentId))
    return {
      id: asPlanNodeId(node.id),
      kind: node.kind,
      title: node.title,
      parentId,
      abilityCode: typeof node.abilityCode === 'string' ? node.abilityCode : null,
      successCriteria:
        typeof node.successCriteria === 'string' ? node.successCriteria : undefined
    }
  })

  const edges: PlanEdge[] = rawEdges.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw Object.assign(new Error(`Invalid plan edge at index ${index}`), {
        code: 'proposal.invalid_edge'
      })
    }
    const edge = raw as Record<string, unknown>
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      throw Object.assign(new Error(`Invalid plan edge fields at index ${index}`), {
        code: 'proposal.invalid_edge'
      })
    }
    return { from: asPlanNodeId(edge.from), to: asPlanNodeId(edge.to) }
  })

  return { nodes, edges }
}

/**
 * Proposal → schema/semantic validate → domain validate → commit.
 * Skills produce proposals only; they never write repositories (重构.md §7.3).
 */
export async function commitPlanTreeProposal(
  deps: ProposalCommitDeps,
  input: CommitPlanTreeInput
): Promise<CommandResult<{ plan: Plan }>> {
  try {
    if (input.proposal.kind !== 'plan_tree') {
      return fail(
        'proposal.unsupported_kind',
        `Unsupported proposal kind: ${input.proposal.kind}`
      )
    }

    const { nodes, edges } = parsePlanTreePayload(input.proposal.payload)

    return await deps.unitOfWork.run(async (tx) => {
      const planId = input.planId ?? deps.ids.next()
      const existing = await deps.plans.get(planId)

      const plan: Plan = existing
        ? {
            ...existing,
            nodes,
            edges,
            revision: asPlanRevision(Number(existing.revision) + 1),
            status: existing.status === 'confirmed' ? existing.status : 'editing',
            draftId: input.draftId ?? existing.draftId
          }
        : {
            id: asPlanId(planId),
            revision: asPlanRevision(1),
            status: 'editing',
            nodes,
            edges,
            executionGeneration: 0,
            threadId: input.threadId,
            draftId: input.draftId
          }

      if (plan.status === 'confirmed') {
        return fail('plan.immutable', 'Confirmed plan cannot accept new proposal trees')
      }

      validatePlan(plan)

      await deps.plans.save(plan, {
        expectedRevision:
          input.expectedRevision ?? (existing ? Number(existing.revision) : undefined)
      })
      tx.enqueueEvent({ type: 'plan.proposal_committed', aggregateId: plan.id })
      return { ok: true as const, value: { plan } }
    })
  } catch (error: unknown) {
    return mapThrownToResult(error)
  }
}
