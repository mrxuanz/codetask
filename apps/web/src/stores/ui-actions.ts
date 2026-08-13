/**
 * UI Action Wiring
 *
 * Available actions come from server response.availableActions
 * Renderer must NOT compute actions from job state
 */

import { i18n } from '@renderer/i18n'

const ACTIVE_JOB_STATES = new Set(['running', 'pausing', 'cancelling'])

function t(key: string): string {
  return i18n.global.t(key)
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

export function getPauseButtonText(job: { state: string }): string | null {
  if (job.state === 'pausing') return t('workspace.tasks.actions.pausing')
  return null
}
