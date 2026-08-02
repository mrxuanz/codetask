export type TitleSource = 'auto' | 'manual'
/** Ordinary chat only after architecture 03. */
export type ThreadKind = 'chat'
export const THREAD_KIND_CHAT: ThreadKind = 'chat'

import type { TurnErrorDto } from './turn-errors'

/** UI-facing conversation shape used by the renderer façade. */
export interface ThreadDto {
  id: string
  projectId: string
  username: string
  title: string
  titleSource: TitleSource
  threadKind: ThreadKind
  status: string
  conversationId: string
  coreCode: string
  runtimeStatus: string
  runtimeSessionId: string | null
  lastError: TurnErrorDto | null
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}
