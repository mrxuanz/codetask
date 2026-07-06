export type TitleSource = 'auto' | 'manual'
export type ThreadKind = 'chat' | 'create_task'
export type WizardPhase =
  | 'collect'
  | 'draft_review'
  | 'plan_generating'
  | 'plan_edit'
  | 'ready_to_launch'

import type { TurnErrorDto } from './turn-errors'

export interface ThreadDto {
  id: string
  projectId: string
  username: string
  title: string
  titleSource: TitleSource
  activeDraftId: string | null
  activePlanId: string | null
  wizardPhase: WizardPhase
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
