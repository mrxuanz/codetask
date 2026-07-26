/**
 * New Provider Adapter surface (Wave 7C) + runtime profile (Wave 7A).
 *
 * Credential identity is declared via ProviderRuntimeProfile + platform path
 * resolvers. Do not reintroduce credential copy / materialize / snapshot / host sync
 * on this path — see docs/refactor/gates/wave7a.md / wave7c.md and
 * `./NO_CREDENTIAL_COPY.md`.
 */

export * from './profile/index.ts'

export type {
  ProviderEvent,
  ProviderError,
  ProviderResult
} from './events.ts'

export type {
  ProviderAdapter,
  ProviderAdapterCode,
  ProviderAvailability,
  ProviderPreflightRequest,
  ProviderPreflightResult,
  ProviderRegistry,
  ProviderTurn,
  ProviderTurnRequest
} from './types.ts'
export { PROVIDER_ADAPTER_CODES } from './types.ts'

export { classifyUnknownError } from './classify-error.ts'
export { createStubTurn } from './stub-turn.ts'
export { asProviderPort, asProviderRegistryPort } from './provider-port-bridge.ts'

export {
  FakeProviderAdapter,
  createFakeProviderAdapter,
  classifyFakeError
} from './fake/index.ts'

export {
  OpenCodeProviderAdapter,
  createOpenCodeProviderAdapter,
  classifyOpenCodeError
} from './opencode/index.ts'

export {
  CodexProviderAdapter,
  createCodexProviderAdapter,
  classifyCodexError
} from './codex/index.ts'

export {
  ClaudeProviderAdapter,
  createClaudeProviderAdapter,
  classifyClaudeError
} from './claude/index.ts'

export {
  CursorProviderAdapter,
  createCursorProviderAdapter,
  classifyCursorError
} from './cursor/index.ts'
