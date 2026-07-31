import { createHash } from 'node:crypto'
import { CursorAcpSessionRuntime, type CursorAcpSessionRuntimeOptions } from './session-runtime'
import {
  markConversationCursorBindingStopped,
  touchConversationCursorBinding,
  upsertConversationCursorBinding
} from './conversation-cursor-directory'
import type { AgentCapabilityProfile } from '../capabilities'
import {
  buildConversationProviderRuntimeScopeId,
  type ProviderConversationScopeKind
} from '../../../shared/providers/capabilities'

export interface JobCursorRuntimeKeyInput {
  jobId: string
  provider: string
  workspaceRoot: string
  model?: string | undefined
  mcpProfile: string
  capabilityProfile?: AgentCapabilityProfile | undefined
}

export interface CursorRuntimeKeyInput {
  scopeId: string
  provider: string
  workspaceRoot: string
  model?: string | undefined
  mcpProfile: string
  capabilityProfile?: AgentCapabilityProfile | undefined
}

export type ConversationCursorKind = ProviderConversationScopeKind

export const CONVERSATION_CURSOR_IDLE_MS = 30 * 60 * 1000

export function buildConversationCursorRuntimeScope(
  threadId: string,
  kind: ConversationCursorKind
): string {
  return buildConversationProviderRuntimeScopeId(threadId, kind)
}

export function isConversationCursorScope(scopeId: string): boolean {
  return (
    scopeId.startsWith('conversation:chat:') ||
    scopeId.startsWith('conversation:create_task:') ||
    /^conversation:[^:]+$/.test(scopeId)
  )
}

export function buildCursorRuntimeKey(input: CursorRuntimeKeyInput): string {
  const mcpProfile = isConversationCursorScope(input.scopeId) ? '' : input.mcpProfile
  const raw = [
    input.scopeId,
    input.provider,
    input.workspaceRoot,
    input.model ?? '',
    mcpProfile,
    input.capabilityProfile ?? ''
  ].join('\0')
  return createHash('sha256').update(raw).digest('hex').slice(0, 24)
}

export function buildJobCursorRuntimeKey(input: JobCursorRuntimeKeyInput): string {
  return buildCursorRuntimeKey({
    scopeId: input.jobId,
    provider: input.provider,
    workspaceRoot: input.workspaceRoot,
    model: input.model,
    mcpProfile: input.mcpProfile,
    capabilityProfile: input.capabilityProfile
  })
}

export function buildTaskMcpProfile(mcpUrl: string | undefined): string {
  if (!mcpUrl?.trim()) return 'none'
  try {
    const url = new URL(mcpUrl)
    return `${url.origin}${url.pathname.split('/').slice(0, -1).join('/')}`
  } catch {
    return mcpUrl
  }
}

interface RegistryEntry {
  key: string
  scopeId: string
  runtime: CursorAcpSessionRuntime
  lastUsedAt: number
}

export class CursorProviderRuntimeRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  get(key: string): CursorAcpSessionRuntime | null {
    return this.entries.get(key)?.runtime ?? null
  }

  touch(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.lastUsedAt = Date.now()
    if (isConversationCursorScope(entry.scopeId)) {
      touchConversationCursorBinding(entry.scopeId)
    }
  }

  isPromptInFlightForScope(scopeId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.scopeId !== scopeId) continue
      if (entry.runtime.isPromptInFlight()) return true
    }
    return false
  }

  async waitForScopeIdle(
    scopeId: string,
    options: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 10_000
    const pollMs = options.pollMs ?? 50
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.isPromptInFlightForScope(scopeId)) return
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  async getOrCreate(
    key: string,
    scopeId: string,
    factory: () => CursorAcpSessionRuntime
  ): Promise<CursorAcpSessionRuntime> {
    const existing = this.entries.get(key)
    if (existing && !existing.runtime.isClosed()) {
      existing.lastUsedAt = Date.now()
      if (isConversationCursorScope(scopeId)) {
        touchConversationCursorBinding(scopeId)
      }
      return existing.runtime
    }
    if (existing) {
      await existing.runtime.close()
      this.entries.delete(key)
      if (isConversationCursorScope(scopeId)) {
        markConversationCursorBindingStopped(scopeId)
      }
    }
    const runtime = factory()
    this.entries.set(key, { key, scopeId, runtime, lastUsedAt: Date.now() })
    if (isConversationCursorScope(scopeId)) {
      upsertConversationCursorBinding(scopeId)
    }
    return runtime
  }

  async invalidate(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    await entry.runtime.close()
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
    }
    if (isConversationCursorScope(entry.scopeId)) {
      markConversationCursorBindingStopped(entry.scopeId)
    }
  }

  async invalidateScope(scopeId: string): Promise<void> {
    const targets = [...this.entries.values()].filter((entry) => entry.scopeId === scopeId)
    for (const entry of targets) {
      await entry.runtime.close()
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
    }
    if (isConversationCursorScope(scopeId)) {
      markConversationCursorBindingStopped(scopeId)
    }
  }

  async invalidateJob(jobId: string): Promise<void> {
    await this.invalidateScope(jobId)
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    const errors: unknown[] = []
    for (const entry of entries) {
      try {
        await entry.runtime.close()
        if (this.entries.get(entry.key) === entry) {
          this.entries.delete(entry.key)
        }
      } catch (error) {
        errors.push(error)
      }
      if (isConversationCursorScope(entry.scopeId)) {
        if (!this.entries.has(entry.key)) {
          markConversationCursorBindingStopped(entry.scopeId)
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close one or more Cursor ACP runtimes')
    }
  }
}

let supervisorRegistry: CursorProviderRuntimeRegistry | null = null

export function getCursorProviderRuntimeRegistry(): CursorProviderRuntimeRegistry {
  if (!supervisorRegistry) {
    supervisorRegistry = new CursorProviderRuntimeRegistry()
  }
  return supervisorRegistry
}

export async function waitForCursorScopeIdle(
  scopeId: string,
  options?: { timeoutMs?: number; pollMs?: number }
): Promise<void> {
  await getCursorProviderRuntimeRegistry().waitForScopeIdle(scopeId, options)
}

export function resetCursorProviderRuntimeRegistryForTests(): void {
  supervisorRegistry = null
}

export function createCursorSessionRuntime(
  options: CursorAcpSessionRuntimeOptions
): CursorAcpSessionRuntime {
  return new CursorAcpSessionRuntime(options)
}
