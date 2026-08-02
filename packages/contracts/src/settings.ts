import { Type, type Static } from '@sinclair/typebox'

export const SETTING_NAMESPACES = [
  'agent_defaults',
  'agent_prompts',
  'agent_mcp',
  'provider_runtime'
] as const

export type SettingNamespace = (typeof SETTING_NAMESPACES)[number]

export const SettingsProviderCodeSchema = Type.Union([
  Type.Literal('codex'),
  Type.Literal('claude-code'),
  Type.Literal('opencode'),
  Type.Literal('cursorcli')
])

export type SettingsProviderCode = Static<typeof SettingsProviderCodeSchema>

export const PromptEntrySchema = Type.Object(
  {
    mode: Type.Union([Type.Literal('default'), Type.Literal('custom')]),
    body: Type.String()
  },
  { additionalProperties: false }
)

export type PromptEntry = Static<typeof PromptEntrySchema>

export const AgentDefaultsSettingsSchema = Type.Object(
  {
    plannerProvider: SettingsProviderCodeSchema,
    sliceVerifierProvider: SettingsProviderCodeSchema,
    milestoneVerifierProvider: SettingsProviderCodeSchema
  },
  { additionalProperties: false }
)

export type AgentDefaultsSettings = Static<typeof AgentDefaultsSettingsSchema>

export const AgentPromptSettingsSchema = Type.Object(
  {
    conversation: PromptEntrySchema,
    planner: PromptEntrySchema,
    sliceVerifier: PromptEntrySchema,
    milestoneVerifier: PromptEntrySchema
  },
  { additionalProperties: false }
)

export type AgentPromptSettings = Static<typeof AgentPromptSettingsSchema>

export const AGENT_MCP_ROLES = ['conversation', 'planner', 'task', 'verification'] as const
export type AgentMcpRole = (typeof AGENT_MCP_ROLES)[number]

export const SecretReferenceSchema = Type.Object(
  {
    $secret: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
)

export type SecretReference = Static<typeof SecretReferenceSchema>

export const ProviderRuntimeSettingSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    executable: Type.Union([
      Type.Object({ mode: Type.Literal('auto') }, { additionalProperties: false }),
      Type.Object(
        { mode: Type.Literal('path'), path: Type.String({ minLength: 1 }) },
        { additionalProperties: false }
      )
    ]),
    model: Type.Optional(Type.String()),
    endpoint: Type.Optional(Type.String()),
    approveMcps: Type.Boolean()
  },
  { additionalProperties: false }
)

export type ProviderRuntimeSetting = Static<typeof ProviderRuntimeSettingSchema>

export const ProviderRuntimeSettingsSchema = Type.Object(
  {
    providers: Type.Record(Type.String(), ProviderRuntimeSettingSchema)
  },
  { additionalProperties: false }
)

export type ProviderRuntimeSettings = Static<typeof ProviderRuntimeSettingsSchema>

export const SettingsWriteEffectSchema = Type.Union([
  Type.Literal('new-operations'),
  Type.Literal('restart-required')
])

export type SettingsWriteEffect = Static<typeof SettingsWriteEffectSchema>

export const SettingsWriteResultSchema = Type.Object({
  revision: Type.Integer({ minimum: 0 }),
  effect: SettingsWriteEffectSchema,
  restartRequired: Type.Boolean()
})

export type SettingsWriteResult = Static<typeof SettingsWriteResultSchema>

export const SettingsSnapshotRefSchema = Type.Object({
  namespace: Type.Union(SETTING_NAMESPACES.map((n) => Type.Literal(n))),
  revision: Type.Integer({ minimum: 0 }),
  contentHash: Type.String()
})

export type SettingsSnapshotRef = Static<typeof SettingsSnapshotRefSchema>

export const ConversationSettingsSnapshotSchema = Type.Object({
  promptBody: Type.Union([Type.String(), Type.Null()]),
  mcpServers: Type.Record(Type.String(), Type.Unknown()),
  sourceRevisions: Type.Array(SettingsSnapshotRefSchema)
})

export type ConversationSettingsSnapshot = Static<typeof ConversationSettingsSnapshotSchema>

export const DesignSettingsSnapshotSchema = Type.Object({
  plannerProvider: SettingsProviderCodeSchema,
  promptBody: Type.String(),
  mcpServers: Type.Record(Type.String(), Type.Unknown()),
  sourceRevisions: Type.Array(SettingsSnapshotRefSchema)
})

export type DesignSettingsSnapshot = Static<typeof DesignSettingsSnapshotSchema>

export const ExecutionSettingsSnapshotSchema = Type.Object({
  taskMcpServers: Type.Record(Type.String(), Type.Unknown()),
  verificationMcpServers: Type.Record(Type.String(), Type.Unknown()),
  sliceVerifierPromptBody: Type.String(),
  milestoneVerifierPromptBody: Type.String(),
  sourceRevisions: Type.Array(SettingsSnapshotRefSchema)
})

export type ExecutionSettingsSnapshot = Static<typeof ExecutionSettingsSnapshotSchema>

export const RuntimeSettingsSnapshotSchema = Type.Object({
  provider: SettingsProviderCodeSchema,
  model: Type.Optional(Type.String()),
  promptBody: Type.Union([Type.String(), Type.Null()]),
  mcpServers: Type.Array(
    Type.Object({
      name: Type.String(),
      config: Type.Unknown()
    })
  ),
  sourceRevisions: Type.Array(SettingsSnapshotRefSchema)
})

export type RuntimeSettingsSnapshot = Static<typeof RuntimeSettingsSnapshotSchema>

export const SettingsChangedEventSchema = Type.Object({
  type: Type.Literal('settings.changed'),
  namespace: Type.Union(SETTING_NAMESPACES.map((n) => Type.Literal(n))),
  revision: Type.Integer({ minimum: 0 }),
  effect: SettingsWriteEffectSchema
})

export type SettingsChangedEvent = Static<typeof SettingsChangedEventSchema>

export const SETTINGS_ERROR_CODES = [
  'settings.namespace_not_found',
  'settings.revision_conflict',
  'settings.invalid_payload',
  'settings.provider_unknown',
  'settings.provider_unavailable',
  'settings.prompt_empty',
  'settings.prompt_too_large',
  'settings.mcp_invalid',
  'settings.mcp_reserved_name',
  'settings.secret_not_found',
  'settings.secret_in_use',
  'settings.restart_required'
] as const

export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODES)[number]
