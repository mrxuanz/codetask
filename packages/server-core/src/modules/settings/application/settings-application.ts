import type {
  AgentDefaultsSettings,
  AgentMcpRole,
  AgentPromptSettings,
  ConversationSettingsSnapshot,
  DesignSettingsSnapshot,
  ExecutionSettingsSnapshot,
  SettingsProviderCode,
  ProviderRuntimeSettings,
  SettingsChangedEvent,
  SettingsSnapshotRef,
  SettingsWriteEffect,
  SettingsWriteResult,
  SettingNamespace
} from '@codetask/contracts'
import {
  defaultAgentDefaultsSettings,
  normalizeAgentDefaultsSettings,
  validateAgentDefaultsSettings
} from '../domain/agent-defaults.ts'
import {
  defaultAgentPromptSettings,
  normalizeAgentPromptSettings,
  validateAgentPromptSettings
} from '../domain/agent-prompts.ts'
import {
  collectSecretReferences,
  defaultAgentMcpSettings,
  extractMcpServersMap,
  MCP_SETTINGS_CONSTRAINTS,
  normalizeAgentMcpSettings,
  redactMcpSettingsForApi,
  resolveSecretRefs,
  type AgentMcpSettings,
  validateAgentMcpSettings
} from '../domain/agent-mcp.ts'
import {
  defaultProviderRuntimeSettings,
  normalizeProviderRuntimeSettings,
  providerRuntimeRestartRequired,
  validateProviderRuntimeSettings
} from '../domain/provider-runtime-settings.ts'
import { SettingsError } from '../domain/settings-errors.ts'
import { contentHash, toSettingsProviderCode, type DefaultPromptBodies } from '../domain/setting-namespace.ts'
import type { ProviderCatalogPort } from '../ports/provider-catalog.ts'
import type { SecretStore } from '../ports/secret-store.ts'
import type { SettingsEventsPort } from '../ports/settings-events.ts'
import type { SettingsRepository } from '../ports/settings-repository.ts'

export type SettingsApplicationDeps = {
  repository: SettingsRepository
  secrets: SecretStore
  events: SettingsEventsPort
  defaultPromptBodies?: DefaultPromptBodies
  providerCatalog?: ProviderCatalogPort
  clock?: () => number
}

type WriteOutcome<T> = SettingsWriteResult & { settings: T }

export class SettingsApplication {
  private readonly defaultPromptBodies: DefaultPromptBodies

  constructor(private readonly deps: SettingsApplicationDeps) {
    this.defaultPromptBodies = deps.defaultPromptBodies ?? defaultAgentPromptSettings
  }

  getAgentDefaults(): { settings: AgentDefaultsSettings; revision: number; updatedAt: number } {
    const stored = this.deps.repository.readNamespace<AgentDefaultsSettings>('agent_defaults')
    const settings = normalizeAgentDefaultsSettings(stored.value ?? defaultAgentDefaultsSettings())
    return { settings, revision: stored.revision, updatedAt: stored.updatedAt }
  }

  async updateAgentDefaults(
    expectedRevision: number,
    value: unknown
  ): Promise<WriteOutcome<AgentDefaultsSettings>> {
    const normalized = normalizeAgentDefaultsSettings(value)
    const validated = validateAgentDefaultsSettings(normalized, {
      isProviderAvailable: await this.providerAvailabilityChecker()
    })
    const result = this.deps.repository.writeNamespace('agent_defaults', validated, expectedRevision)
    await this.publishChange('agent_defaults', result.revision, 'new-operations')
    return {
      settings: validated,
      revision: result.revision,
      effect: 'new-operations',
      restartRequired: false
    }
  }

  getPrompts(): {
    settings: AgentPromptSettings
    defaults: AgentPromptSettings
    revision: number
    updatedAt: number
  } {
    const stored = this.deps.repository.readNamespace<AgentPromptSettings>('agent_prompts')
    const settings = normalizeAgentPromptSettings(stored.value ?? defaultAgentPromptSettings())
    return {
      settings,
      defaults: this.buildDefaultPromptBodies(),
      revision: stored.revision,
      updatedAt: stored.updatedAt
    }
  }

  async updatePrompts(
    expectedRevision: number,
    value: unknown
  ): Promise<WriteOutcome<AgentPromptSettings>> {
    const normalized = normalizeAgentPromptSettings(value)
    const validated = validateAgentPromptSettings(normalized)
    const result = this.deps.repository.writeNamespace('agent_prompts', validated, expectedRevision)
    await this.publishChange('agent_prompts', result.revision, 'new-operations')
    return {
      settings: validated,
      revision: result.revision,
      effect: 'new-operations',
      restartRequired: false
    }
  }

  getMcp(): {
    settings: AgentMcpSettings
    constraints: typeof MCP_SETTINGS_CONSTRAINTS
    revision: number
    updatedAt: number
  } {
    const stored = this.deps.repository.readNamespace<AgentMcpSettings>('agent_mcp')
    const settings = normalizeAgentMcpSettings(stored.value ?? defaultAgentMcpSettings())
    return {
      settings: redactMcpSettingsForApi(settings),
      constraints: MCP_SETTINGS_CONSTRAINTS,
      revision: stored.revision,
      updatedAt: stored.updatedAt
    }
  }

  async updateMcp(expectedRevision: number, value: unknown): Promise<WriteOutcome<AgentMcpSettings>> {
    const normalized = normalizeAgentMcpSettings(value)
    const validated = validateAgentMcpSettings(normalized)
    const result = this.deps.repository.writeNamespace('agent_mcp', validated, expectedRevision)
    await this.publishChange('agent_mcp', result.revision, 'new-operations')
    return {
      settings: redactMcpSettingsForApi(validated),
      revision: result.revision,
      effect: 'new-operations',
      restartRequired: false
    }
  }

  getProviders(effectiveProviders: ProviderRuntimeSettings): {
    saved: ProviderRuntimeSettings
    effective: ProviderRuntimeSettings
    revision: number
    updatedAt: number
    restartRequired: boolean
  } {
    const stored = this.deps.repository.readNamespace<ProviderRuntimeSettings>('provider_runtime')
    const saved = normalizeProviderRuntimeSettings(stored.value ?? defaultProviderRuntimeSettings())
    const effective = normalizeProviderRuntimeSettings(effectiveProviders)
    return {
      saved,
      effective,
      revision: stored.revision,
      updatedAt: stored.updatedAt,
      restartRequired: providerRuntimeRestartRequired(saved, effective)
    }
  }

  async updateProviders(
    expectedRevision: number,
    value: unknown,
    effectiveProviders: ProviderRuntimeSettings
  ): Promise<WriteOutcome<ProviderRuntimeSettings>> {
    const normalized = normalizeProviderRuntimeSettings(value)
    const validated = validateProviderRuntimeSettings(normalized, {
      isProviderAvailable: await this.providerAvailabilityChecker()
    })
    const result = this.deps.repository.writeNamespace('provider_runtime', validated, expectedRevision)
    const effective = normalizeProviderRuntimeSettings(effectiveProviders)
    const restartRequired = providerRuntimeRestartRequired(validated, effective)
    await this.publishChange('provider_runtime', result.revision, 'restart-required')
    return {
      settings: validated,
      revision: result.revision,
      effect: 'restart-required',
      restartRequired
    }
  }

  putSecret(name: string, value: string): SecretMetaResponse {
    const trimmed = name.trim()
    if (!trimmed) {
      throw SettingsError.badRequest('settings.invalid_payload', 'Secret name is required')
    }
    this.deps.secrets.put(trimmed, value)
    return { name: trimmed, backend: 'encrypted', configured: true }
  }

  deleteSecret(name: string): void {
    const trimmed = name.trim()
    if (!this.deps.secrets.has(trimmed)) {
      throw SettingsError.notFound('settings.secret_not_found', `Secret not found: ${trimmed}`)
    }
    const mcp = normalizeAgentMcpSettings(
      this.deps.repository.readNamespace<AgentMcpSettings>('agent_mcp').value ??
        defaultAgentMcpSettings()
    )
    const references = collectSecretReferences(mcp)
    if (references.has(trimmed)) {
      throw SettingsError.conflict('settings.secret_in_use', `Secret is still referenced: ${trimmed}`)
    }
    this.deps.secrets.delete(trimmed)
  }

  listSecrets(): SecretMetaResponse[] {
    return this.deps.secrets.list().map((meta) => ({
      name: meta.name,
      backend: meta.backend,
      configured: meta.configured
    }))
  }

  captureConversationSettings(providerCode: string): ConversationSettingsSnapshot {
    const hostProvider = toSettingsProviderCode(providerCode)
    const prompts = this.getPrompts()
    const mcp = normalizeAgentMcpSettings(
      this.deps.repository.readNamespace<AgentMcpSettings>('agent_mcp').value ??
        defaultAgentMcpSettings()
    )
    const providerRuntime = this.deps.repository.readNamespace('provider_runtime')
    return {
      promptBody: this.resolvePromptBody('conversation'),
      mcpServers: this.resolveMcpServersMap('conversation', hostProvider, mcp),
      sourceRevisions: this.buildSourceRevisions([
        { namespace: 'agent_prompts', revision: prompts.revision, value: prompts.settings },
        { namespace: 'agent_mcp', revision: this.deps.repository.readNamespace('agent_mcp').revision, value: mcp },
        {
          namespace: 'provider_runtime',
          revision: providerRuntime.revision,
          value: providerRuntime.value ?? defaultProviderRuntimeSettings()
        }
      ])
    }
  }

  captureDesignSettings(providerCode: string): DesignSettingsSnapshot {
    const hostProvider = toSettingsProviderCode(providerCode)
    const defaults = this.getAgentDefaults()
    const prompts = this.getPrompts()
    const mcp = normalizeAgentMcpSettings(
      this.deps.repository.readNamespace<AgentMcpSettings>('agent_mcp').value ??
        defaultAgentMcpSettings()
    )
    return {
      plannerProvider: defaults.settings.plannerProvider,
      promptBody: this.resolvePromptBody('planner') ?? '',
      mcpServers: this.resolveMcpServersMap('planner', hostProvider, mcp),
      sourceRevisions: this.buildSourceRevisions([
        { namespace: 'agent_defaults', revision: defaults.revision, value: defaults.settings },
        { namespace: 'agent_prompts', revision: prompts.revision, value: prompts.settings },
        { namespace: 'agent_mcp', revision: this.deps.repository.readNamespace('agent_mcp').revision, value: mcp }
      ])
    }
  }

  captureExecutionSettings(
    taskProvider: string,
    verificationProvider: string
  ): ExecutionSettingsSnapshot {
    const taskHost = toSettingsProviderCode(taskProvider)
    const verificationHost = toSettingsProviderCode(verificationProvider)
    const prompts = this.getPrompts()
    const mcp = normalizeAgentMcpSettings(
      this.deps.repository.readNamespace<AgentMcpSettings>('agent_mcp').value ??
        defaultAgentMcpSettings()
    )
    return {
      taskMcpServers: this.resolveMcpServersMap('task', taskHost, mcp),
      verificationMcpServers: this.resolveMcpServersMap('verification', verificationHost, mcp),
      sliceVerifierPromptBody: this.resolvePromptBody('sliceVerifier') ?? '',
      milestoneVerifierPromptBody: this.resolvePromptBody('milestoneVerifier') ?? '',
      sourceRevisions: this.buildSourceRevisions([
        { namespace: 'agent_prompts', revision: prompts.revision, value: prompts.settings },
        { namespace: 'agent_mcp', revision: this.deps.repository.readNamespace('agent_mcp').revision, value: mcp }
      ])
    }
  }

  resolveMcpServersMap(
    role: AgentMcpRole,
    providerCode: string,
    settings?: AgentMcpSettings
  ): Record<string, unknown> {
    const hostProvider = toSettingsProviderCode(providerCode)
    const mcp = settings ?? normalizeAgentMcpSettings(
      this.deps.repository.readNamespace<AgentMcpSettings>('agent_mcp').value ??
        defaultAgentMcpSettings()
    )
    const map = extractMcpServersMap(mcp, role, hostProvider)
    return resolveSecretRefs(map, (name) => {
      const secret = this.deps.secrets.get(name)
      if (secret === null) {
        throw SettingsError.badRequest('settings.secret_not_found', `Secret not found: ${name}`)
      }
      return secret
    })
  }

  resolvePromptBody(
    role: keyof AgentPromptSettings
  ): string | null {
    const stored = this.deps.repository.readNamespace<AgentPromptSettings>('agent_prompts')
    const settings = normalizeAgentPromptSettings(stored.value ?? defaultAgentPromptSettings())
    const entry = settings[role]
    if (role === 'conversation') {
      if (entry.mode === 'default') return null
      const body = entry.body.trim()
      return body.length > 0 ? body : null
    }
    if (entry.mode === 'custom') {
      return entry.body
    }
    const defaults = this.buildDefaultPromptBodies()
    return defaults[role].body
  }

  private buildDefaultPromptBodies(): AgentPromptSettings {
    return this.defaultPromptBodies()
  }

  private buildSourceRevisions(
    entries: Array<{ namespace: SettingNamespace; revision: number; value: unknown }>
  ): SettingsSnapshotRef[] {
    return entries.map((entry) => ({
      namespace: entry.namespace,
      revision: entry.revision,
      contentHash: contentHash(entry.value)
    }))
  }

  private async publishChange(
    namespace: SettingNamespace,
    revision: number,
    effect: SettingsWriteEffect
  ): Promise<void> {
    const event: SettingsChangedEvent = {
      type: 'settings.changed',
      namespace,
      revision,
      effect
    }
    await this.deps.events.publish(event)
  }

  private async providerAvailabilityChecker(): Promise<(code: SettingsProviderCode) => boolean> {
    if (!this.deps.providerCatalog) {
      return () => true
    }
    const providers = await this.deps.providerCatalog.listProviders()
    const available = new Set(
      providers.filter((entry) => entry.available).map((entry) => entry.code)
    )
    return (code) => available.has(code)
  }
}

type SecretMetaResponse = {
  name: string
  backend: string
  configured: boolean
}

export { contentHash } from '../domain/setting-namespace.ts'
