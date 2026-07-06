import type { SupportedCoreCode } from '../conversation/cores'
import type { ConversationRole } from './roles'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'

export interface AgentTurnInput {
  provider: SupportedCoreCode
  role: ConversationRole
  cwd: string
  runtimeRoot: string
  prompt: string
  runtimeSessionId?: string | null
  model?: string
  systemPrompt?: string
  mcpUrl?: string
  mcpToolNames?: readonly string[]
  userMcpServers?: Record<string, unknown>

  jobId?: string
}

export type RoleWorkerInput = AgentTurnInput

export type AgentTurnChunk =
  | { type: 'delta'; content: string }
  | { type: 'thinking_delta'; content: string }
  | { type: 'completed'; reply: string; runtimeSessionId: string | null }
  | { type: 'error'; message: string; error?: TurnErrorDto; code?: TurnErrorDto['code'] }

export type SdkTurnChunk = AgentTurnChunk

export interface AgentTurnOptions {
  outerSandbox?: boolean
  signal?: AbortSignal
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
  runtimeSessionId?: string | null
  model?: string
  systemPrompt?: string
  mcpUrl?: string
  mcpToolNames?: readonly string[]
  userMcpServers?: Record<string, unknown>
  mcpToken?: string
  signal?: AbortSignal

  readRoots?: string[]

  jobId?: string
}

export interface AgentTurnProvider {
  code: SupportedCoreCode
  protocol: 'sdk' | 'acp' | 'fake'
  streamTurn(input: AgentTurnInput, options?: AgentTurnOptions): AsyncGenerator<AgentTurnChunk>
}
