declare const draftIdBrand: unique symbol

/** Branded draft identifier (opaque string). */
export type DraftId = string & { readonly [draftIdBrand]: typeof draftIdBrand }

export function asDraftId(value: string): DraftId {
  return value as DraftId
}

export type DraftStatus = 'collecting' | 'confirmed' | 'abandoned'

export const DRAFT_STATUSES = ['collecting', 'confirmed', 'abandoned'] as const satisfies readonly DraftStatus[]

/** Per-section companion stored on Draft.payload.sections. */
export type DraftSectionPayload = {
  readonly locked?: boolean
  readonly content?: string
}

/**
 * Structured companion for draft writers (patch / section lock / unlock / planning link).
 * Persisted in sqlite `core_drafts.payload_json`.
 */
export type DraftPayload = {
  readonly sections?: Readonly<Record<string, DraftSectionPayload>>
  readonly planId?: string | null
  readonly jobId?: string | null
  readonly wizardPhase?: string
}

export interface Draft {
  readonly id: DraftId
  readonly status: DraftStatus
  readonly revision: number
  readonly content: string
  readonly projectId: string
  readonly threadId: string
  /** Optional structured companion (section locks, plan link, wizard phase). */
  readonly payload?: DraftPayload
}
