export type PlanValidationError = {
  readonly code: string
  readonly detail: string
}

export interface PlanInput {
  readonly milestones: readonly PlanMilestoneInput[]
}

export interface PlanMilestoneInput {
  readonly id: string
  readonly title: string
  readonly slices: readonly PlanSliceInput[]
}

export interface PlanSliceInput {
  readonly id: string
  readonly title: string
  readonly tasks: readonly PlanTaskInput[]
  readonly dependencies: readonly string[]
}

export interface PlanTaskInput {
  readonly id: string
  readonly title: string
  readonly abilityCode: string | null
  readonly coreCode: string | null
}

export interface NormalizedPlan {
  readonly milestones: readonly NormalizedMilestone[]
  readonly contentHash: string
}

export interface NormalizedMilestone {
  readonly id: string
  readonly title: string
  readonly sortOrder: number
  readonly slices: readonly NormalizedSlice[]
}

export interface NormalizedSlice {
  readonly id: string
  readonly title: string
  readonly sortOrder: number
  readonly tasks: readonly NormalizedTask[]
  readonly dependencies: readonly string[]
}

export interface NormalizedTask {
  readonly id: string
  readonly title: string
  readonly abilityCode: string | null
  readonly coreCode: string | null
  readonly sortOrder: number
}

export function validatePlan(input: PlanInput): { readonly ok: true; readonly plan: NormalizedPlan } | { readonly ok: false; readonly errors: readonly PlanValidationError[] } {
  const errors: PlanValidationError[] = []

  // Validate milestones exist
  if (input.milestones.length === 0) {
    errors.push({ code: 'plan.no_milestones', detail: 'Plan must have at least one milestone' })
    return { ok: false, errors }
  }

  // Validate each milestone
  for (const milestone of input.milestones) {
    if (!milestone.id || !milestone.title) {
      errors.push({ code: 'plan.invalid_milestone', detail: `Milestone ${milestone.id} missing id or title` })
    }

    // Validate slices
    for (const slice of milestone.slices) {
      if (!slice.id || !slice.title) {
        errors.push({ code: 'plan.invalid_slice', detail: `Slice ${slice.id} missing id or title` })
      }

      // Validate dependencies exist
      for (const depId of slice.dependencies) {
        const depExists = milestone.slices.some(s => s.id === depId)
        if (!depExists) {
          errors.push({ code: 'plan.invalid_dependency', detail: `Dependency ${depId} not found in milestone` })
        }
        if (depId === slice.id) {
          errors.push({ code: 'plan.self_dependency', detail: `Slice ${slice.id} cannot depend on itself` })
        }
      }

      // Validate tasks
      for (const task of slice.tasks) {
        if (!task.id || !task.title) {
          errors.push({ code: 'plan.invalid_task', detail: `Task ${task.id} missing id or title` })
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  // Normalize plan
  const normalized: NormalizedPlan = {
    milestones: input.milestones.map((m, mIdx) => ({
      id: m.id,
      title: m.title,
      sortOrder: mIdx,
      slices: m.slices.map((s, sIdx) => ({
        id: s.id,
        title: s.title,
        sortOrder: sIdx,
        tasks: s.tasks.map((t, tIdx) => ({
          id: t.id,
          title: t.title,
          abilityCode: t.abilityCode,
          coreCode: t.coreCode,
          sortOrder: tIdx
        })),
        dependencies: s.dependencies
      }))
    })),
    contentHash: computeContentHash(input)
  }

  return { ok: true, plan: normalized }
}

function computeContentHash(input: PlanInput): string {
  const canonical = JSON.stringify(input)
  let hash = 0
  for (let i = 0; i < canonical.length; i++) {
    const char = canonical.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return `plan_${Math.abs(hash).toString(36)}`
}
