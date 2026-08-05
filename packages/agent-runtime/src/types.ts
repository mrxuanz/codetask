import type { SupportedCoreCode } from './capabilities.ts'
import type { ConversationRole } from './roles.ts'
import type { TurnErrorDto } from '@codetask/contracts/turn-errors'
import type { WorkspaceAccessMode } from '@codetask/contracts/workspace-access'
import type { AgentCapabilityProfile } from './capabilities.ts'

export type ProviderInstallationSource = 'app-config' | 'install-dir' | 'path'

/** Minimal installation snapshot carried across process boundaries. */
export interface ProviderInstallation {
  readonly id: string
  readonly provider: SupportedCoreCode
  readonly command: string
  readonly source: ProviderInstallationSource
  readonly invocation: { readonly executable: string; readonly prefixArgs: readonly string[] }
  readonly resolvedPath: string
  readonly canonicalPath: string
}

export interface ProviderRuntimeScope {
  readonly id: string
  readonly reusePolicy: 'one-shot' | 'conversation-scoped'
}

export interface ProviderSettings {
  readonly enabled: boolean
  readonly executable: { readonly mode: 'auto' } | { readonly mode: 'path'; readonly path: string }
  readonly model?: string | undefined
  readonly endpoint?: string | undefined
  readonly approveMcps: boolean
}

export interface AgentTurnInput {
  provider: SupportedCoreCode
  role: ConversationRole
  cwd: string
  prompt: string
  runtimeSessionId?: string | null | undefined
  model?: string | undefined
  systemPrompt?: string | undefined
  mcpUrl?: string | undefined
  mcpToolNames?: readonly string[] | undefined
  userMcpServers?: Record<string, unknown> | undefined
  capabilityProfile?: AgentCapabilityProfile | undefined
  installation?: ProviderInstallation | undefined
  providerSettings?: ProviderSettings | undefined
  providerRuntimeScope?: ProviderRuntimeScope | undefined
  providerRuntimeScopeId?: string | undefined
  readRoots?: string[] | undefined
  jobId?: string | undefined
  workloadRunId?: string | undefined
  idempotencyKey?: string | undefined
}

export type RoleWorkerInput = AgentTurnInput

export type AgentTurnChunk =
  | { type: 'delta'; content: string }
  | { type: 'thinking_delta'; content: string }
  | { type: 'completed'; reply: string; runtimeSessionId: string | null; partial?: true }
  | { type: 'error'; message: string; error?: TurnErrorDto; code?: TurnErrorDto['code'] }

export type SdkTurnChunk = AgentTurnChunk

export interface AgentTurnOptions {
  outerSandbox?: boolean | undefined
  signal?: AbortSignal | undefined
}

export type { ProviderRunPolicy, ProviderAuthMode } from './provider-policy.ts'
export { resolveProviderRunPolicy } from './provider-policy.ts'

export type SdkTurnOptions = AgentTurnOptions

export interface AgentTurnRunnerInput {
  role: ConversationRole
  provider: SupportedCoreCode
  workspaceRoot: string
  prompt: string
  runtimeSessionId?: string | null | undefined
  model?: string | undefined
  systemPrompt?: string | undefined
  mcpUrl?: string | undefined
  mcpToolNames?: readonly string[] | undefined
  userMcpServers?: Record<string, unknown> | undefined
  mcpToken?: string | undefined
  signal?: AbortSignal | undefined
  capabilityProfile: AgentCapabilityProfile
  readRoots?: string[] | undefined
  workspaceAccess?: WorkspaceAccessMode | undefined
  workspaceLease?:
    | {
        leaseId: string
        ownerKind: 'conversation' | 'planner' | 'thread_job' | 'job-run'
        ownerId: string
      }
    | undefined
  jobId?: string | undefined
  workloadRunId?: string | undefined
  idempotencyKey?: string | undefined
  installation?: ProviderInstallation | undefined
  providerSettings?: ProviderSettings | undefined
  providerRuntimeScope?: ProviderRuntimeScope | undefined
  providerRuntimeScopeId?: string | undefined
}

export interface AgentTurnProvider {
  code: SupportedCoreCode
  protocol: 'sdk' | 'acp' | 'local-server' | 'fake'
  streamTurn(input: AgentTurnInput, options?: AgentTurnOptions): AsyncGenerator<AgentTurnChunk>
}

export type { SupportedCoreCode, AgentCapabilityProfile, WorkspaceAccessMode }
