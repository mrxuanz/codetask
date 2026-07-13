/**
 * UI Action Wiring
 *
 * Available actions come from server response.availableActions
 * Renderer must NOT compute actions from job state
 */

export interface JobAction {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
}

const ACTIVE_JOB_STATES = new Set([
  'planning_running',
  'execution_running',
  'pausing',
  'applying_changes'
])

export function getAvailableActions(job: { availableActions: readonly string[] }): readonly JobAction[] {
  return job.availableActions.map(action => ({
    id: action,
    label: getActionLabel(action),
    enabled: true
  }))
}

function getActionLabel(action: string): string {
  switch (action) {
    case 'pause': return 'Pause'
    case 'continue': return 'Continue'
    case 'cancel': return 'Cancel'
    case 'restart_execution': return 'Restart'
    case 'replan': return 'Replan'
    case 'confirm_plan': return 'Confirm Plan'
    case 'edit_plan': return 'Edit Plan'
    case 'delete': return 'Delete'
    default: return action
  }
}

export function canDelete(availableActions: readonly string[]): boolean {
  return availableActions.includes('delete')
}

export function canCancel(availableActions: readonly string[]): boolean {
  return availableActions.includes('cancel')
}

export function filterActions(
  availableActions: readonly string[],
  job?: { readonly state: string }
): readonly string[] {
  return availableActions.filter((action) => {
    if (action === 'delete' && job !== undefined && ACTIVE_JOB_STATES.has(job.state)) {
      return false
    }
    return true
  })
}

export function shouldShowDelete(job: { state: string; availableActions?: readonly string[] }): boolean {
  if (ACTIVE_JOB_STATES.has(job.state)) {
    return false
  }
  if (job.availableActions !== undefined) {
    return canDelete(job.availableActions)
  }
  return true
}

export function getPauseButtonText(job: { state: string }): string | null {
  if (job.state === 'pausing') return 'Pausing...'
  return null
}
