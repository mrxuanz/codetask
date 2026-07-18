import type { JobAction, JobState, Recoverability } from '@shared/contracts/control-plane'

export interface ActionRuleContext {
  readonly state: JobState
  readonly recoverability: Recoverability | null
  readonly hasConfirmedPlan: boolean
}

export function availableActions(context: ActionRuleContext): readonly JobAction[] {
  switch (context.state) {
    case 'planning_queued':
    case 'planning_running':
    case 'execution_queued':
    case 'execution_running':
      return ['pause', 'cancel']
    case 'plan_review':
      return ['edit_plan', 'confirm_plan', 'replan', 'cancel']
    case 'pausing':
    case 'applying_changes':
      return []
    case 'paused':
      return ['continue', 'cancel']
    case 'failed':
      return context.recoverability === 'recoverable'
        ? ['continue', 'cancel']
        : ['restart_execution', 'delete']
    case 'cancelled':
      return context.hasConfirmedPlan ? ['restart_execution', 'delete'] : ['delete']
    case 'succeeded':
      return ['delete']
  }
}
