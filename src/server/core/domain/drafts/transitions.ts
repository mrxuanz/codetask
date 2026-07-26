import { DraftDomainError } from './errors'
import { assertDraftEditable } from './invariants'
import type { Draft, DraftId, DraftPayload, DraftSectionPayload } from './types'

function mergePayload(
  base: DraftPayload | undefined,
  patch: DraftPayload | undefined
): DraftPayload | undefined {
  if (patch === undefined) return base
  if (base === undefined) return { ...patch }

  const sections =
    patch.sections !== undefined
      ? mergeSections(base.sections, patch.sections)
      : base.sections

  const next: DraftPayload = {
    ...base,
    ...patch,
    ...(sections !== undefined ? { sections } : {})
  }
  return next
}

function mergeSections(
  base: DraftPayload['sections'],
  patch: NonNullable<DraftPayload['sections']>
): Record<string, DraftSectionPayload> {
  const out: Record<string, DraftSectionPayload> = { ...(base ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = { ...(out[key] ?? {}), ...value }
  }
  return out
}

export function createDraft(input: {
  id: DraftId
  projectId: string
  threadId: string
  content?: string
  payload?: DraftPayload
}): Draft {
  return {
    id: input.id,
    status: 'collecting',
    revision: 1,
    content: input.content ?? '',
    projectId: input.projectId,
    threadId: input.threadId,
    ...(input.payload !== undefined ? { payload: input.payload } : {})
  }
}

export function updateCollectingContent(draft: Draft, content: string): Draft {
  assertDraftEditable(draft)
  return {
    ...draft,
    content,
    revision: draft.revision + 1
  }
}

/**
 * Patch content and/or structured payload while collecting.
 * Section fields merge shallowly; locked sections keep their lock unless unlocked via unlockDraft.
 */
export function updateCollectingPayload(
  draft: Draft,
  patch: {
    readonly content?: string
    readonly payload?: DraftPayload
  }
): Draft {
  assertDraftEditable(draft)
  const nextPayload = mergePayload(draft.payload, patch.payload)
  return {
    ...draft,
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(nextPayload !== undefined ? { payload: nextPayload } : {}),
    revision: draft.revision + 1
  }
}

/** Lock a named section while collecting (idempotent if already locked). */
export function confirmDraftSection(draft: Draft, sectionKey: string): Draft {
  assertDraftEditable(draft)
  const key = sectionKey.trim()
  if (!key) {
    throw new DraftDomainError('draft.invalid_section', 'sectionKey is required')
  }
  const existing = draft.payload?.sections?.[key]
  if (existing?.locked === true) {
    return draft
  }
  const sections: Record<string, DraftSectionPayload> = {
    ...(draft.payload?.sections ?? {}),
    [key]: { ...(existing ?? {}), locked: true }
  }
  return {
    ...draft,
    payload: { ...draft.payload, sections },
    revision: draft.revision + 1
  }
}

/**
 * Unlock a confirmed draft back to collecting and clear plan/job links in payload.
 * Already-collecting drafts with no plan link are idempotent no-ops.
 */
export function unlockDraft(draft: Draft): Draft {
  if (draft.status === 'abandoned') {
    throw new DraftDomainError(
      'draft.not_unlockable',
      `Cannot unlock draft in status ${draft.status}`
    )
  }
  if (draft.status === 'collecting') {
    const planId = draft.payload?.planId?.trim()
    const jobId = draft.payload?.jobId?.trim()
    if (!planId && !jobId) return draft
    return {
      ...draft,
      payload: { ...draft.payload, planId: null, jobId: null },
      revision: draft.revision + 1
    }
  }
  // confirmed → collecting
  return {
    ...draft,
    status: 'collecting',
    payload: { ...draft.payload, planId: null, jobId: null },
    revision: draft.revision + 1
  }
}

export function confirmDraft(draft: Draft): Draft {
  if (draft.status !== 'collecting') {
    throw new DraftDomainError(
      'draft.not_collecting',
      `Cannot confirm draft in status ${draft.status}`
    )
  }
  return {
    ...draft,
    status: 'confirmed'
  }
}

export function abandonDraft(draft: Draft): Draft {
  if (draft.status !== 'collecting') {
    throw new DraftDomainError(
      'draft.not_collecting',
      `Cannot abandon draft in status ${draft.status}`
    )
  }
  return {
    ...draft,
    status: 'abandoned'
  }
}
