/**
 * Shared Agent Runtime — infrastructure for Conversation, Design Planner, and Execution.
 * Business modules must not import concrete Provider SDKs; they only use AgentRuntime.
 */

export type ProviderCode = 'codex' | 'claude' | 'opencode' | 'cursor'

/** Host CLI codes used by legacy src/server provider registry. */
export type HostProviderCode = 'codex' | 'claude-code' | 'opencode' | 'cursorcli'

export type AgentRole =
  | 'conversation'
  | 'planner'
  | 'task-worker'
  | 'slice-verifier'
  | 'milestone-verifier'

export type CapabilityProfile =
  | 'chat-read'
  | 'chat-write'
  | 'planner-read'
  | 'task-sandbox'
  | 'verifier-sandbox'

export type RuntimeOwnerType = 'conversation' | 'planning' | 'work' | 'verification'

export interface McpServerBinding {
  name: string
  url: string
  headers?: Record<string, string>
}

export interface RuntimeContextPolicy {
  sessionReusable: boolean
  requiresHistorySeed: boolean
}

export interface AgentTurnInput {
  role: AgentRole
  provider: ProviderCode
  model?: string
  workspaceRoot?: string
  capabilityProfile: CapabilityProfile | string
  prompt: string
  systemPrompt: string
  mcpServers?: McpServerBinding[]
  /** Frozen user MCP map from settings snapshot (host runner). */
  userMcpServers?: Record<string, unknown>
  readRoots?: string[]
  scopeId: string
  turnId: string
  signal?: AbortSignal
}

export type AgentTurnEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; name: string; arguments: unknown }
  | { type: 'completed'; reason: string; reply?: string; providerSessionId?: string | null }
  | { type: 'failed'; message: string }

export interface RuntimeBinding {
  scopeId: string
  ownerType: RuntimeOwnerType
  ownerId: string
  providerCode: ProviderCode
  providerSessionId?: string
  status: 'active' | 'stopped' | 'expired'
  lastSeenAt: string
}

export interface RuntimeScopeState {
  scopeId: string
  binding: RuntimeBinding | null
  activeTurnIds: string[]
  contextPolicy: RuntimeContextPolicy
}

export interface AgentRuntime {
  runTurn(input: AgentTurnInput): AsyncIterable<AgentTurnEvent>
  abort(turnHandleId: string, reason: string): Promise<void>
  closeScope(scopeId: string): Promise<void>
  inspectScope(scopeId: string): Promise<RuntimeScopeState | null>
}

export interface ProviderSummary {
  code: ProviderCode
  label: string
  description: string
  available: boolean
  supportedProfiles: CapabilityProfile[]
  unavailableReason?: string
  installation?: { command?: string; executablePath?: string }
}

const HOST_TO_CANONICAL: Record<string, ProviderCode> = {
  codex: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  claude_code: 'claude',
  opencode: 'opencode',
  cursor: 'cursor',
  cursorcli: 'cursor',
  'cursor-cli': 'cursor',
  'cursor-agent': 'cursor',
  cursor_cli: 'cursor'
}

const CANONICAL_TO_HOST: Record<ProviderCode, HostProviderCode> = {
  codex: 'codex',
  claude: 'claude-code',
  opencode: 'opencode',
  cursor: 'cursorcli'
}

export function toCanonicalProviderCode(value: string): ProviderCode | null {
  return HOST_TO_CANONICAL[value.trim().toLowerCase()] ?? null
}

export function toHostProviderCode(code: ProviderCode): HostProviderCode {
  return CANONICAL_TO_HOST[code]
}

export function buildConversationScopeId(
  conversationId: string,
  providerCode: ProviderCode
): string {
  return `conversation:${conversationId}:provider:${providerCode}`
}

export function resolveReusePolicy(
  role: AgentRole,
  capabilityProfile: string
): 'one-shot' | 'conversation-scoped' {
  if (role !== 'conversation' || capabilityProfile === 'chat-write') return 'one-shot'
  return 'conversation-scoped'
}

export function contextPolicyFor(
  role: AgentRole,
  capabilityProfile: string
): RuntimeContextPolicy {
  const reuse = resolveReusePolicy(role, capabilityProfile)
  return {
    sessionReusable: reuse === 'conversation-scoped',
    requiresHistorySeed: reuse === 'one-shot' || role !== 'conversation'
  }
}

/** Placeholder until host wires real Provider SDKs via createAgentRuntime. */
export class UnsupportedAgentRuntime implements AgentRuntime {
  async *runTurn(_input: AgentTurnInput): AsyncIterable<AgentTurnEvent> {
    yield { type: 'failed', message: 'AgentRuntime adapter not wired; use createAgentRuntime.' }
  }

  async abort(): Promise<void> {}
  async closeScope(): Promise<void> {}
  async inspectScope(): Promise<RuntimeScopeState | null> {
    return null
  }
}

export type HostTurnChunk =
  | { type: 'delta'; content: string }
  | { type: 'thinking_delta'; content: string }
  | { type: 'tool_call'; name: string; arguments: unknown }
  | {
      type: 'completed'
      reply: string
      runtimeSessionId: string | null
      partial?: true
    }
  | { type: 'error'; message: string }

export type HostTurnStreamer = (
  input: AgentTurnInput & { hostProvider: HostProviderCode },
  options: { signal?: AbortSignal }
) => AsyncIterable<HostTurnChunk>

export type AgentRuntimeDeps = {
  streamTurn: HostTurnStreamer
  listProviders?: () => Promise<ProviderSummary[]>
  closeScopeImpl?: (scopeId: string) => Promise<void>
  onBindingUpsert?: (binding: RuntimeBinding) => void
}

/**
 * Shared runtime that adapts host Provider SDK/ACP streamers into the AgentRuntime port.
 * Conversation / Design / Execution all depend on this port only.
 */
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime & {
  listProviders(): Promise<ProviderSummary[]>
} {
  const active = new Map<string, AbortController>()
  const scopes = new Map<string, RuntimeBinding>()

  return {
    async *runTurn(input: AgentTurnInput): AsyncIterable<AgentTurnEvent> {
      const hostProvider = toHostProviderCode(input.provider)
      const controller = new AbortController()
      active.set(input.turnId, controller)
      const signal = input.signal
        ? AbortSignal.any([input.signal, controller.signal])
        : controller.signal

      const binding: RuntimeBinding = {
        scopeId: input.scopeId,
        ownerType:
          input.role === 'conversation'
            ? 'conversation'
            : input.role === 'planner'
              ? 'planning'
              : input.role === 'task-worker'
                ? 'work'
                : 'verification',
        ownerId: input.turnId,
        providerCode: input.provider,
        status: 'active',
        lastSeenAt: new Date().toISOString()
      }
      scopes.set(input.scopeId, binding)
      deps.onBindingUpsert?.(binding)

      try {
        for await (const chunk of deps.streamTurn(
          { ...input, hostProvider },
          { signal }
        )) {
          if (chunk.type === 'delta') {
            yield { type: 'text_delta', text: chunk.content }
          } else if (chunk.type === 'thinking_delta') {
            yield { type: 'thinking_delta', text: chunk.content }
          } else if (chunk.type === 'tool_call') {
            yield { type: 'tool_call', name: chunk.name, arguments: chunk.arguments }
          } else if (chunk.type === 'completed') {
            const next: RuntimeBinding = {
              ...binding,
              providerSessionId: chunk.runtimeSessionId ?? undefined,
              lastSeenAt: new Date().toISOString()
            }
            scopes.set(input.scopeId, next)
            deps.onBindingUpsert?.(next)
            yield {
              type: 'completed',
              reason: chunk.partial ? 'partial' : 'completed',
              reply: chunk.reply,
              providerSessionId: chunk.runtimeSessionId
            }
          } else if (chunk.type === 'error') {
            yield { type: 'failed', message: chunk.message }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        yield { type: 'failed', message }
      } finally {
        active.delete(input.turnId)
      }
    },

    async abort(turnHandleId: string, reason: string): Promise<void> {
      active.get(turnHandleId)?.abort(reason)
      active.delete(turnHandleId)
    },

    async closeScope(scopeId: string): Promise<void> {
      await deps.closeScopeImpl?.(scopeId)
      const existing = scopes.get(scopeId)
      if (existing) {
        const stopped = { ...existing, status: 'stopped' as const, lastSeenAt: new Date().toISOString() }
        scopes.set(scopeId, stopped)
        deps.onBindingUpsert?.(stopped)
      }
    },

    async inspectScope(scopeId: string): Promise<RuntimeScopeState | null> {
      const binding = scopes.get(scopeId) ?? null
      if (!binding) return null
      const profile =
        binding.ownerType === 'conversation' ? 'chat-read' : 'planner-read'
      return {
        scopeId,
        binding,
        activeTurnIds: [...active.keys()],
        contextPolicy: contextPolicyFor(
          binding.ownerType === 'conversation' ? 'conversation' : 'planner',
          profile
        )
      }
    },

    async listProviders(): Promise<ProviderSummary[]> {
      if (deps.listProviders) return deps.listProviders()
      return []
    }
  }
}

export { createAgentRuntime as createSharedAgentRuntime }

export {
  CODETEAM_MANAGER_MCP_SERVER,
  MCP_HTTP_ACCEPT_HEADER_VALUE
} from './mcp-constants.ts'

export { resolveProviderReusePolicy } from './provider-runtime.ts'
