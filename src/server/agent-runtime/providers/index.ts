import type { SupportedCoreCode } from '../../conversation/cores'
import type { AgentTurnChunk, AgentTurnInput, AgentTurnOptions, AgentTurnProvider } from '../types'
import { getTestAgentTurnProviderOverride } from './test-overrides'
import { createTurnError } from '../../../shared/turn-errors.ts'

export async function* streamCodexTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const provider = await import('./codex-sdk')
  yield* provider.streamCodexTurn(input, options)
}

export async function* streamClaudeTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const provider = await import('./claude-sdk')
  yield* provider.streamClaudeTurn(input, options)
}

export async function* streamOpencodeTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const provider = await import('./opencode-sdk')
  yield* provider.streamOpencodeTurn(input, options)
}

export async function* streamCursorAcpTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const provider = await import('./cursor-acp')
  yield* provider.streamCursorAcpTurn(input, options)
}

export const AGENT_TURN_PROVIDERS: Record<SupportedCoreCode, AgentTurnProvider> = {
  codex: { code: 'codex', protocol: 'sdk', streamTurn: streamCodexTurn },
  'claude-code': { code: 'claude-code', protocol: 'sdk', streamTurn: streamClaudeTurn },
  opencode: { code: 'opencode', protocol: 'sdk', streamTurn: streamOpencodeTurn },
  cursorcli: { code: 'cursorcli', protocol: 'acp', streamTurn: streamCursorAcpTurn }
}

export function getAgentTurnProvider(code: SupportedCoreCode): AgentTurnProvider {
  const override = getTestAgentTurnProviderOverride(code)
  if (override) return override
  const provider = AGENT_TURN_PROVIDERS[code]
  if (!provider) {
    throw createTurnError('provider.cli_auth_failed', {
      detail: `Unsupported CLI: ${code}`
    })
  }
  return provider
}

export const streamCursorTurn = streamCursorAcpTurn
