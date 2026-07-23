import type { SupportedCoreCode } from '../../conversation/cores'
import type { AgentTurnChunk, AgentTurnInput, AgentTurnOptions, AgentTurnProvider } from '../types'
import { createTurnError } from '../../../shared/turn-errors.ts'
import { getTestProviderRegistryOverride } from './test-overrides'
import { getProviderRegistry, getProviderRuntimeManager } from '../../providers/access'
import { buildProviderTurnContext } from '../../providers/driver'

export async function* streamCodexTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  // PRU-07-08: production Codex turns always go through Registry + RuntimeManager.
  yield* getAgentTurnProvider('codex').streamTurn(input, options)
}

export async function* streamClaudeTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  // PRU-08-08: production Claude turns always go through Registry + RuntimeManager.
  yield* getAgentTurnProvider('claude-code').streamTurn(input, options)
}

export async function* streamOpencodeTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  // PRU-09-08: production OpenCode turns always go through Registry + RuntimeManager.
  yield* getAgentTurnProvider('opencode').streamTurn(input, options)
}

export async function* streamCursorAcpTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  // PRU-10-08: production Cursor turns always go through Registry + RuntimeManager.
  yield* getAgentTurnProvider('cursorcli').streamTurn(input, options)
}

export function getAgentTurnProvider(code: SupportedCoreCode): AgentTurnProvider {
  const registry = getTestProviderRegistryOverride() ?? getProviderRegistry()
  if (!registry.has(code)) {
    throw createTurnError('provider.cli_auth_failed', {
      detail: `Unsupported CLI: ${code}`
    })
  }
  const driver = registry.get(code)
  return {
    code,
    protocol: driver.kind === 'test-fake' ? 'fake' : driver.descriptor.capabilities.protocol,
    streamTurn: (input, options) =>
      getProviderRuntimeManager().stream(
        driver,
        buildProviderTurnContext({
          input,
          options,
          authMode: driver.descriptor.capabilities.authMode
        })
      )
  }
}

export const streamCursorTurn = streamCursorAcpTurn
