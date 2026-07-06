import type { DraftLifecycleStatus, TaskLaunchDraftPayload } from './types'

export function normalizeDraftStatus(status: unknown): DraftLifecycleStatus {
  if (status === 'confirmed' || status === 'archived') return status
  if (status === 'launched') return 'confirmed'
  return 'editing'
}

export function isDraftEditable(payload: Pick<TaskLaunchDraftPayload, 'status'>): boolean {
  return normalizeDraftStatus(payload.status) === 'editing'
}

export function isDraftSectionLocked(
  payload: TaskLaunchDraftPayload,
  section: keyof TaskLaunchDraftPayload['lockedSections']
): boolean {
  if (!isDraftEditable(payload)) return true
  if (payload.lockedSections?.[section]) return true
  if (section === 'requirementsContract' && payload.requirementsContract.status === 'confirmed') {
    return true
  }
  return false
}
