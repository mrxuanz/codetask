import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { AppError } from '../../error'
import { getDb } from '../../db'
import { threadMessages } from '../../db/schema'
import {
  confirmRequirementsContract,
  createTaskLaunchDraftPayload,
  draftPayloadToClientJson,
  normalizeProposedTaskDraft,
  sanitizeProposeTaskDraftArguments
} from '../draft/normalize'
import { findCollectingDraftMessage } from '../draft/collecting'
import type { TaskLaunchDraftPayload } from '../draft/types'
import { resolveMessageAttachmentAbsolutePath, readThreadAttachment } from '../attachments'
import { getMessage, insertMessage, updateMessagePayload } from '../messages'
import {
  autoRenameThreadFromDraft,
  deleteThread,
  getThreadRow,
  renameThread
} from '../../threads/service'
import { TITLE_SOURCE_MANUAL } from '../../threads/types'
import {
  confirmDraftSection,
  getExecutionPlanSnapshot,
  getTaskDraftSnapshot,
  resolveDraftMessageId,
  resolveJobId,
  reviseRequirementsContract,
  updateDraftContent,
  updateJobPlan
} from '../../jobs/draft-plan'
import {
  advanceWizardPhase,
  buildCollectToDraftHandoff,
  requestPhaseRollback,
  resolveWizardPhase
} from '../../wizard/phase'
import type { WizardPhase } from '../../wizard/types'
import {
  isWizardPhase,
  WIZARD_PHASE_COLLECT,
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_EDIT
} from '../../wizard/types'
import { mergeDraftReferences } from '../../jobs/draft-references'
import {
  checkDraftEditAllowed,
  checkExecutionPlanEditAllowed,
  evaluateWizardToolPhaseAccess,
  mcpMutationRejected
} from '../../wizard/edit-guard'
import { conversationMcpToolDefinitionsForPhase } from './tools'
import { getConversationMcpSession } from './session'

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: {
    name?: string
    arguments?: unknown
  }
}

export type McpDispatchResult =
  | { kind: 'notification' }
  | { kind: 'json'; body: Record<string, unknown> }

function jsonRpcOk(id: JsonRpcId, result: Record<string, unknown>): McpDispatchResult {
  return { kind: 'json', body: { jsonrpc: '2.0', id, result } }
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): McpDispatchResult {
  return { kind: 'json', body: { jsonrpc: '2.0', id, error: { code, message } } }
}

function toolTextResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  }
}

async function rejectIfWizardToolPhaseBlocked(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  toolName: string
): Promise<Record<string, unknown> | null> {
  const row = await getThreadRow(session.username, session.threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  const resolvedPhase = resolveWizardPhase(row)
  if (
    session.wizardStage &&
    isWizardPhase(session.wizardStage) &&
    session.wizardStage !== resolvedPhase
  ) {
    console.warn('[conversation-mcp] wizard phase mismatch', {
      threadId: session.threadId,
      sessionId: session.sessionId,
      toolName,
      sessionWizardStage: session.wizardStage,
      resolvedPhase
    })
  }
  const block = evaluateWizardToolPhaseAccess({
    toolName,
    wizardStage: session.wizardStage,
    resolvedPhase
  })
  if (!block) return null
  return toolTextResult(mcpMutationRejected(block.message))
}

async function assertMcpWizardPhase(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  expected: WizardPhase | WizardPhase[]
): Promise<void> {
  if (!session.wizardStage) return
  const row = await getThreadRow(session.username, session.threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  const { assertWizardPhase } = await import('../../wizard/phase')
  assertWizardPhase(resolveWizardPhase(row), expected)
}

async function dispatchTool(
  sessionId: string,
  toolName: string,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const session = getConversationMcpSession(sessionId)
  if (!session) {
    throw AppError.badRequest(`Agent session "${sessionId}" not found or already closed`)
  }

  const phaseRejected = await rejectIfWizardToolPhaseBlocked(session, toolName)
  if (phaseRejected) return phaseRejected

  switch (toolName) {
    case 'read_reference_attachment': {
      const attachmentId =
        argumentsValue &&
        typeof argumentsValue === 'object' &&
        typeof (argumentsValue as Record<string, unknown>).attachmentId === 'string'
          ? ((argumentsValue as Record<string, unknown>).attachmentId as string).trim()
          : ''
      if (!attachmentId) {
        throw AppError.badRequest('attachmentId is required')
      }
      const attachment = session.turnAttachments.find((item) => item.id === attachmentId)
      if (!attachment) {
        return { ok: false, message: 'Attachment not found in this turn' }
      }
      const stored = readThreadAttachment(session.threadId, attachmentId)
      if (!stored) {
        return { ok: false, message: 'Attachment file does not exist' }
      }
      if (stored.attachment.kind === 'image') {
        const absolutePath = resolveMessageAttachmentAbsolutePath(
          session.threadId,
          stored.attachment
        )
        return {
          ok: true,
          attachmentId,
          name: stored.attachment.name,
          mimeType: stored.attachment.mimeType,
          kind: 'image',
          ...(absolutePath ? { path: absolutePath } : {}),
          note: 'Use the Read tool with path to inspect this image.'
        }
      }
      const text = stored.buffer.toString('utf-8')
      return {
        ok: true,
        attachmentId,
        name: stored.attachment.name,
        mimeType: stored.attachment.mimeType,
        kind: 'file',
        text: text.slice(0, 12000)
      }
    }
    case 'propose_task_draft':
      return proposeTaskDraft(session, argumentsValue)
    case 'confirm_requirements_contract':
      return confirmRequirementsContractTool(session, argumentsValue)
    case 'get_task_draft':
      return getTaskDraftTool(session, argumentsValue)
    case 'get_execution_plan':
      return getExecutionPlanTool(session, argumentsValue)
    case 'revise_requirements_contract':
      return reviseRequirementsContractTool(session, argumentsValue)
    case 'update_task_draft':
      return updateTaskDraftTool(session, argumentsValue)
    case 'update_execution_plan_node':
      return updateExecutionPlanNodeTool(session, argumentsValue)
    case 'replace_execution_plan':
      return replaceExecutionPlanTool(session, argumentsValue)
    case 'request_plan_regeneration':
      return requestPlanRegenerationTool(session, argumentsValue)
    case 'confirm_draft_section':
      return confirmDraftSectionTool(session, argumentsValue)
    case 'request_phase_rollback':
      return requestPhaseRollbackTool(session, argumentsValue)
    case 'list_reference_corpus':
      return listReferenceCorpusTool(session, argumentsValue)
    case 'update_reference_corpus_item':
      return updateReferenceCorpusItemTool(session, argumentsValue)
    case 'remove_reference_corpus_item':
      return removeReferenceCorpusItemTool(session, argumentsValue)
    case 'rename_thread':
      return renameThreadTool(session, argumentsValue)
    case 'delete_thread':
      return deleteThreadTool(session)
    default:
      throw AppError.badRequest(`Unknown tool: "${toolName}"`)
  }
}

async function proposeTaskDraft(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  await assertMcpWizardPhase(session, WIZARD_PHASE_COLLECT)

  const raw =
    argumentsValue && typeof argumentsValue === 'object'
      ? sanitizeProposeTaskDraftArguments(argumentsValue as Record<string, unknown>)
      : {}
  const proposed = normalizeProposedTaskDraft(raw)
  if (!proposed) {
    throw AppError.badRequest('invalid task draft proposal payload')
  }

  const sourceMessage = await getMessage(session.username, session.threadId, session.userMessageId)
  if (!sourceMessage) {
    throw AppError.notFound('Source message not found', 'thread.message_not_found')
  }

  const payload = createTaskLaunchDraftPayload({
    draftId: `draft-${randomUUID()}`,
    sourceMessageId: session.userMessageId,
    proposed,
    workspacePath: session.workspacePath,
    sourceAttachments: session.turnAttachments
  })
  const collectingDraft = await findCollectingDraftMessage(session.username, session.threadId)
  const finalizedPayload: TaskLaunchDraftPayload = {
    ...payload,
    collecting: false,
    draftId: collectingDraft
      ? ((collectingDraft.payload as TaskLaunchDraftPayload | undefined)?.draftId ??
        payload.draftId)
      : payload.draftId,
    revision: collectingDraft
      ? ((collectingDraft.payload as TaskLaunchDraftPayload | undefined)?.revision ?? 1)
      : (payload.revision ?? 1)
  }

  let message: Awaited<ReturnType<typeof insertMessage>>
  if (collectingDraft) {
    const db = getDb()
    await db
      .update(threadMessages)
      .set({
        content: `${finalizedPayload.title}\n\n${finalizedPayload.summary}`,
        wizardPhase: WIZARD_PHASE_DRAFT_REVIEW
      })
      .where(eq(threadMessages.id, collectingDraft.id))
    const updated = await updateMessagePayload(
      session.username,
      session.threadId,
      collectingDraft.id,
      draftPayloadToClientJson(finalizedPayload)
    )
    if (!updated) {
      throw AppError.internal('Failed to update collecting draft', 'draft.update_failed')
    }
    message = updated
  } else {
    message = await insertMessage({
      threadId: session.threadId,
      username: session.username,
      role: 'assistant',
      kind: 'task-launch-draft',
      content: `${finalizedPayload.title}\n\n${finalizedPayload.summary}`,
      coreCode: session.coreCode,
      conversationId: session.conversationId,
      runtimeSessionId: null,
      wizardPhase: WIZARD_PHASE_DRAFT_REVIEW,
      payload: draftPayloadToClientJson(finalizedPayload)
    })
  }

  session.onDraftCreated?.(message)
  await autoRenameThreadFromDraft(session.username, session.threadId, finalizedPayload.title)

  await advanceWizardPhase(session.username, session.threadId, {
    to: WIZARD_PHASE_DRAFT_REVIEW,
    coreCode: session.coreCode,
    activeDraftId: message.id,
    activePlanId: null,
    handoff: buildCollectToDraftHandoff({
      draftMessageId: message.id,
      draftRevision: finalizedPayload.revision ?? 1,
      payload: finalizedPayload,
      sourceMessageIds: [session.userMessageId]
    })
  })

  // Keep draft pointer fresh for same-turn get/update. Do not mutate
  // session.wizardStage — it is bound into the MCP capability token for this turn.
  session.activeDraftId = message.id
  session.activePlanId = null

  return {
    accepted: true,
    draftId: finalizedPayload.draftId,
    draftMessageId: message.id,
    draftRevision: finalizedPayload.revision ?? 1,
    title: finalizedPayload.title
  }
}

async function confirmRequirementsContractTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  await assertMcpWizardPhase(session, WIZARD_PHASE_DRAFT_REVIEW)

  const messageId =
    argumentsValue &&
    typeof argumentsValue === 'object' &&
    typeof (argumentsValue as Record<string, unknown>).messageId === 'string'
      ? ((argumentsValue as Record<string, unknown>).messageId as string).trim()
      : ''
  if (!messageId) {
    throw AppError.badRequest('messageId is required')
  }

  const message = await getMessage(session.username, session.threadId, messageId, {
    signAssets: false
  })
  if (!message || message.kind !== 'task-launch-draft') {
    throw AppError.notFound('Task draft message not found', 'draft.not_found')
  }

  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId) {
    throw AppError.badRequest('Task draft payload invalid', 'draft.invalid_payload')
  }

  const confirmedAt = new Date().toISOString()
  const nextPayload = confirmRequirementsContract(payload, confirmedAt)
  await updateMessagePayload(
    session.username,
    session.threadId,
    messageId,
    draftPayloadToClientJson(nextPayload)
  )

  return { accepted: true }
}

async function resolveDraftMessageIdFromSession(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  args: Record<string, unknown>
): Promise<string> {
  return resolveDraftMessageId(session.username, session.threadId, {
    messageId: typeof args.messageId === 'string' ? args.messageId : undefined,
    draftId: typeof args.draftId === 'string' ? args.draftId : undefined,
    activeDraftId: session.activeDraftId
  })
}

async function getTaskDraftTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const messageId = await resolveDraftMessageIdFromSession(session, args)
  const snapshot = await getTaskDraftSnapshot(session.username, session.threadId, messageId)
  return { ok: true, ...snapshot }
}

async function resolveJobIdFromSession(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  args: Record<string, unknown>
): Promise<string> {
  return resolveJobId(session.username, session.threadId, {
    jobId: typeof args.jobId === 'string' ? args.jobId : undefined,
    activePlanId: session.activePlanId
  })
}

async function getExecutionPlanTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const jobId = await resolveJobIdFromSession(session, args)
  const snapshot = await getExecutionPlanSnapshot(session.username, session.threadId, jobId)
  return { ok: true, ...snapshot }
}

async function reviseRequirementsContractTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const messageId = await resolveDraftMessageIdFromSession(session, args)
  const draftGuard = await checkDraftEditAllowed({
    username: session.username,
    threadId: session.threadId,
    draftMessageId: messageId
  })
  if (!draftGuard.allowed) {
    return toolTextResult(
      mcpMutationRejected(draftGuard.message, {
        unlockRequired: draftGuard.unlockRequired ?? false
      })
    )
  }

  await assertMcpWizardPhase(session, WIZARD_PHASE_DRAFT_REVIEW)
  const revision =
    typeof args.revision === 'number' && Number.isFinite(args.revision)
      ? Math.floor(args.revision)
      : NaN
  if (!Number.isFinite(revision)) {
    throw AppError.badRequest('revision is required (from get_task_draft)')
  }

  const replacements = Array.isArray(args.replacements)
    ? args.replacements
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const row = item as Record<string, unknown>
          return {
            find: typeof row.find === 'string' ? row.find : '',
            replace: typeof row.replace === 'string' ? row.replace : ''
          }
        })
    : undefined

  try {
    const result = await reviseRequirementsContract(session.username, session.threadId, messageId, {
      revision,
      replacements,
      requirementsContractMarkdown:
        typeof args.requirementsContractMarkdown === 'string'
          ? args.requirementsContractMarkdown
          : undefined,
      syncStructuredFields:
        typeof args.syncStructuredFields === 'boolean' ? args.syncStructuredFields : undefined
    })

    return {
      accepted: true,
      messageId: result.messageId,
      draftRevision: result.draftRevision,
      requirementsContractMarkdown: result.requirementsContractMarkdown
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to revise requirements contract'
    return toolTextResult(mcpMutationRejected(message))
  }
}

async function updateTaskDraftTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const messageId = await resolveDraftMessageIdFromSession(session, args)
  const draftGuard = await checkDraftEditAllowed({
    username: session.username,
    threadId: session.threadId,
    draftMessageId: messageId
  })
  if (!draftGuard.allowed) {
    return toolTextResult(
      mcpMutationRejected(draftGuard.message, {
        unlockRequired: draftGuard.unlockRequired ?? false
      })
    )
  }

  await assertMcpWizardPhase(session, WIZARD_PHASE_DRAFT_REVIEW)

  const revision =
    typeof args.revision === 'number' && Number.isFinite(args.revision)
      ? Math.floor(args.revision)
      : undefined
  try {
    const result = await updateDraftContent(session.username, session.threadId, messageId, {
      title: typeof args.title === 'string' ? args.title : undefined,
      summary: typeof args.summary === 'string' ? args.summary : undefined,
      userFlow: typeof args.userFlow === 'string' ? args.userFlow : undefined,
      techStack: typeof args.techStack === 'string' ? args.techStack : undefined,
      requirementsContractMarkdown:
        typeof args.requirementsContractMarkdown === 'string'
          ? args.requirementsContractMarkdown
          : undefined,
      revision
    })
    if (result.skippedLockedSections.length > 0) {
      return toolTextResult({
        accepted: true,
        messageId: result.messageId,
        draftRevision: (result.payload as { revision?: number }).revision,
        requirementsContractSynced: result.requirementsContractSynced,
        skippedLockedSections: result.skippedLockedSections,
        warning: `Some fields were locked and not updated: ${result.skippedLockedSections.join(', ')}`
      })
    }
    return {
      accepted: true,
      messageId: result.messageId,
      draftRevision: (result.payload as { revision?: number }).revision,
      requirementsContractSynced: result.requirementsContractSynced,
      skippedLockedSections: result.skippedLockedSections
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update draft'
    return toolTextResult(mcpMutationRejected(message))
  }
}

async function updateExecutionPlanNodeTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const jobId = typeof args.jobId === 'string' ? args.jobId.trim() : ''
  const nodeRef = typeof args.nodeRef === 'string' ? args.nodeRef.trim() : ''
  if (!jobId) throw AppError.badRequest('jobId is required')
  if (!nodeRef) throw AppError.badRequest('nodeRef is required')

  const planGuard = await checkExecutionPlanEditAllowed({
    username: session.username,
    threadId: session.threadId,
    planOrSessionId: jobId
  })
  if (!planGuard.allowed) {
    return toolTextResult(mcpMutationRejected(planGuard.message, { reason: planGuard.reason }))
  }

  await assertMcpWizardPhase(session, WIZARD_PHASE_PLAN_EDIT)

  const expectedPlanRevision =
    typeof args.expectedPlanRevision === 'number' && Number.isFinite(args.expectedPlanRevision)
      ? Math.floor(args.expectedPlanRevision)
      : undefined

  try {
    const job = await updateJobPlan(session.username, session.threadId, jobId, {
      nodeRef,
      expectedPlanRevision,
      title: typeof args.title === 'string' ? args.title : undefined,
      description: typeof args.description === 'string' ? args.description : undefined,
      successCriteria: typeof args.successCriteria === 'string' ? args.successCriteria : undefined,
      contextMarkdown: typeof args.contextMarkdown === 'string' ? args.contextMarkdown : undefined,
      abilityCode: typeof args.abilityCode === 'string' ? args.abilityCode : undefined,
      referenceIds: Array.isArray(args.referenceIds)
        ? args.referenceIds.filter((item): item is string => typeof item === 'string')
        : undefined,
      referenceReason: typeof args.referenceReason === 'string' ? args.referenceReason : undefined
    })
    session.onPlanUpdated?.(job)
    return {
      accepted: true,
      jobId: job.id,
      nodeRef,
      planRevision: expectedPlanRevision !== undefined ? expectedPlanRevision + 1 : undefined,
      status: job.status
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update execution tree'
    return toolTextResult(mcpMutationRejected(message))
  }
}

async function resolveDesignSessionIdFromPlanArgs(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  args: Record<string, unknown>
): Promise<string> {
  const explicit =
    typeof args.designSessionId === 'string'
      ? args.designSessionId.trim()
      : typeof args.jobId === 'string'
        ? args.jobId.trim()
        : ''
  if (explicit) return explicit

  const active = session.activePlanId?.trim()
  if (active) return active

  throw AppError.badRequest('jobId / activePlanId is required', 'job.invalid_id')
}

async function replaceExecutionPlanTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const expectedPlanRevision =
    typeof args.expectedPlanRevision === 'number' && Number.isFinite(args.expectedPlanRevision)
      ? Math.floor(args.expectedPlanRevision)
      : NaN
  if (!Number.isFinite(expectedPlanRevision)) {
    throw AppError.badRequest('expectedPlanRevision is required (from get_execution_plan)')
  }
  if (!Array.isArray(args.milestones) || args.milestones.length === 0) {
    throw AppError.badRequest('milestones must be a non-empty array')
  }

  const designSessionId = await resolveDesignSessionIdFromPlanArgs(session, args)
  const planGuard = await checkExecutionPlanEditAllowed({
    username: session.username,
    threadId: session.threadId,
    planOrSessionId: designSessionId
  })
  if (!planGuard.allowed) {
    return toolTextResult(mcpMutationRejected(planGuard.message, { reason: planGuard.reason }))
  }

  await assertMcpWizardPhase(session, WIZARD_PHASE_PLAN_EDIT)

  try {
    const { replaceExecutionPlan } = await import('../../plan-service/service')
    const job = await replaceExecutionPlan(session.username, session.threadId, {
      designSessionId,
      expectedPlanRevision,
      milestones: args.milestones
    })
    session.onPlanUpdated?.(job)
    return {
      accepted: true,
      designSessionId: job.id,
      planRevision: expectedPlanRevision + 1,
      status: job.status
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to replace execution tree'
    return toolTextResult(mcpMutationRejected(message))
  }
}

async function requestPlanRegenerationTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const expectedPlanRevision =
    typeof args.expectedPlanRevision === 'number' && Number.isFinite(args.expectedPlanRevision)
      ? Math.floor(args.expectedPlanRevision)
      : NaN
  if (!Number.isFinite(expectedPlanRevision)) {
    throw AppError.badRequest('expectedPlanRevision is required (from get_execution_plan)')
  }
  const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : ''
  if (!instruction) throw AppError.badRequest('instruction is required')

  const designSessionId = await resolveDesignSessionIdFromPlanArgs(session, args)
  const planGuard = await checkExecutionPlanEditAllowed({
    username: session.username,
    threadId: session.threadId,
    planOrSessionId: designSessionId
  })
  if (!planGuard.allowed) {
    return toolTextResult(mcpMutationRejected(planGuard.message, { reason: planGuard.reason }))
  }

  await assertMcpWizardPhase(session, WIZARD_PHASE_PLAN_EDIT)

  try {
    const { requestPlanRegeneration } = await import('../../plan-service/service')
    const job = await requestPlanRegeneration(session.username, session.threadId, {
      designSessionId,
      expectedPlanRevision,
      instruction
    })
    session.onPlanUpdated?.(job)
    return {
      accepted: true,
      designSessionId: job.id,
      status: job.status,
      message: 'Plan regeneration started; poll get_execution_plan until planReady is true.'
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to request execution tree regeneration'
    return toolTextResult(mcpMutationRejected(message))
  }
}

async function confirmDraftSectionTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  await assertMcpWizardPhase(session, WIZARD_PHASE_DRAFT_REVIEW)

  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const section = typeof args.section === 'string' ? args.section.trim() : ''
  if (!section) throw AppError.badRequest('section is required')
  const messageId = await resolveDraftMessageIdFromSession(session, args)
  await confirmDraftSection(
    session.username,
    session.threadId,
    messageId,
    section as Parameters<typeof confirmDraftSection>[3]
  )
  return { accepted: true, section }
}

async function resolveDesignSessionIdFromArgs(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  args: Record<string, unknown>
): Promise<string | null> {
  const explicit =
    typeof args.designSessionId === 'string'
      ? args.designSessionId.trim()
      : typeof args.jobId === 'string'
        ? args.jobId.trim()
        : ''
  if (explicit) return explicit

  const messageId = await resolveDraftMessageIdFromSession(session, args)
  const message = await getMessage(session.username, session.threadId, messageId, {
    signAssets: false
  })
  const payload = message?.payload as TaskLaunchDraftPayload | undefined
  return payload?.linkedPlanId?.trim() || null
}

async function listReferenceCorpusTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}

  const designSessionId = await resolveDesignSessionIdFromArgs(session, args)
  if (designSessionId) {
    const { listReferenceCorpus } = await import('../../reference-corpus/service')
    const references = await listReferenceCorpus(designSessionId)
    return { references, designSessionId }
  }

  const messageId = await resolveDraftMessageIdFromSession(session, args)
  const message = await getMessage(session.username, session.threadId, messageId, {
    signAssets: false
  })
  const payload = message?.payload as TaskLaunchDraftPayload | undefined
  if (!payload) throw AppError.notFound('Draft not found', 'draft.not_found')
  const references = mergeDraftReferences(payload).map((ref) => ({
    id: ref.id,
    source: ref.source === 'local_corpus' ? 'local_corpus' : 'attachment',
    name: ref.name,
    kind: ref.kind,
    description: ref.description ?? '',
    localPath: ref.localPath
  }))
  return { references }
}

async function updateReferenceCorpusItemTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const referenceId = typeof args.referenceId === 'string' ? args.referenceId.trim() : ''
  if (!referenceId) throw AppError.badRequest('referenceId is required')

  const designSessionId = await resolveDesignSessionIdFromArgs(session, args)
  if (designSessionId) {
    const { updateCorpusItem } = await import('../../reference-corpus/service')
    const reference = await updateCorpusItem({
      username: session.username,
      threadId: session.threadId,
      designSessionId,
      refId: referenceId,
      description: typeof args.description === 'string' ? args.description : undefined,
      name: typeof args.name === 'string' ? args.name : undefined
    })
    return { accepted: true, reference, designSessionId }
  }

  const { updateDraftReferenceDescription } = await import('../../jobs/service')
  const messageId = await resolveDraftMessageIdFromSession(session, args)
  if (typeof args.description !== 'string') {
    throw AppError.badRequest('description is required for draft references')
  }
  await updateDraftReferenceDescription(
    session.username,
    session.threadId,
    messageId,
    referenceId,
    args.description
  )
  return { accepted: true, referenceId }
}

async function removeReferenceCorpusItemTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const referenceId = typeof args.referenceId === 'string' ? args.referenceId.trim() : ''
  if (!referenceId) throw AppError.badRequest('referenceId is required')

  const designSessionId = await resolveDesignSessionIdFromArgs(session, args)
  if (designSessionId) {
    const { removeCorpusItem } = await import('../../reference-corpus/service')
    await removeCorpusItem({
      username: session.username,
      threadId: session.threadId,
      designSessionId,
      refId: referenceId
    })
    return { accepted: true, referenceId, designSessionId }
  }

  const { deleteDraftReference } = await import('../../jobs/service')
  const messageId = await resolveDraftMessageIdFromSession(session, args)
  await deleteDraftReference(session.username, session.threadId, messageId, referenceId)
  return { accepted: true, referenceId }
}

async function requestPhaseRollbackTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}
  const to = typeof args.to === 'string' ? args.to.trim() : ''
  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  if (!isWizardPhase(to) || (to !== WIZARD_PHASE_COLLECT && to !== WIZARD_PHASE_DRAFT_REVIEW)) {
    throw AppError.badRequest('to must be collect or draft_review')
  }
  if (!reason) throw AppError.badRequest('reason is required')

  const thread = await requestPhaseRollback(session.username, session.threadId, {
    to,
    reason,
    coreCode: session.coreCode
  })
  return { accepted: true, wizardPhase: thread.wizardPhase }
}

async function renameThreadTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const title =
    argumentsValue &&
    typeof argumentsValue === 'object' &&
    typeof (argumentsValue as Record<string, unknown>).title === 'string'
      ? ((argumentsValue as Record<string, unknown>).title as string).trim()
      : ''
  if (!title) throw AppError.badRequest('title is required')
  const thread = await renameThread(session.username, session.threadId, title, {
    titleSource: TITLE_SOURCE_MANUAL
  })
  return { accepted: true, title: thread.title }
}

async function deleteThreadTool(
  session: NonNullable<ReturnType<typeof getConversationMcpSession>>
): Promise<Record<string, unknown>> {
  await deleteThread(session.username, session.threadId)
  return { accepted: true, deleted: true }
}

export async function handleConversationMcpJsonRpc(
  sessionId: string,
  body: unknown
): Promise<McpDispatchResult> {
  if (!body || typeof body !== 'object') {
    return jsonRpcError(null, -32600, 'Invalid request')
  }

  const request = body as JsonRpcRequest
  const id = request.id ?? null
  const method = request.method ?? ''

  if (request.id === undefined && method.startsWith('notifications/')) {
    return { kind: 'notification' }
  }

  if (method === 'initialize') {
    return jsonRpcOk(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'codetask-conversation', version: '1.0.0' }
    })
  }

  if (method === 'tools/list') {
    const session = getConversationMcpSession(sessionId)
    let phase: WizardPhase | null = null
    if (session) {
      const row = await getThreadRow(session.username, session.threadId)
      if (row) phase = resolveWizardPhase(row)
    }
    const tools = conversationMcpToolDefinitionsForPhase(phase)
    return jsonRpcOk(id, { tools })
  }

  if (method !== 'tools/call') {
    if (request.id === undefined) return { kind: 'notification' }
    return jsonRpcError(id, -32601, `Method not found: "${method}"`)
  }

  const toolName = request.params?.name ?? ''
  const toolArguments = request.params?.arguments ?? {}

  try {
    const value = await dispatchTool(sessionId, toolName, toolArguments)
    console.info('[conversation-mcp] tools/call ok', { sessionId, toolName })
    return jsonRpcOk(id, toolTextResult(value))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP tool failed'
    console.warn('[conversation-mcp] tools/call failed', { sessionId, toolName, message })
    return jsonRpcError(id, -32000, message)
  }
}

export function handleStubMcpJsonRpc(serverName: string, body: unknown): McpDispatchResult {
  if (!body || typeof body !== 'object') {
    return jsonRpcError(null, -32600, 'Invalid request')
  }
  const request = body as JsonRpcRequest
  const id = request.id ?? null
  const method = request.method ?? ''

  if (request.id === undefined && method.startsWith('notifications/')) {
    return { kind: 'notification' }
  }

  if (method === 'initialize') {
    return jsonRpcOk(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: '1.0.0' }
    })
  }

  if (method === 'tools/list') {
    return jsonRpcOk(id, { tools: [] })
  }

  if (method === 'tools/call') {
    return jsonRpcError(id, -32000, 'MCP orchestration is not enabled for this role')
  }

  if (request.id === undefined) return { kind: 'notification' }
  return jsonRpcError(id, -32601, `Method not found: "${method}"`)
}
