/**
 * Host turn streamer for AgentRuntime — wraps streamAgentTurn without
 * design-module dynamically importing the runner mega-adapter.
 */
import type { AgentTurnInput, HostTurnChunk, HostTurnStreamer } from '@codetask/agent-runtime'
import { streamAgentTurn } from './runner'
import type { AgentCapabilityProfile } from './capabilities'

function mapRole(
  role: AgentTurnInput['role']
): 'conversation' | 'planner' | 'task-worker' | 'slice-verifier' | 'milestone-verifier' {
  if (role === 'slice-verifier' || role === 'milestone-verifier') return role
  if (role === 'task-worker') return 'task-worker'
  if (role === 'planner') return 'planner'
  return 'conversation'
}

export const hostAgentTurnStreamer: HostTurnStreamer = async function* (
  input: AgentTurnInput,
  options: { signal?: AbortSignal }
): AsyncIterable<HostTurnChunk> {
  for await (const chunk of streamAgentTurn({
    role: mapRole(input.role),
    provider: input.provider,
    workspaceRoot: input.workspaceRoot ?? '',
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    capabilityProfile: input.capabilityProfile as AgentCapabilityProfile,
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
  })) {
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
}
