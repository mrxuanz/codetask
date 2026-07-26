import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyOperation,
  asPlanId,
  asPlanNodeId,
  asPlanRevision,
  confirmPlan,
  detectCycle,
  markInReview,
  PlanDomainError,
  validatePlan,
  type Plan,
  type PlanNode
} from '@server/core/domain/plans'

function node(
  id: string,
  kind: PlanNode['kind'],
  title: string,
  parentId: string | null = null
): PlanNode {
  return {
    id: asPlanNodeId(id),
    kind,
    title,
    parentId: parentId == null ? null : asPlanNodeId(parentId)
  }
}

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: asPlanId('plan-1'),
    revision: asPlanRevision(1),
    status: 'editing',
    threadId: 'thread-1',
    draftId: 'draft-1',
    executionGeneration: 0,
    nodes: [
      node('m1', 'milestone', 'M1'),
      node('s1', 'slice', 'S1', 'm1'),
      node('t1', 'task', 'T1', 's1'),
      node('t2', 'task', 'T2', 's1')
    ],
    edges: [{ from: asPlanNodeId('t1'), to: asPlanNodeId('t2') }],
    ...overrides
  }
}

test('add_node / update_node / remove_node bump revision', () => {
  let plan = basePlan()
  plan = applyOperation(plan, {
    type: 'add_node',
    node: node('t3', 'task', 'T3', 's1')
  })
  assert.equal(plan.revision, 2)
  assert.equal(plan.nodes.some((n) => n.id === 't3'), true)

  plan = applyOperation(plan, {
    type: 'update_node',
    nodeId: asPlanNodeId('t3'),
    patch: { title: 'T3 renamed' }
  })
  assert.equal(plan.revision, 3)
  assert.equal(plan.nodes.find((n) => n.id === 't3')?.title, 'T3 renamed')

  plan = applyOperation(plan, { type: 'remove_node', nodeId: asPlanNodeId('t3') })
  assert.equal(plan.revision, 4)
  assert.equal(plan.nodes.some((n) => n.id === 't3'), false)
})

test('add_edge / remove_edge / replace_tree', () => {
  let plan = basePlan({ edges: [] })
  plan = applyOperation(plan, {
    type: 'add_edge',
    edge: { from: asPlanNodeId('t1'), to: asPlanNodeId('t2') }
  })
  assert.equal(plan.edges.length, 1)

  plan = applyOperation(plan, {
    type: 'remove_edge',
    from: asPlanNodeId('t1'),
    to: asPlanNodeId('t2')
  })
  assert.equal(plan.edges.length, 0)

  plan = applyOperation(plan, {
    type: 'replace_tree',
    nodes: [node('m1', 'milestone', 'M'), node('t9', 'task', 'only')],
    edges: []
  })
  assert.equal(plan.nodes.length, 2)
  assert.equal(plan.revision, 4)
})

test('detectCycle finds dependency cycles', () => {
  const nodes = [node('a', 'task', 'A'), node('b', 'task', 'B'), node('c', 'task', 'C')]
  assert.equal(
    detectCycle(nodes, [
      { from: asPlanNodeId('a'), to: asPlanNodeId('b') },
      { from: asPlanNodeId('b'), to: asPlanNodeId('c') }
    ]),
    false
  )
  assert.equal(
    detectCycle(nodes, [
      { from: asPlanNodeId('a'), to: asPlanNodeId('b') },
      { from: asPlanNodeId('b'), to: asPlanNodeId('c') },
      { from: asPlanNodeId('c'), to: asPlanNodeId('a') }
    ]),
    true
  )
})

test('validatePlan rejects empty tasks and cycles', () => {
  assert.throws(
    () =>
      validatePlan(
        basePlan({
          nodes: [node('m1', 'milestone', 'M1')],
          edges: []
        })
      ),
    (err: unknown) => err instanceof PlanDomainError && err.code === 'plan.no_tasks'
  )

  assert.throws(
    () =>
      validatePlan(
        basePlan({
          edges: [
            { from: asPlanNodeId('t1'), to: asPlanNodeId('t2') },
            { from: asPlanNodeId('t2'), to: asPlanNodeId('t1') }
          ]
        })
      ),
    (err: unknown) => err instanceof PlanDomainError && err.code === 'plan.cycle'
  )

  validatePlan(basePlan())
})

test('markInReview then confirmPlan bumps executionGeneration', () => {
  let plan = basePlan()
  plan = markInReview(plan)
  assert.equal(plan.status, 'in_review')
  assert.equal(plan.revision, 2)
  assert.equal(plan.executionGeneration, 0)

  plan = confirmPlan(plan)
  assert.equal(plan.status, 'confirmed')
  assert.equal(plan.executionGeneration, 1)
  assert.equal(plan.revision, 3)
})

test('confirmPlan requires in_review; confirmed plan is immutable', () => {
  assert.throws(
    () => confirmPlan(basePlan()),
    (err: unknown) => err instanceof PlanDomainError && err.code === 'plan.not_in_review'
  )

  const confirmed = confirmPlan(markInReview(basePlan()))
  assert.throws(
    () =>
      applyOperation(confirmed, {
        type: 'update_node',
        nodeId: asPlanNodeId('t1'),
        patch: { title: 'nope' }
      }),
    (err: unknown) => err instanceof PlanDomainError && err.code === 'plan.immutable'
  )
  assert.throws(
    () => markInReview(confirmed),
    (err: unknown) => err instanceof PlanDomainError && err.code === 'plan.already_confirmed'
  )
})
