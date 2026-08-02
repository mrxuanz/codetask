import { Type, type Static } from '@sinclair/typebox'
import { ProviderCodeSchema } from './execution.ts'

export const ConversationStateSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('archived')
])

export const TitleSourceSchema = Type.Union([Type.Literal('auto'), Type.Literal('manual')])

export const MessageRoleSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('system')
])

export const MessageKindSchema = Type.Literal('text')

export const WorkspaceAccessModeSchema = Type.Union([
  Type.Literal('metadata'),
  Type.Literal('live-read'),
  Type.Literal('exclusive-write')
])

export const ConversationTurnStateSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('admitted'),
  Type.Literal('running'),
  Type.Literal('committing'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelling'),
  Type.Literal('cancelled')
])

export const CapabilityProfileSchema = Type.Union([
  Type.Literal('chat-read'),
  Type.Literal('chat-write'),
  Type.Literal('planner-read'),
  Type.Literal('task-sandbox'),
  Type.Literal('verifier-sandbox')
])

export const ConversationDtoSchema = Type.Object({
  id: Type.String(),
  actorId: Type.String(),
  projectId: Type.String(),
  title: Type.String(),
  titleSource: TitleSourceSchema,
  providerCode: ProviderCodeSchema,
  state: ConversationStateSchema,
  stateRevision: Type.Integer({ minimum: 0 }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  lastUsedAt: Type.Optional(Type.String())
})

export const ConversationMessageDtoSchema = Type.Object({
  id: Type.String(),
  conversationId: Type.String(),
  turnId: Type.Optional(Type.String()),
  role: MessageRoleSchema,
  kind: MessageKindSchema,
  content: Type.String(),
  providerCode: Type.Optional(ProviderCodeSchema),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  thinkingDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  createdAt: Type.String(),
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        assetId: Type.String(),
        name: Type.String(),
        mimeType: Type.String(),
        sizeBytes: Type.Integer({ minimum: 0 }),
        kind: Type.Union([Type.Literal('image'), Type.Literal('file')]),
        sortOrder: Type.Integer({ minimum: 0 })
      })
    )
  )
})

export const ConversationAttachmentDtoSchema = Type.Object({
  id: Type.String(),
  messageId: Type.Optional(Type.String()),
  assetId: Type.String(),
  name: Type.String(),
  mimeType: Type.String(),
  sizeBytes: Type.Integer({ minimum: 0 }),
  kind: Type.Union([Type.Literal('image'), Type.Literal('file')]),
  sortOrder: Type.Integer({ minimum: 0 })
})

export const TurnErrorDtoSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  detail: Type.Optional(Type.String()),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
})

export const ConversationTurnDtoSchema = Type.Object({
  id: Type.String(),
  conversationId: Type.String(),
  actorId: Type.String(),
  state: ConversationTurnStateSchema,
  inputText: Type.String(),
  providerCode: ProviderCodeSchema,
  workspaceAccess: WorkspaceAccessModeSchema,
  queuePosition: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  stateRevision: Type.Integer({ minimum: 0 }),
  userMessageId: Type.Optional(Type.String()),
  assistantMessageId: Type.Optional(Type.String()),
  lastError: Type.Union([TurnErrorDtoSchema, Type.Null()]),
  createdAt: Type.String(),
  admittedAt: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String())
})

export const CreateConversationBodySchema = Type.Object({
  title: Type.Optional(Type.String()),
  providerCode: Type.Optional(ProviderCodeSchema)
})

export const RenameConversationBodySchema = Type.Object({
  title: Type.String({ minLength: 1 })
})

export const SwitchProviderBodySchema = Type.Object({
  providerCode: ProviderCodeSchema
})

export const CreateConversationTurnBodySchema = Type.Object({
  message: Type.String(),
  attachmentIds: Type.Array(Type.String()),
  idempotencyKey: Type.String({ minLength: 1 }),
  providerCode: Type.Optional(ProviderCodeSchema)
})

export const CreateTurnAcceptedDtoSchema = Type.Object({
  turnId: Type.String(),
  status: ConversationTurnStateSchema,
  revision: Type.Integer({ minimum: 0 }),
  queuePosition: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])
})

export const ProviderSummarySchema = Type.Object({
  code: ProviderCodeSchema,
  label: Type.String(),
  description: Type.String(),
  available: Type.Boolean(),
  supportedProfiles: Type.Array(CapabilityProfileSchema),
  unavailableReason: Type.Optional(Type.String()),
  installation: Type.Optional(
    Type.Object({
      command: Type.Optional(Type.String()),
      executablePath: Type.Optional(Type.String())
    })
  )
})

export const ConversationRealtimeEventNameSchema = Type.Union([
  Type.Literal('conversation.changed'),
  Type.Literal('message.committed'),
  Type.Literal('conversation.deleted'),
  Type.Literal('turn.changed'),
  Type.Literal('assistant.thinking.delta'),
  Type.Literal('assistant.text.delta'),
  Type.Literal('turn.completed'),
  Type.Literal('turn.failed'),
  Type.Literal('turn.cancelled'),
  Type.Literal('realtime.resync-required')
])

export type ConversationState = Static<typeof ConversationStateSchema>
export type TitleSource = Static<typeof TitleSourceSchema>
export type MessageRole = Static<typeof MessageRoleSchema>
export type MessageKind = Static<typeof MessageKindSchema>
export type WorkspaceAccessMode = Static<typeof WorkspaceAccessModeSchema>
export type ConversationTurnState = Static<typeof ConversationTurnStateSchema>
export type CapabilityProfile = Static<typeof CapabilityProfileSchema>
export type ConversationDto = Static<typeof ConversationDtoSchema>
export type ConversationMessageDto = Static<typeof ConversationMessageDtoSchema>
export type ConversationAttachmentDto = Static<typeof ConversationAttachmentDtoSchema>
export type TurnErrorDto = Static<typeof TurnErrorDtoSchema>
export type ConversationTurnDto = Static<typeof ConversationTurnDtoSchema>
export type CreateConversationBody = Static<typeof CreateConversationBodySchema>
export type RenameConversationBody = Static<typeof RenameConversationBodySchema>
export type SwitchProviderBody = Static<typeof SwitchProviderBodySchema>
export type CreateConversationTurnBody = Static<typeof CreateConversationTurnBodySchema>
export type CreateTurnAcceptedDto = Static<typeof CreateTurnAcceptedDtoSchema>
export type ProviderSummary = Static<typeof ProviderSummarySchema>
export type ConversationRealtimeEventName = Static<typeof ConversationRealtimeEventNameSchema>
