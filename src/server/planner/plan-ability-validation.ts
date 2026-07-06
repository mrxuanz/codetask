import type { PlannerRegisteredPlan } from './plan-types'

export function validatePlanAbilityCodes(
  plan: PlannerRegisteredPlan,
  allowedAbilityCodes: string[]
): void {
  const allowed = new Set(allowedAbilityCodes.map((code) => code.trim()).filter(Boolean))
  if (allowed.size === 0) {
    throw new Error(
      'no confirmed draft abilities are available; every task.abilityCode must map to a draft ability with a selected CLI'
    )
  }

  const invalid: string[] = []
  plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      slice.tasks.forEach((task, tIdx) => {
        const abilityCode = task.abilityCode?.trim()
        if (!abilityCode || !allowed.has(abilityCode)) {
          const label = abilityCode || '(missing)'
          invalid.push(
            `m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1} "${task.title}" used abilityCode "${label}" which is not in the confirmed draft abilities`
          )
        }
      })
    })
  })

  if (invalid.length > 0) {
    throw new Error(
      `invalid task abilityCode values. Confirmed draft abilityCodes: [${[...allowed].join(', ')}]. Errors: ${invalid.join('; ')}`
    )
  }
}
