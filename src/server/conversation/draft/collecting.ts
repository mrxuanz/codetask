import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { threads } from '../../db/schema'
import type { ConversationMessageDto } from '../types'
import { getMessage, insertMessage, listMessages } from '../messages'
import { bindPayloadWorkspace, draftPayloadToClientJson } from './normalize'
import type { TaskLaunchDraftPayload } from './types'
import { WIZARD_PHASE_COLLECT } from '../../wizard/types'

export function isCollectingDraftPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  if (record.collecting !== true) return false

  const contractMarkdown =
    typeof (record.requirementsContract as { markdown?: string } | undefined)?.markdown === 'string'
      ? (record.requirementsContract as { markdown: string }).markdown.trim()
      : ''
  if (contractMarkdown) return false

  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  if (summary) return false

  if (record.status === 'confirmed') return false

  return true
}

export function createCollectingDraftPayload(input: {
  draftId: string
  sourceMessageId: string
  title: string
  workspacePath: string
}): TaskLaunchDraftPayload {
  const title = input.title.trim() || 'New Task'
  return bindPayloadWorkspace(
    {
      draftId: input.draftId,
      sourceMessageId: input.sourceMessageId,
      title,
      summary: '',
      userFlow: '',
      techStack: '',
      nfr: [],
      acceptance: [],
      verification: [],
      outOfScope: [],
      assumptions: [],
      requirementsContract: { markdown: '', status: 'pending', confirmedAt: null },
      workspacePath: '',
      status: 'editing',
      linkedPlanId: null,
      lockedSections: {},
      abilities: [],
      references: [],
      sourceAttachments: [],
      revision: 1,
      collecting: true
    },
    input.workspacePath
  )
}

export async function findCollectingDraftMessage(
  username: string,
  threadId: string
): Promise<ConversationMessageDto | null> {
  const messages = await listMessages(username, threadId, 100)
  return (
    messages.find(
      (message) => message.kind === 'task-launch-draft' && isCollectingDraftPayload(message.payload)
    ) ?? null
  )
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export async function ensureCollectingDraft(input: {
  username: string
  threadId: string
  threadTitle: string
  sourceMessageId: string
  workspacePath: string
  coreCode: string
  conversationId: string
}): Promise<{ message: ConversationMessageDto; created: boolean }> {
  const existing = await findCollectingDraftMessage(input.username, input.threadId)
  if (existing) {
    const db = getDb()
    await db
      .update(threads)
      .set({
        activeDraftId: existing.id,
        wizardPhase: WIZARD_PHASE_COLLECT,
        updatedAt: nowSec()
      })
      .where(and(eq(threads.username, input.username), eq(threads.id, input.threadId)))
    return { message: existing, created: false }
  }

  const payload = createCollectingDraftPayload({
    draftId: `draft-${randomUUID()}`,
    sourceMessageId: input.sourceMessageId,
    title: input.threadTitle,
    workspacePath: input.workspacePath
  })

  const message = await insertMessage({
    threadId: input.threadId,
    username: input.username,
    role: 'assistant',
    kind: 'task-launch-draft',
    content: payload.title,
    coreCode: input.coreCode,
    conversationId: input.conversationId,
    runtimeSessionId: null,
    wizardPhase: WIZARD_PHASE_COLLECT,
    payload: draftPayloadToClientJson(payload)
  })

  const db = getDb()
  await db
    .update(threads)
    .set({
      activeDraftId: message.id,
      wizardPhase: WIZARD_PHASE_COLLECT,
      updatedAt: nowSec()
    })
    .where(and(eq(threads.username, input.username), eq(threads.id, input.threadId)))

  const refreshed = await getMessage(input.username, input.threadId, message.id)
  if (!refreshed) {
    throw new Error('Failed to read collecting draft after creation')
  }
  return { message: refreshed, created: true }
}
