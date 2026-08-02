import type Database from 'better-sqlite3'
import type { AgentPromptSettings, SettingsProviderCode } from '@codetask/contracts'
import {
  composeSettingsModule,
  type SettingsModule
} from '@codetask/server-core/modules/settings'
import type { AppContext } from '../bootstrap'
import type { AppDatabase } from '../db'
import { buildChatConversationBody } from '../conversation/prompts'
import { buildPlannerSystemPrompt } from '../planner/prompts'
import {
  buildMilestoneVerifierSystemPrompt,
  buildSliceVerifierSystemPrompt
} from '../verification/prompts'
import { listChatCores } from '../conversation/cores'

const settingsByDb = new WeakMap<object, SettingsModule>()

function sqliteClient(db: AppDatabase): Database.Database {
  const client = (db as AppDatabase & { $client?: import('better-sqlite3').Database }).$client
  if (!client) throw new Error('Database client is not available')
  return client
}

function buildDefaultPromptBodies(): AgentPromptSettings {
  return {
    conversation: {
      mode: 'default',
      body: buildChatConversationBody('CodeTask Conversation')
    },
    planner: { mode: 'default', body: buildPlannerSystemPrompt() },
    sliceVerifier: { mode: 'default', body: buildSliceVerifierSystemPrompt() },
    milestoneVerifier: { mode: 'default', body: buildMilestoneVerifierSystemPrompt() }
  }
}

export function composeSettingsForContext(ctx: AppContext): SettingsModule {
  const masterKey = process.env.CODETASK_SETTINGS_MASTER_KEY ?? ctx.security.authSecret
  return composeSettingsModule({
    db: sqliteClient(ctx.db),
    masterKey,
    events: {
      async publish(event) {
        ctx.realtime.dispatcher.publishDurable({
          actorId: '*',
          sourceModule: 'settings',
          topic: 'settings:self',
          type: event.type,
          entityId: event.namespace,
          entityRevision: event.revision,
          payload: {
            namespace: event.namespace,
            revision: event.revision,
            effect: event.effect
          }
        })
      }
    },
    defaultPromptBodies: buildDefaultPromptBodies,
    providerCatalog: {
      async listProviders() {
        const cores = await listChatCores()
        return cores.map((core) => ({
          code: core.code as SettingsProviderCode,
          label: core.label,
          available: core.available
        }))
      }
    }
  })
}

/** Compose (once per db) the Settings module used by HTTP routes and runtime snapshots. */
export function getOrComposeSettings(ctx: AppContext): SettingsModule {
  const existing = settingsByDb.get(ctx.db)
  if (existing) return existing
  const module = composeSettingsForContext(ctx)
  settingsByDb.set(ctx.db, module)
  return module
}
