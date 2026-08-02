import { Type, type Static } from '@sinclair/typebox'

/** Canonical browser realtime topics (06 §7.2 / §19). */
export const RealtimeTopicSchema = Type.Union([
  Type.TemplateLiteral([Type.Literal('conversation:'), Type.String({ minLength: 1 })]),
  Type.TemplateLiteral([Type.Literal('conversation-turn:'), Type.String({ minLength: 1 })]),
  Type.TemplateLiteral([Type.Literal('planning-session:'), Type.String({ minLength: 1 })]),
  Type.TemplateLiteral([Type.Literal('job:'), Type.String({ minLength: 1 })]),
  Type.Literal('settings:self')
])

export type RealtimeTopic =
  | `conversation:${string}`
  | `conversation-turn:${string}`
  | `planning-session:${string}`
  | `job:${string}`
  | 'settings:self'

export const SETTINGS_SELF_TOPIC = 'settings:self' as const

export const RealtimeControlEventNameSchema = Type.Union([
  Type.Literal('realtime.resync-required'),
  Type.Literal('auth.session.expired')
])

export type RealtimeControlEventName = Static<typeof RealtimeControlEventNameSchema>

export const PlanningTopicSchema = Type.TemplateLiteral([
  Type.Literal('planning-session:'),
  Type.String()
])

export const DesignRealtimeEventNameSchema = Type.Union([
  Type.Literal('planning.changed'),
  Type.Literal('planning.progress'),
  Type.Literal('planning.tree.changed'),
  Type.Literal('planning.failed'),
  Type.Literal('planning.published')
])

export type DesignRealtimeEventName =
  | 'planning.changed'
  | 'planning.progress'
  | 'planning.tree.changed'
  | 'planning.failed'
  | 'planning.published'

export const JobTopicSchema = Type.TemplateLiteral([Type.Literal('job:'), Type.String()])

export type JobTopic = `job:${string}`

export const ConversationTopicSchema = Type.TemplateLiteral([
  Type.Literal('conversation:'),
  Type.String()
])

export const ConversationTurnTopicSchema = Type.TemplateLiteral([
  Type.Literal('conversation-turn:'),
  Type.String()
])

export type ConversationTopic = `conversation:${string}`
export type ConversationTurnTopic = `conversation-turn:${string}`

export const DurableRealtimeEnvelopeSchema = Type.Object({
  eventId: Type.Integer({ minimum: 1 }),
  ephemeral: Type.Literal(false),
  topic: Type.String(),
  type: Type.String(),
  entityId: Type.String(),
  entityRevision: Type.Integer({ minimum: 0 }),
  occurredAt: Type.Integer(),
  payload: Type.Unknown()
})

export const EphemeralRealtimeEnvelopeSchema = Type.Object({
  eventId: Type.Null(),
  ephemeral: Type.Literal(true),
  topic: Type.String(),
  type: Type.String(),
  entityId: Type.String(),
  occurredAt: Type.Integer(),
  payload: Type.Unknown()
})

export const RealtimeEnvelopeSchema = Type.Union([
  DurableRealtimeEnvelopeSchema,
  EphemeralRealtimeEnvelopeSchema
])

export type DurableRealtimeEnvelope<T = unknown> = {
  eventId: number
  ephemeral: false
  topic: RealtimeTopic | string
  type: string
  entityId: string
  entityRevision: number
  occurredAt: number
  payload: T
}

export type EphemeralRealtimeEnvelope<T = unknown> = {
  eventId: null
  ephemeral: true
  topic: RealtimeTopic | string
  type: string
  entityId: string
  occurredAt: number
  payload: T
}

export type RealtimeEnvelope<T = unknown> =
  | DurableRealtimeEnvelope<T>
  | EphemeralRealtimeEnvelope<T>

export const RealtimeSubscriptionsBodySchema = Type.Object({
  topics: Type.Array(Type.String())
})

export type RealtimeSubscriptionsBody = Static<typeof RealtimeSubscriptionsBodySchema>

export const REALTIME_CONNECTION_ID_HEADER = 'X-Realtime-Connection-Id'

export const MAX_REALTIME_TOPICS_PER_CONNECTION = 64

/** Conversation deltas that must not enter durable realtime_events. */
export const EPHEMERAL_CONVERSATION_EVENT_TYPES = new Set<string>([
  'assistant.thinking.delta',
  'assistant.text.delta'
])

export function conversationTopic(conversationId: string): ConversationTopic {
  return `conversation:${conversationId}`
}

export function conversationTurnTopic(turnId: string): ConversationTurnTopic {
  return `conversation-turn:${turnId}`
}

export function planningSessionTopic(sessionId: string): `planning-session:${string}` {
  return `planning-session:${sessionId}`
}

export function jobTopic(jobId: string): JobTopic {
  return `job:${jobId}`
}

export function parseRealtimeTopic(raw: string): RealtimeTopic | null {
  const topic = raw.trim()
  if (topic === SETTINGS_SELF_TOPIC) return SETTINGS_SELF_TOPIC
  if (topic.startsWith('conversation-turn:') && topic.length > 18) {
    return topic as ConversationTurnTopic
  }
  if (topic.startsWith('conversation:') && topic.length > 13) {
    return topic as ConversationTopic
  }
  if (topic.startsWith('planning-session:') && topic.length > 17) {
    return topic as `planning-session:${string}`
  }
  if (topic.startsWith('job:') && topic.length > 4) {
    return topic as JobTopic
  }
  return null
}

export function jobIdFromRealtimeTopic(topic: string): string | null {
  return topic.startsWith('job:') ? topic.slice(4) : null
}

export function conversationIdFromRealtimeTopic(topic: string): string | null {
  if (topic.startsWith('conversation-turn:')) return null
  return topic.startsWith('conversation:') ? topic.slice(13) : null
}

export function turnIdFromRealtimeTopic(topic: string): string | null {
  return topic.startsWith('conversation-turn:') ? topic.slice(18) : null
}

export function planningSessionIdFromRealtimeTopic(topic: string): string | null {
  return topic.startsWith('planning-session:') ? topic.slice(17) : null
}
