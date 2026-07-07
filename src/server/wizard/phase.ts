import { and, eq } from 'drizzle-orm'
import { AppError } from '../error'
import { getDb } from '../db'
import { threads, type Thread } from '../db/schema'
import type { TaskLaunchDraftPayload } from '../conversation/draft/types'
import { insertMessage } from '../conversation/messages'
import { getThreadRow, toThreadDto } from '../threads/service'
import type { ThreadDto } from '../threads/types'
import { RUNTIME_STATUS_IDLE } from '../threads/types'
import { clearCorePhaseRuntime, getCorePhaseRuntime, parseCoreRuntimeJson } from './core-runtime'
import type { WizardHandoffPayload, WizardPhase } from './types'
import {
  isWizardPhase,
  WIZARD_PHASE_COLLECT,
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_EDIT,
  WIZARD_PHASE_PLAN_GENERATING,
  WIZARD_PHASE_READY_TO_LAUNCH
} from './types'
import { isDesignSessionId } from '@shared/design-session'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function inferWizardPhaseFromThread(row: Thread): WizardPhase {
  const stored = row.wizardPhase?.trim()
  if (stored === WIZARD_PHASE_COLLECT) {
    return WIZARD_PHASE_COLLECT
  }
  if (row.activePlanId) {
    if (isDesignSessionId(row.activePlanId)) {
      const stored = row.wizardPhase?.trim()
      if (
        stored === WIZARD_PHASE_PLAN_GENERATING ||
        stored === WIZARD_PHASE_PLAN_EDIT ||
        stored === WIZARD_PHASE_READY_TO_LAUNCH
      ) {
        return stored
      }
    }
    return WIZARD_PHASE_PLAN_EDIT
  }
  if (row.activeDraftId) return WIZARD_PHASE_DRAFT_REVIEW
  if (isWizardPhase(stored)) return stored
  return WIZARD_PHASE_COLLECT
}

export function resolveWizardPhase(row: Thread): WizardPhase {
  return inferWizardPhaseFromThread(row)
}

export type WizardPhaseWriteIntent =
  | { type: 'set'; phase: WizardPhase }
  | {
      type: 'infer_from_context'
      activeDraftId?: string | null
      activePlanId?: string | null
      draftIsPlaceholder?: boolean
    }
  | { type: 'collecting_draft' }

/** Single write authority for threads.wizard_phase. Undefined means leave the column unchanged. */
export function resolveThreadWizardPhaseWrite(
  row: Thread,
  intent: WizardPhaseWriteIntent
): WizardPhase | undefined {
  switch (intent.type) {
    case 'set':
      return intent.phase
    case 'collecting_draft':
      return WIZARD_PHASE_COLLECT
    case 'infer_from_context': {
      if (intent.activePlanId) {
        return WIZARD_PHASE_PLAN_EDIT
      }
      if (intent.activeDraftId && !row.activePlanId) {
        if (intent.draftIsPlaceholder) return undefined
        return WIZARD_PHASE_DRAFT_REVIEW
      }
      return undefined
    }
  }
}

export function applyThreadWizardPhaseWrite(
  patch: Partial<Thread>,
  row: Thread,
  intent: WizardPhaseWriteIntent
): void {
  const phase = resolveThreadWizardPhaseWrite(row, intent)
  if (phase !== undefined) {
    patch.wizardPhase = phase
  }
}

export function assertWizardPhase(
  current: WizardPhase,
  expected: WizardPhase | WizardPhase[]
): void {
  const allowed = Array.isArray(expected) ? expected : [expected]
  if (!allowed.includes(current)) {
    throw AppError.badRequest(
      `Current phase is ${current}; this action is only allowed in ${allowed.join(' / ')}`,
      'wizard.invalid_phase',
      { current, expected: allowed.join(' / ') }
    )
  }
}

export async function assertThreadWizardPhase(
  username: string,
  threadId: string,
  expected: WizardPhase | WizardPhase[]
): Promise<{ row: Thread; phase: WizardPhase }> {
  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  const phase = resolveWizardPhase(row)
  assertWizardPhase(phase, expected)
  return { row, phase }
}

export async function assertActiveDraft(
  username: string,
  threadId: string,
  draftMessageId: string,
  revision?: number | null
): Promise<TaskLaunchDraftPayload> {
  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  if (row.activeDraftId && row.activeDraftId !== draftMessageId) {
    throw AppError.badRequest('Please use the currently selected draft', 'draft.not_selected')
  }
  const { getMessage } = await import('../conversation/messages')
  const message = await getMessage(username, threadId, draftMessageId, { signAssets: false })
  if (!message || message.kind !== 'task-launch-draft') {
    throw AppError.notFound('Task draft message not found', 'draft.not_found')
  }
  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId)
    throw AppError.badRequest('Task draft payload invalid', 'draft.invalid_payload')
  if (revision != null && (payload.revision ?? 0) !== revision) {
    throw AppError.badRequest('Draft revision changed; reload before editing', 'draft.conflict')
  }
  return payload
}

export async function assertActivePlan(
  username: string,
  threadId: string,
  jobId: string
): Promise<void> {
  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  if (row.activePlanId && row.activePlanId !== jobId) {
    throw AppError.badRequest(
      'Please use the currently selected execution plan',
      'job.not_selected'
    )
  }
}

export function buildCollectToDraftHandoff(input: {
  draftMessageId: string
  draftRevision: number
  payload: TaskLaunchDraftPayload
  sourceMessageIds?: string[]
}): WizardHandoffPayload {
  const payload = input.payload
  return {
    from: WIZARD_PHASE_COLLECT,
    to: WIZARD_PHASE_DRAFT_REVIEW,
    requirementsSummary: [
      payload.title,
      payload.summary,
      payload.userFlow?.trim() ? `User flow: ${payload.userFlow.trim()}` : '',
      payload.techStack?.trim() ? `Tech stack: ${payload.techStack.trim()}` : ''
    ]
      .filter(Boolean)
      .join('\n'),
    openQuestions: [],
    constraints: payload.outOfScope ?? [],
    sourceMessageIds: input.sourceMessageIds,
    draftMessageId: input.draftMessageId,
    draftRevision: input.draftRevision,
    planId: null
  }
}

export function buildDraftToPlanHandoff(input: {
  draftMessageId: string
  draftRevision: number
  planId: string
  payload: TaskLaunchDraftPayload
}): WizardHandoffPayload {
  return {
    from: WIZARD_PHASE_DRAFT_REVIEW,
    to: WIZARD_PHASE_PLAN_EDIT,
    requirementsSummary: input.payload.requirementsContract.markdown,
    draftMessageId: input.draftMessageId,
    draftRevision: input.draftRevision,
    planId: input.planId,
    constraints: input.payload.outOfScope ?? []
  }
}

export function buildRollbackHandoff(input: {
  from: WizardPhase
  to: WizardPhase
  reason: string
  draftMessageId?: string | null
  draftRevision?: number | null
}): WizardHandoffPayload {
  return {
    from: input.from,
    to: input.to,
    reason: input.reason,
    draftMessageId: input.draftMessageId ?? null,
    draftRevision: input.draftRevision ?? null,
    planId: null
  }
}

export function buildPlanPhaseHandoff(input: {
  from: WizardPhase
  to: WizardPhase
  planId: string
  draftMessageId?: string | null
  reason?: string
}): WizardHandoffPayload {
  return {
    from: input.from,
    to: input.to,
    planId: input.planId,
    draftMessageId: input.draftMessageId ?? null,
    reason: input.reason
  }
}

export function formatHandoffMarkdown(handoff: WizardHandoffPayload): string {
  const lines = [
    `Phase transition: ${handoff.from} → ${handoff.to}`,
    handoff.reason ? `Reason: ${handoff.reason}` : '',
    handoff.draftMessageId ? `draft_message_id: ${handoff.draftMessageId}` : '',
    handoff.draftRevision != null ? `draft_revision: ${handoff.draftRevision}` : '',
    handoff.planId ? `plan_id: ${handoff.planId}` : '',
    handoff.requirementsSummary ? `\n## Requirements summary\n${handoff.requirementsSummary}` : '',
    handoff.openQuestions?.length
      ? `\n## Open questions\n${handoff.openQuestions.map((q) => `- ${q}`).join('\n')}`
      : '',
    handoff.constraints?.length
      ? `\n## Constraints\n${handoff.constraints.map((c) => `- ${c}`).join('\n')}`
      : ''
  ].filter(Boolean)
  return lines.join('\n')
}

export async function advanceWizardPhase(
  username: string,
  threadId: string,
  input: {
    to: WizardPhase
    handoff: WizardHandoffPayload
    activeDraftId?: string | null
    activePlanId?: string | null
    coreCode: string
  }
): Promise<ThreadDto> {
  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')

  const now = nowSec()
  const runtimeMap = parseCoreRuntimeJson(row.coreRuntimeJson)
  const clearedMap = clearCorePhaseRuntime(runtimeMap, input.coreCode, input.to)

  await insertMessage({
    threadId,
    username,
    role: 'system',
    kind: 'wizard-handoff',
    content: formatHandoffMarkdown(input.handoff),
    coreCode: input.coreCode,
    conversationId: row.conversationId,
    runtimeSessionId: null,
    wizardPhase: input.to,
    payload: input.handoff
  })

  const db = getDb()
  const patch: Partial<Thread> = {
    wizardPhase: resolveThreadWizardPhaseWrite(row, { type: 'set', phase: input.to }),
    runtimeSessionId: null,
    runtimeStatus: RUNTIME_STATUS_IDLE,
    coreRuntimeJson: JSON.stringify(clearedMap),
    updatedAt: now
  }
  if (input.activeDraftId !== undefined) patch.activeDraftId = input.activeDraftId
  if (input.activePlanId !== undefined) patch.activePlanId = input.activePlanId

  await db
    .update(threads)
    .set(patch)
    .where(and(eq(threads.username, username), eq(threads.id, threadId)))

  const updated = await getThreadRow(username, threadId)
  if (!updated)
    throw AppError.internal('Failed to read thread after advancing phase', 'thread.read_failed')
  return toThreadDto(updated)
}

export async function requestPhaseRollback(
  username: string,
  threadId: string,
  input: { to: WizardPhase; reason: string; coreCode: string }
): Promise<ThreadDto> {
  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  const from = resolveWizardPhase(row)

  if (input.to === WIZARD_PHASE_COLLECT) {
    if (from === WIZARD_PHASE_COLLECT) {
      throw AppError.badRequest(
        'Already in requirements collection phase',
        'wizard.already_in_phase',
        {
          phase: 'collect'
        }
      )
    }
    return advanceWizardPhase(username, threadId, {
      to: WIZARD_PHASE_COLLECT,
      coreCode: input.coreCode,
      activeDraftId: null,
      activePlanId: null,
      handoff: buildRollbackHandoff({
        from,
        to: WIZARD_PHASE_COLLECT,
        reason: input.reason,
        draftMessageId: row.activeDraftId
      })
    })
  }

  if (input.to === WIZARD_PHASE_DRAFT_REVIEW) {
    if (from !== WIZARD_PHASE_PLAN_EDIT) {
      throw AppError.badRequest(
        'Only the execution plan phase can roll back to draft review',
        'wizard.rollback_not_allowed'
      )
    }
    if (!row.activeDraftId) {
      throw AppError.badRequest('No draft to roll back to', 'wizard.rollback_not_allowed')
    }
    return advanceWizardPhase(username, threadId, {
      to: WIZARD_PHASE_DRAFT_REVIEW,
      coreCode: input.coreCode,
      activePlanId: null,
      handoff: buildRollbackHandoff({
        from,
        to: WIZARD_PHASE_DRAFT_REVIEW,
        reason: input.reason,
        draftMessageId: row.activeDraftId
      })
    })
  }

  throw AppError.badRequest('Unsupported target phase', 'wizard.invalid_phase')
}

export function getThreadPhaseRuntime(row: Thread): string | null {
  const phase = resolveWizardPhase(row)
  const map = parseCoreRuntimeJson(row.coreRuntimeJson)
  return getCorePhaseRuntime(map, row.coreCode, phase)
}
