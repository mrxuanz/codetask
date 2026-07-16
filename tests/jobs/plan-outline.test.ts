import assert from 'node:assert/strict'
import test from 'node:test'
import { plannerMcpToolDefinitions } from '../../src/server/planner/mcp/tools'
import {
  validatePlanOutlineCompleteness,
  validateRegisteredPlanDependencyGraph
} from '../../src/server/planner/mcp/normalize'
import { flattenRegisteredPlan } from '../../src/server/planner/save-plan'
import { buildPlannerSystemPrompt } from '../../src/server/planner/prompts'
import type { PlannerRegisteredPlan } from '../../src/server/planner/plan-types'

const outline: PlannerRegisteredPlan = {
  milestones: [
    {
      title: 'Delivery',
      description: 'Deliver the feature',
      successCriteria: 'Feature is ready',
      slices: [
        {
          title: 'Implementation',
          description: 'Implement the feature',
          successCriteria: 'Implementation is complete',
          tasks: [
            {
              title: 'Create component',
              description: 'Create the primary component',
              taskKind: 'frontend-implementation',
              abilityCode: 'frontend-implementation',
              successCriteria: 'Component renders'
            },
            {
              title: 'Wire component',
              description: 'Connect the component',
              taskKind: 'frontend-implementation',
              abilityCode: 'frontend-implementation',
              successCriteria: 'Component is connected'
            }
          ]
        }
      ]
    }
  ]
}

test('planner exposes the staged outline protocol in order', () => {
  assert.deepEqual(
    plannerMcpToolDefinitions().map((tool) => tool.name),
    ['register_plan_outline', 'register_task_context', 'update_task_context', 'finalize_plan']
  )
})

test('planner prompt mandates outline, context, then server-side finalization', () => {
  const prompt = buildPlannerSystemPrompt()
  const outlineIndex = prompt.indexOf('register_plan_outline exactly once')
  const contextIndex = prompt.indexOf('For EVERY locked task, call register_task_context')
  const finalizeIndex = prompt.indexOf('call finalize_plan with no arguments')
  assert.ok(outlineIndex >= 0)
  assert.ok(contextIndex > outlineIndex)
  assert.ok(finalizeIndex > contextIndex)
  assert.doesNotMatch(prompt, /call register_plan once/)
})

test('locked outline produces a complete visible tree before contexts are filled', () => {
  const partial = flattenRegisteredPlan(outline, new Map())
  assert.deepEqual(
    partial.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      context: task.contextMarkdown
    })),
    [
      { id: 'm1-s1-t1', title: 'Create component', context: '' },
      { id: 'm1-s1-t2', title: 'Wire component', context: '' }
    ]
  )
})

test('task contexts fill their locked coordinates without rebuilding the outline', () => {
  const contexts = new Map([
    ['m1-s1-t2', { taskTitle: 'Wire component', content: 'Detailed wiring instructions' }]
  ])
  const partial = flattenRegisteredPlan(outline, contexts)
  assert.equal(partial.tasks[0]?.contextMarkdown, '')
  assert.equal(partial.tasks[1]?.contextMarkdown, 'Detailed wiring instructions')
})

test('outline validation requires explicit task success criteria', () => {
  const invalid = structuredClone(outline)
  invalid.milestones[0]!.slices[0]!.tasks[1]!.successCriteria = undefined
  assert.throws(() => validatePlanOutlineCompleteness(invalid), /m1-s1-t2\.successCriteria/)
})

test('dependency validation rejects same or later task coordinates', () => {
  const invalid = structuredClone(outline)
  invalid.milestones[0]!.slices[0]!.tasks[0]!.dependsOnTaskRefs = ['m1-s1-t2']
  assert.throws(
    () => validateRegisteredPlanDependencyGraph(invalid),
    /depends on later or same task/
  )

  const valid = structuredClone(outline)
  valid.milestones[0]!.slices[0]!.tasks[1]!.dependsOnTaskRefs = ['m1-s1-t1']
  assert.doesNotThrow(() => validateRegisteredPlanDependencyGraph(valid))
})
