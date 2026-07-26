import type { Plan } from '../../core/domain/plans/types'
import type { PlanRepo, SaveOptions } from '../../core/application/ports/repositories'
import { RevisionConflictError } from '../../core/application/ports/repositories'

export class InMemoryPlanRepo implements PlanRepo {
  private readonly store = new Map<string, Plan>()

  async get(id: string): Promise<Plan | undefined> {
    const plan = this.store.get(id)
    return plan
      ? {
          ...plan,
          nodes: [...plan.nodes],
          edges: [...plan.edges]
        }
      : undefined
  }

  async save(plan: Plan, options?: SaveOptions): Promise<void> {
    if (options?.expectedRevision !== undefined) {
      const existing = this.store.get(plan.id)
      const current = existing ? Number(existing.revision) : 0
      if (current !== options.expectedRevision) {
        throw new RevisionConflictError(
          `Plan ${plan.id}: expected revision ${options.expectedRevision}, have ${current}`
        )
      }
    }
    this.store.set(plan.id, {
      ...plan,
      nodes: [...plan.nodes],
      edges: [...plan.edges]
    })
  }
}
