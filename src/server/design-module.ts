import type Database from 'better-sqlite3'
import {
  CODETEAM_MANAGER_MCP_SERVER,
  MCP_HTTP_ACCEPT_HEADER_VALUE,
  createAgentRuntime,
  toCanonicalProviderCode,
  type AgentTurnInput,
  type HostTurnChunk,
  type ProviderSummary
} from '@codetask/agent-runtime'
import { contentHash } from '@codetask/server-core/modules/settings'
import {
  composeConversationModule,
  composeDesignModule,
  composeExecutionModule,
  getPlannerMcpBackendPort,
  type ConversationModule,
  type DesignModule
} from '@codetask/server-core'
import type { AppContext } from './bootstrap'
import type { AppDatabase } from './db'
import { AppError } from './error'
import { getProject } from './projects/service'
import {
  acquireWorkspaceLease,
  releaseWorkspaceLease
} from './infra/workspace-lease-store'
import { listChatCores } from './conversation/cores'
import {
  buildAttachmentReferenceMarkdown,
  resolveThreadAttachments,
  resolveTurnAttachmentReadRoots
} from './conversation/attachments'
import {
  registerConversationMcpSession,
  unregisterConversationMcpSession
} from './conversation/mcp/session'
import {
  buildConversationMcpUrl,
  getConversationMcpBackendPort
} from './conversation/mcp/url'
import { getOrComposeSettings } from './settings/service'

const designByDb = new WeakMap<object, DesignModule>()
const executionByDb = new WeakMap<object, ReturnType<typeof composeExecutionModule>>()
const conversationByDb = new WeakMap<object, ConversationModule>()
const agentRuntimeByDb = new WeakMap<object, ReturnType<typeof createAgentRuntime>>()

export type ExecutionModule = ReturnType<typeof composeExecutionModule>

function getSqliteClient(ctx: AppContext): Database.Database {
  const rawDb = (ctx.db as AppDatabase & { $client?: Database.Database }).$client
  if (!rawDb) {
    throw new Error('SQLite client missing on AppDatabase')
  }
  return rawDb
}

/**
 * Shared AgentRuntime for Conversation + Execution (+ future Design planner).
 * Adapts host Provider SDK/ACP streamers behind the package port.
 */
export function getOrCreateAgentRuntime(ctx: AppContext): ReturnType<typeof createAgentRuntime> {
  const rawDb = getSqliteClient(ctx)
  let runtime = agentRuntimeByDb.get(rawDb)
  if (runtime) return runtime

  runtime = createAgentRuntime({
    async *streamTurn(
      input: AgentTurnInput & { hostProvider: string },
      options: { signal?: AbortSignal }
    ): AsyncIterable<HostTurnChunk> {
      const { streamAgentTurn } = await import('./agent-runtime/runner')
      for await (const chunk of streamAgentTurn(
        {
          role:
            input.role === 'slice-verifier' || input.role === 'milestone-verifier'
              ? input.role
              : input.role === 'task-worker'
                ? 'task-worker'
                : input.role === 'planner'
                  ? 'planner'
                  : 'conversation',
          provider: input.hostProvider as 'codex' | 'claude-code' | 'opencode' | 'cursorcli',
          workspaceRoot: input.workspaceRoot ?? '',
          prompt: input.prompt,
          systemPrompt: input.systemPrompt,
          capabilityProfile: input.capabilityProfile as
            | 'chat-read'
            | 'chat-write'
            | 'planner-read'
            | 'task-sandbox'
            | 'verifier-sandbox',
          providerRuntimeScopeId: input.scopeId,
          readRoots: input.readRoots,
          signal: options.signal,
          mcpUrl: input.mcpServers?.[0]?.url,
          userMcpServers: input.userMcpServers ?? {},
          model: input.model,
          ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}),
          ...(input.workspaceLease
            ? {
                workspaceLease: {
                  leaseId: input.workspaceLease.leaseId,
                  ownerKind: input.workspaceLease.ownerKind as
                    | 'conversation'
                    | 'planner'
                    | 'thread_job'
                    | 'job-run',
                  ownerId: input.workspaceLease.ownerId
                }
              }
            : {})
        }
        // runner takes signal on input only
      )) {
        if (chunk.type === 'delta') yield { type: 'delta', content: chunk.content }
        else if (chunk.type === 'thinking_delta')
          yield { type: 'thinking_delta', content: chunk.content }
        else if (chunk.type === 'completed')
          yield {
            type: 'completed',
            reply: chunk.reply,
            runtimeSessionId: chunk.runtimeSessionId
          }
        else if (chunk.type === 'error') yield { type: 'error', message: chunk.message }
      }
    },
    async listProviders(): Promise<ProviderSummary[]> {
      const cores = await listChatCores()
      return cores.map((core) => {
        const code = toCanonicalProviderCode(core.code) ?? 'codex'
        return {
          code,
          label: core.label,
          description: core.description,
          available: core.available,
          supportedProfiles: core.readOnlyCapable
            ? (['chat-read'] as const)
            : (['chat-read', 'chat-write'] as const),
          ...(core.reason ? { unavailableReason: core.reason } : {}),
          installation: {
            ...(core.launchCommand ? { command: core.launchCommand } : {}),
            ...(core.executablePath ? { executablePath: core.executablePath } : {})
          }
        }
      })
    },
    async closeScopeImpl(scopeId: string) {
      try {
        const { closeConversationCursorRuntime } = await import(
          './agent-runtime/cursor-acp/stream-session-turn'
        )
        // Scope id format conversation:{id}:provider:{code} — extract conversation id
        const match = /^conversation:([^:]+):provider:/.exec(scopeId)
        if (match) await closeConversationCursorRuntime(match[1]!)
      } catch {
        // optional close
      }
    }
  })

  agentRuntimeByDb.set(rawDb, runtime)
  return runtime
}

function composeExecutionForDb(ctx: AppContext, rawDb: Database.Database): ExecutionModule {
  let execution = executionByDb.get(rawDb)
  if (!execution) {
    const agentRuntime = getOrCreateAgentRuntime(ctx)
    execution = composeExecutionModule({
      db: rawDb,
      agentRuntime,
      onEvent(jobId, eventType, payload, outboxId) {
        const entityRevision =
          payload &&
          typeof payload === 'object' &&
          'revision' in payload &&
          typeof (payload as { revision: unknown }).revision === 'number'
            ? (payload as { revision: number }).revision
            : 0
        ctx.realtime.dispatcher.publishDurable({
          actorId: resolveJobActorId(rawDb, jobId),
          sourceModule: 'execution',
          sourceOutboxId: outboxId,
          topic: `job:${jobId}`,
          type: eventType,
          entityId: jobId,
          entityRevision,
          payload: minimizeJobPayload(eventType, payload)
        })
      }
    })
    execution.startup()
    executionByDb.set(rawDb, execution)
  }
  return execution
}

function resolveJobActorId(db: Database.Database, jobId: string): string {
  const row = db.prepare(`SELECT actor_id FROM jobs WHERE id = ?`).get(jobId) as
    | { actor_id: string }
    | undefined
  return row?.actor_id ?? 'unknown'
}

function resolvePlanningActorId(db: Database.Database, sessionId: string): string {
  const row = db
    .prepare(`SELECT actor_id FROM planning_sessions WHERE id = ?`)
    .get(sessionId) as { actor_id: string } | undefined
  return row?.actor_id ?? 'unknown'
}

function resolveConversationActorFromTopic(db: Database.Database, topic: string): string {
  if (topic.startsWith('conversation-turn:')) {
    const turnId = topic.slice('conversation-turn:'.length)
    const row = db.prepare(`SELECT actor_id FROM conversation_turns WHERE id = ?`).get(turnId) as
      | { actor_id: string }
      | undefined
    return row?.actor_id ?? 'unknown'
  }
  if (topic.startsWith('conversation:')) {
    const conversationId = topic.slice('conversation:'.length)
    const row = db
      .prepare(`SELECT actor_id FROM conversation_threads WHERE id = ?`)
      .get(conversationId) as { actor_id: string } | undefined
    return row?.actor_id ?? 'unknown'
  }
  return 'unknown'
}

/** Strip oversized DTOs — clients refetch Snapshot over HTTP. */
function minimizeJobPayload(eventType: string, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return { eventType }
  const record = payload as Record<string, unknown>
  const job = record.job
  if (job && typeof job === 'object') {
    const j = job as Record<string, unknown>
    return {
      jobId: j.id ?? record.jobId,
      state: j.state ?? j.status,
      revision: j.revision
    }
  }
  return {
    jobId: record.jobId,
    state: record.state,
    revision: record.revision,
    ...(typeof record.workId === 'string' ? { workId: record.workId } : {})
  }
}

/** Compose (once per db) the Execution module used by HTTP job routes and Design handoff. */
export function getOrComposeExecution(ctx: AppContext): ExecutionModule {
  const rawDb = getSqliteClient(ctx)
  return composeExecutionForDb(ctx, rawDb)
}

/** Compose (once per db) the Design module used by HTTP routes and Planner MCP. */
export function getOrComposeDesign(ctx: AppContext): DesignModule {
  const existing = designByDb.get(ctx.db)
  if (existing) return existing

  const rawDb = getSqliteClient(ctx)
  const execution = composeExecutionForDb(ctx, rawDb)

  const design = composeDesignModule({
    db: rawDb,
    jobSubmission: execution.submitJob,
    agentRuntime: getOrCreateAgentRuntime(ctx),
    getMcpBackendPort: getPlannerMcpBackendPort,
    async resolveWorkspaceRoot({ actorId, projectId }) {
      const project = await getProject(actorId, projectId)
      if (!project) {
        throw AppError.notFound('Project not found')
      }
      return project.workspaceRoot
    },
    publishEvent(sessionId, event, payload) {
      const actorId =
        typeof payload.actorId === 'string'
          ? payload.actorId
          : resolvePlanningActorId(rawDb, sessionId)
      const revision =
        typeof payload.treeRevision === 'number'
          ? payload.treeRevision
          : typeof payload.revision === 'number'
            ? payload.revision
            : 0
      ctx.realtime.dispatcher.publishDurable({
        actorId,
        sourceModule: 'design',
        topic: `planning-session:${sessionId}`,
        type: event,
        entityId: sessionId,
        entityRevision: revision,
        payload: { sessionId, ...payload }
      })
    },
    capturePlannerSettings: (providerCode) =>
      getOrComposeSettings(ctx).app.captureDesignSettings(providerCode),
    captureExecutionSettings: (taskProvider, verificationProvider) =>
      getOrComposeSettings(ctx).app.captureExecutionSettings(taskProvider, verificationProvider)
  })
  designByDb.set(ctx.db, design)
  design.outbox.start()
  return design
}

/** Compose (once per db) the pure Conversation Chat module (03). */
export function getOrComposeConversation(ctx: AppContext): ConversationModule {
  const rawDb = getSqliteClient(ctx)
  let conversation = conversationByDb.get(rawDb)
  if (conversation) return conversation

  const agentRuntime = getOrCreateAgentRuntime(ctx)
  conversation = composeConversationModule({
    db: rawDb,
    agentRuntime,
    async resolveWorkspaceRoot({ actorId, projectId }) {
      const project = await getProject(actorId, projectId)
      if (!project) {
        throw AppError.notFound('Project not found')
      }
      return {
        projectId,
        workspaceRoot: project.workspaceRoot,
        canonicalWorkspaceRoot: project.workspaceRoot
      }
    },
    leases: {
      tryAcquireExclusive({ workspaceRoot, ownerId }) {
        const acquired = acquireWorkspaceLease({
          workspacePath: workspaceRoot,
          // Match chat turn-policy + UI blocker mapping (ownerId = turn id).
          ownerKind: 'conversation',
          ownerId
        })
        return acquired ? { leaseId: acquired.leaseId } : null
      },
      release(leaseId) {
        releaseWorkspaceLease({ leaseId })
      }
    },
    realtime: {
      publish(topic, event, payload) {
        const ephemeral =
          event === 'assistant.thinking.delta' || event === 'assistant.text.delta'
        const actorId =
          typeof payload.actorId === 'string'
            ? payload.actorId
            : resolveConversationActorFromTopic(rawDb, topic)
        const entityId =
          topic.startsWith('conversation-turn:')
            ? topic.slice('conversation-turn:'.length)
            : topic.startsWith('conversation:')
              ? topic.slice('conversation:'.length)
              : topic
        const entityRevision =
          typeof payload.stateRevision === 'number'
            ? payload.stateRevision
            : typeof payload.revision === 'number'
              ? payload.revision
              : 0
        if (ephemeral) {
          ctx.realtime.dispatcher.publishEphemeral({
            actorId,
            topic,
            type: event,
            entityId,
            payload
          })
        } else {
          ctx.realtime.dispatcher.publishDurable({
            actorId,
            sourceModule: 'conversation',
            topic,
            type: event,
            entityId,
            entityRevision,
            payload
          })
        }
      }
    },
    attachments: {
      resolveForTurn({ conversationId, attachmentIds }) {
        const resolved = resolveThreadAttachments(conversationId, attachmentIds)
        return {
          attachments: resolved.map((attachment, index) => ({
            id: attachment.id,
            assetId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            kind: attachment.kind,
            sortOrder: index
          })),
          readRoots: resolveTurnAttachmentReadRoots({
            threadId: conversationId,
            attachments: resolved
          }),
          promptAppendix: buildAttachmentReferenceMarkdown({
            threadId: conversationId,
            attachments: resolved
          })
        }
      }
    },
    systemMcp: {
      bindForTurn(input) {
        if (!getConversationMcpBackendPort()) {
          return { mcpServers: [], release: () => {} }
        }
        const attachmentIds = input.attachments.map((item) => item.id)
        const turnAttachments =
          attachmentIds.length > 0
            ? resolveThreadAttachments(input.conversationId, attachmentIds)
            : []
        registerConversationMcpSession({
          sessionId: input.sessionId,
          username: input.actorId,
          threadId: input.conversationId,
          turnRole: 'chat',
          workspacePath: input.workspaceRoot,
          userMessageId: input.userMessageId,
          conversationId: input.conversationId,
          coreCode: input.providerCode,
          turnAttachments
        })
        const url = buildConversationMcpUrl({
          sessionId: input.sessionId,
          threadId: input.conversationId
        })
        return {
          mcpServers: [
            {
              name: CODETEAM_MANAGER_MCP_SERVER,
              url,
              headers: { Accept: MCP_HTTP_ACCEPT_HEADER_VALUE }
            }
          ],
          release: () => unregisterConversationMcpSession(input.sessionId)
        }
      }
    },
    maxConcurrentTurnsPerUser: ctx.config.http.maxConcurrentTurnsPerUser,
    // Prompt comes from frozen SettingsSnapshot at enqueue; do not live-read.
    resolveSystemPrompt: () => '',
    captureSettingsForTurn: (provider) => {
      const snap = getOrComposeSettings(ctx).app.captureConversationSettings(provider)
      return {
        ...snap,
        contentHash: contentHash({
          promptBody: snap.promptBody,
          mcpServers: snap.mcpServers,
          sourceRevisions: snap.sourceRevisions
        })
      }
    }
  })
  conversation.startup()
  conversationByDb.set(rawDb, conversation)
  return conversation
}
