import { listMessages } from './messages'
import {
  buildThreadTitleSeed,
  canReplaceThreadTitle,
  canSeedThreadTitle,
  isFirstUserMessage
} from './thread-title-logic'
import type { ThreadDto } from '../threads/types'
import { getThreadRow, renameThread } from '../threads/service'

export {
  buildThreadTitleSeed,
  canReplaceThreadTitle,
  canSeedThreadTitle,
  isFirstUserMessage,
  sanitizeThreadTitle
} from './thread-title-logic'

export async function maybeSeedThreadTitleFromFirstMessage(
  username: string,
  threadId: string,
  input: {
    userMessage: string
    imageAttachmentName?: string | null
  }
): Promise<ThreadDto | null> {
  const row = await getThreadRow(username, threadId)
  if (!row || !canSeedThreadTitle(row)) return null

  const messages = await listMessages(username, threadId, 10)
  if (!isFirstUserMessage(messages)) return null

  const titleSeed = buildThreadTitleSeed(input)
  if (!titleSeed || !canReplaceThreadTitle(row.title, titleSeed)) return null

  const latest = await getThreadRow(username, threadId)
  if (!latest || !canSeedThreadTitle(latest)) return null
  if (!canReplaceThreadTitle(latest.title, titleSeed)) return null

  return renameThread(username, threadId, titleSeed, { titleSource: 'auto' })
}
