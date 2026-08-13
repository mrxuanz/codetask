import type { PlanningSessionViewDto } from '@codetask/contracts'

function timestamp(value: number | string): number {
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Recover the Design/Execution link from the canonical source draft id. */
export function findLatestPlanForDraft(
  draftId: string,
  plans: readonly PlanningSessionViewDto[]
): PlanningSessionViewDto | null {
  return (
    plans
      .filter((plan) => plan.draftMessageId === draftId)
      .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))[0] ?? null
  )
}
