import { DraftDomainError } from './errors'
import type { Draft } from './types'

/** Draft content may only change while status is `collecting`. */
export function assertDraftEditable(draft: Draft): void {
  if (draft.status !== 'collecting') {
    throw new DraftDomainError(
      'draft.not_editable',
      `Draft is not editable in status ${draft.status}`
    )
  }
}
