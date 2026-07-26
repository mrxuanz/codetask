import {
  asDraftId,
  createDraft,
  updateCollectingContent,
  type Draft
} from '../../domain/drafts/index'
import {
  asProjectId,
  asThreadId,
  asUserId,
  createThread,
  withThreadPointers,
  type Thread
} from '../../domain/conversation/index'
import type { DraftRepo, ThreadRepo } from '../ports/repositories'
import type { IdGenerator } from '../ports/id-generator'
import type { UnitOfWork } from '../ports/unit-of-work'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult } from '../commands/helpers'
import {
  assertNotAborted,
  resolveWorkSignal,
  type WorkContext
} from './work-context'

export type ConversationTurnWorkInput = {
  readonly threadId: string
  readonly projectId: string
  readonly ownerUserId: string
  readonly message: string
  /** When true (or generateDraft), ensure a collecting draft captures the message. */
  readonly createTaskMode?: boolean
  readonly generateDraft?: boolean
  readonly draftId?: string
  /** AbortSignal accepted on the work signature (also via WorkContext). */
  readonly signal?: AbortSignal
}

export type ConversationTurnWorkResult = {
  readonly turnId: string
  readonly status: 'completed' | 'aborted'
  readonly thread: Thread
  readonly draft: Draft | null
  readonly assistantContent: string
}

export type ConversationTurnWorkDeps = {
  readonly threads: ThreadRepo
  readonly drafts: DraftRepo
  readonly ids: IdGenerator
  readonly unitOfWork: UnitOfWork
}

/**
 * Deterministic conversation turn work — no Provider SDKs, no prompt assembly.
 * Prompt/template concerns live in skills only (重构.md §7 / Wave 5 T170).
 */
export async function conversationTurnWork(
  deps: ConversationTurnWorkDeps,
  input: ConversationTurnWorkInput,
  context?: WorkContext
): Promise<CommandResult<ConversationTurnWorkResult>> {
  const signal = resolveWorkSignal(context, input.signal)
  try {
    assertNotAborted(signal)

    if (!input.message.trim()) {
      return fail('message.empty', 'Message cannot be empty')
    }

    return await deps.unitOfWork.run(async (tx) => {
      assertNotAborted(signal)

      let thread = await deps.threads.get(input.threadId)
      if (!thread) {
        thread = createThread({
          id: asThreadId(input.threadId),
          projectId: asProjectId(input.projectId),
          ownerUserId: asUserId(input.ownerUserId)
        })
      }

      const wantsDraft = Boolean(input.createTaskMode || input.generateDraft)
      let draft: Draft | null = null

      if (wantsDraft) {
        const draftId = input.draftId ?? thread.draftId ?? deps.ids.next()
        const existing = await deps.drafts.get(draftId)
        if (existing) {
          if (existing.status !== 'collecting') {
            return fail(
              'draft.not_collecting',
              `Cannot mutate draft in status ${existing.status}`
            )
          }
          draft = updateCollectingContent(existing, input.message)
          await deps.drafts.save(draft, { expectedRevision: existing.revision })
        } else {
          draft = createDraft({
            id: asDraftId(draftId),
            projectId: input.projectId,
            threadId: input.threadId,
            content: input.message
          })
          await deps.drafts.save(draft)
        }
        thread = withThreadPointers(thread, { draftId: draft.id })
      }

      await deps.threads.save(thread)
      const turnId = deps.ids.next()
      tx.enqueueEvent({ type: 'conversation.turn.completed', aggregateId: turnId })

      assertNotAborted(signal)

      return {
        ok: true as const,
        value: {
          turnId,
          status: 'completed' as const,
          thread,
          draft,
          // Stub assistant text — real replies come from Provider work in later waves.
          assistantContent: wantsDraft
            ? 'Draft updated from conversation turn.'
            : 'Acknowledged.'
        }
      }
    })
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'work.aborted')) {
      return fail('work.aborted', error.message)
    }
    return mapThrownToResult(error)
  }
}
