import type { SupportedCoreCode } from '../conversation/cores'
import type { ConversationRole } from './roles'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import type { WorkspaceAccessMode } from '../../shared/workspace-access.ts'
import type { AgentCapabilityProfile } from './capabilities'
import type { ProviderInstallation } from '../../shared/providers/installation'
import type { ProviderRuntimeScope } from '../../shared/providers/capabilities'
import type { ProviderSettings } from '../../shared/providers/settings'

export interface AgentTurnInput {
  provider: SupportedCoreCode
  role: ConversationRole
  cwd: string
  runtimeRoot: string
  prompt: string
  runtimeSessionId?: string | null | undefined
  model?: string | undefined
  systemPrompt?: string | undefined
  mcpUrl?: string | undefined
  mcpToolNames?: readonly string[] | undefined
  userMcpServers?: Record<string, unknown> | undefined
  capabilityProfile?: AgentCapabilityProfile | undefined
  /** Immutable installation selected before crossing a process boundary. */
  installation?: ProviderInstallation | undefined
  /** Typed settings snapshot selected with `installation`; never reconstructed from env. */
  providerSettings?: ProviderSettings | undefined
  /** Reuse scope selected exclusively by ProviderRuntimeManager. */
  providerRuntimeScope?: ProviderRuntimeScope | undefined
  /** Stable conversation identity supplied to, but policy-wrapped by, RuntimeManager. */
  providerRuntimeScopeId?: string | undefined

  jobId?: string | undefined
  workloadRunId?: string | undefined
  /** Stable logical-task idempotency key for side-effect dedupe across retries. */
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

export type { ProviderRunPolicy, ProviderAuthMode } from './provider-policy'
export { resolveProviderRunPolicy } from './provider-policy'

export type SdkTurnOptions = AgentTurnOptions

export interface AgentTurnRunnerInput {
  role: ConversationRole
  provider: SupportedCoreCode
  workspaceRoot: string
  runtimeRoot: string
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
  /** Explicit lease identity used to fail closed before enabling main-workspace writes. */
  workspaceLease?:
    | {
        leaseId: string
        ownerKind: 'conversation' | 'planner' | 'thread_job'
        ownerId: string
      }
    | undefined

  jobId?: string | undefined
  providerRuntimeScopeId?: string | undefined
  workloadRunId?: string | undefined
  /** Stable logical-task idempotency key for side-effect dedupe across retries. */
  idempotencyKey?: string | undefined
}

export interface AgentTurnProvider {
  code: SupportedCoreCode
  protocol: 'sdk' | 'acp' | 'local-server' | 'fake'
  streamTurn(input: AgentTurnInput, options?: AgentTurnOptions): AsyncGenerator<AgentTurnChunk>
}
