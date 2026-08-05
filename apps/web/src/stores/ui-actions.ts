/**
 * UI Action Wiring
 *
 * Available actions come from server response.availableActions
 * Renderer must NOT compute actions from job state
 */

import { i18n } from '@renderer/i18n'

export interface JobAction {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
}

const ACTIVE_JOB_STATES = new Set(['running', 'pausing', 'cancelling'])

function t(key: string): string {
  return i18n.global.t(key)
}

export function getAvailableActions(job: {
  availableActions: readonly string[]
}): readonly JobAction[] {
  return job.availableActions.map((action) => ({
    id: action,
    label: getActionLabel(action),
    enabled: true
  }))
}

function getActionLabel(action: string): string {
  switch (action) {
    case 'pause':
      return t('workspace.tasks.actions.pause')
    case 'continue':
      return t('workspace.tasks.actions.continue')
    case 'cancel':
      return t('workspace.tasks.actions.cancel')
    case 'restart':
      return t('workspace.tasks.actions.restart')
    case 'restart_execution':
      return t('workspace.tasks.actions.restartExecution')
    case 'replan':
      return t('workspace.tasks.actions.replan')
    case 'confirm_plan':
      return t('workspace.tasks.actions.confirmPlan')
    case 'edit_plan':
      return t('workspace.tasks.actions.editPlan')
    case 'delete':
      return t('workspace.tasks.actions.delete')
    default:
      return action
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

export function shouldShowDelete(job: {
  state: string
  availableActions?: readonly string[]
}): boolean {
  if (ACTIVE_JOB_STATES.has(job.state)) {
    return false
  }
  if (job.availableActions !== undefined) {
    return canDelete(job.availableActions)
  }
  return true
}

export function getPauseButtonText(job: { state: string }): string | null {
  if (job.state === 'pausing') return t('workspace.tasks.actions.pausing')
  return null
}
