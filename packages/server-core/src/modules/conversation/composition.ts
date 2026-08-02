import type Database from 'better-sqlite3'
import type { AgentRuntime } from '@codetask/agent-runtime'
import type { ProviderCode } from '@codetask/contracts'
import { Hono } from 'hono'
import { ConversationApplication } from './application/conversation-application.ts'
import {
  createSqliteConversationRepository,
  createSqliteMessageRepository,
  createSqliteTurnRepository
} from './infrastructure/sqlite-repos.ts'
import type {
  AttachmentResolverPort,
  ConversationRealtimePort,
  ConversationSystemMcpPort,
  WorkspaceLeasePort,
  WorkspaceResolverPort
} from './ports/ports.ts'
import {
  createConversationRoutes,
  type ConversationHttpEnv
} from './http/conversation-routes.ts'

export type ConversationModule = {
  app: ConversationApplication
  routes: Hono<ConversationHttpEnv>
  startup: () => void
  advanceQueue: (actorId?: string) => Promise<void>
}

export type ConversationModuleDeps = {
  db: Database.Database
  agentRuntime: AgentRuntime
  resolveWorkspaceRoot: WorkspaceResolverPort['resolveWorkspaceRoot']
  leases: WorkspaceLeasePort
  realtime: ConversationRealtimePort
  attachments?: AttachmentResolverPort
  systemMcp?: ConversationSystemMcpPort
  maxConcurrentTurnsPerUser?: number
  defaultProviderCode?: ProviderCode
  resolveSystemPrompt?: () => string
  captureSettingsForTurn?: (provider: ProviderCode) => {
    promptBody: string | null
    mcpServers: Record<string, unknown>
    sourceRevisions: unknown[]
    contentHash: string
  }
}

export function composeConversationModule(deps: ConversationModuleDeps): ConversationModule {
  const conversations = createSqliteConversationRepository(deps.db)
  const messages = createSqliteMessageRepository(deps.db)
  const turns = createSqliteTurnRepository(deps.db)

  const app = new ConversationApplication({
    conversations,
    messages,
    turns,
    agentRuntime: deps.agentRuntime,
    workspace: { resolveWorkspaceRoot: deps.resolveWorkspaceRoot },
    leases: deps.leases,
    realtime: deps.realtime,
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    ...(deps.systemMcp ? { systemMcp: deps.systemMcp } : {}),
    maxConcurrentTurnsPerUser: deps.maxConcurrentTurnsPerUser ?? 2,
    defaultProviderCode: deps.defaultProviderCode ?? 'codex',
    resolveSystemPrompt: deps.resolveSystemPrompt ?? (() => ''),
    ...(deps.captureSettingsForTurn ? { captureSettingsForTurn: deps.captureSettingsForTurn } : {})
  })

  const routes = createConversationRoutes(app)

  return {
    app,
    routes,
    startup() {
      app.reconcileOnStartup()
      void app.advanceQueue()
    },
    advanceQueue: (actorId) => app.advanceQueue(actorId)
  }
}
