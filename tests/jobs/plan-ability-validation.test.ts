import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlannerRegisteredPlan } from '../../src/server/planner/plan-types'
import { validatePlanAbilityCodes } from '../../src/server/planner/plan-ability-validation'

function samplePlan(abilityCode: string): PlannerRegisteredPlan {
  return {
    milestones: [
      {
        successCriteria: 'milestone done',
        slices: [
          {
            successCriteria: 'slice done',
            tasks: [
              {
                title: 'Scaffold source directories',
                description: 'Create tracked folders',
                taskKind: 'scaffolding',
                abilityCode
              }
            ]
          }
        ]
      }
    ]
  }
}

describe('validatePlanAbilityCodes', () => {
  it('accepts tasks whose abilityCode is in the confirmed draft abilities', () => {
    assert.doesNotThrow(() =>
      validatePlanAbilityCodes(samplePlan('project-setup'), [
        'project-setup',
        'frontend-implementation'
      ])
    )
  })

  it('rejects tasks whose abilityCode is outside the confirmed draft abilities', () => {
    assert.throws(
      () =>
        validatePlanAbilityCodes(samplePlan('scaffolding'), [
          'project-setup',
          'frontend-implementation'
        ]),
      /invalid task abilityCode values/
    )
  })

  it('rejects register_plan when no draft abilities are configured', () => {
    assert.throws(
      () => validatePlanAbilityCodes(samplePlan('project-setup'), []),
      /no confirmed draft abilities/
    )
  })
})
