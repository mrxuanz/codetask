import type { ProviderCode } from '@codetask/contracts'
import type { AgentRuntime } from '@codetask/agent-runtime'
import type { ConversationRecord, MessageRecord, TurnRecord } from '../domain/conversation.ts'

export type WorkspaceResolverPort = {
  resolveWorkspaceRoot(input: { actorId: string; projectId: string }): Promise<{
    projectId: string
    workspaceRoot: string
    canonicalWorkspaceRoot: string
  }>
}

export type WorkspaceLeasePort = {
  tryAcquireExclusive(input: { workspaceRoot: string; ownerId: string }): { leaseId: string } | null
  release(leaseId: string): void
}

export type ConversationRealtimePort = {
  publish(topic: string, event: string, payload: Record<string, unknown>): void
}

export type AttachmentMeta = {
  id: string
  assetId: string
  name: string
  mimeType: string
  sizeBytes: number
  kind: 'image' | 'file'
  sortOrder: number
}

export type MessageAttachmentRecord = AttachmentMeta & {
  messageId: string
  conversationId: string
  createdAt: string
}

export type ResolvedTurnAttachments = {
  attachments: AttachmentMeta[]
  readRoots: string[]
  promptAppendix: string
}

export type AttachmentResolverPort = {
  resolveForTurn(input: {
    conversationId: string
    attachmentIds: string[]
  }): ResolvedTurnAttachments
}

/** Host binds Conversation system MCP (read_reference_attachment) for one turn. */
export type ConversationSystemMcpBinding = {
  mcpServers: Array<{ name: string; url: string; headers?: Record<string, string> }>
  release: () => void
}

export type ConversationSystemMcpPort = {
  bindForTurn(input: {
    sessionId: string
    conversationId: string
    actorId: string
    providerCode: string
    workspaceRoot: string
    userMessageId: string
    attachments: AttachmentMeta[]
  }): ConversationSystemMcpBinding
}

export type ConversationRepository = {
  insert(row: ConversationRecord): void
  get(id: string): ConversationRecord | null
  listForActor(actorId: string): ConversationRecord[]
  listForProject(actorId: string, projectId: string): ConversationRecord[]
  update(row: ConversationRecord): void
  delete(id: string): void
}

export type MessageRepository = {
  insert(row: MessageRecord): void
  insertAttachments(rows: MessageAttachmentRecord[]): void
  listAttachments(conversationId: string, messageIds: string[]): MessageAttachmentRecord[]
  list(conversationId: string, limit: number): MessageRecord[]
  deleteForConversation(conversationId: string): void
}

export type TurnRepository = {
  insert(row: TurnRecord): void
  get(id: string): TurnRecord | null
  getByIdempotency(actorId: string, key: string): TurnRecord | null
  update(row: TurnRecord): void
  countActiveForActor(actorId: string): number
  hasActiveForConversation(conversationId: string): boolean
  listQueued(actorId?: string): TurnRecord[]
  countQueuedAhead(conversationId: string, createdAt: string, turnId: string): number
  deleteForConversation(conversationId: string): void
}

export type ConversationModulePorts = {
  conversations: ConversationRepository
  messages: MessageRepository
  turns: TurnRepository
  agentRuntime: AgentRuntime
  workspace: WorkspaceResolverPort
  leases: WorkspaceLeasePort
  realtime: ConversationRealtimePort
  /** Host filesystem / asset store — optional for unit tests without attachments. */
  attachments?: AttachmentResolverPort
  /** Host Conversation system MCP — optional when HTTP MCP port is unavailable. */
  systemMcp?: ConversationSystemMcpPort
  maxConcurrentTurnsPerUser: number
  defaultProviderCode: ProviderCode
  resolveSystemPrompt: () => string
  captureSettingsForTurn?: (provider: ProviderCode) => {
    promptBody: string | null
    mcpServers: Record<string, unknown>
    sourceRevisions: unknown[]
    contentHash: string
  }
}
