import type {
  ConversationDto,
  ConversationMessageDto,
  ConversationTurnDto,
  ConversationTurnState,
  ProviderCode,
  TitleSource,
  WorkspaceAccessMode
} from '@codetask/contracts'

export type ConversationRecord = {
  id: string
  actorId: string
  projectId: string
  title: string
  titleSource: TitleSource
  providerCode: ProviderCode
  state: 'active' | 'archived'
  stateRevision: number
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export type MessageRecord = {
  id: string
  conversationId: string
  turnId: string | null
  role: 'user' | 'assistant' | 'system'
  kind: 'text'
  content: string
  providerCode: ProviderCode | null
  model: string | null
  thinkingText: string | null
  thinkingDurationMs: number | null
  createdAt: string
  attachments?: Array<{
    id: string
    assetId: string
    name: string
    mimeType: string
    sizeBytes: number
    kind: 'image' | 'file'
    sortOrder: number
  }>
}

export type TurnRecord = {
  id: string
  conversationId: string
  actorId: string
  state: ConversationTurnState
  inputText: string
  providerCode: ProviderCode
  workspaceAccess: WorkspaceAccessMode
  settingsSnapshotJson: string
  settingsHash: string
  idempotencyKey: string | null
  requestHash: string
  stateRevision: number
  userMessageId: string | null
  assistantMessageId: string | null
  lastErrorJson: string | null
  createdAt: string
  admittedAt: string | null
  startedAt: string | null
  completedAt: string | null
}

export const ACTIVE_TURN_STATES: ConversationTurnState[] = [
  'admitted',
  'running',
  'committing',
  'cancelling'
]

export function toConversationDto(row: ConversationRecord): ConversationDto {
  return {
    id: row.id,
    actorId: row.actorId,
    projectId: row.projectId,
    title: row.title,
    titleSource: row.titleSource,
    providerCode: row.providerCode,
    state: row.state,
    stateRevision: row.stateRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {})
  }
}

export function toMessageDto(row: MessageRecord): ConversationMessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    role: row.role,
    kind: 'text',
    content: row.content,
    ...(row.providerCode ? { providerCode: row.providerCode } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.thinkingText ? { thinking: row.thinkingText } : {}),
    ...(row.thinkingDurationMs != null ? { thinkingDurationMs: row.thinkingDurationMs } : {}),
    createdAt: row.createdAt,
    ...(row.attachments?.length
      ? {
          attachments: row.attachments.map((a) => ({
            id: a.id,
            assetId: a.assetId,
            name: a.name,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            kind: a.kind,
            sortOrder: a.sortOrder
          }))
        }
      : {})
  }
}

export function toTurnDto(
  row: TurnRecord,
  queuePosition: number | null = null
): ConversationTurnDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    actorId: row.actorId,
    state: row.state,
    inputText: row.inputText,
    providerCode: row.providerCode,
    workspaceAccess: row.workspaceAccess,
    queuePosition,
    stateRevision: row.stateRevision,
    ...(row.userMessageId ? { userMessageId: row.userMessageId } : {}),
    ...(row.assistantMessageId ? { assistantMessageId: row.assistantMessageId } : {}),
    lastError: row.lastErrorJson
      ? (JSON.parse(row.lastErrorJson) as ConversationTurnDto['lastError'])
      : null,
    createdAt: row.createdAt,
    ...(row.admittedAt ? { admittedAt: row.admittedAt } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {})
  }
}
