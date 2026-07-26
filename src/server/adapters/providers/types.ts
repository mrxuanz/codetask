import type { ProviderError, ProviderEvent } from './events'

/** Stable adapter identity codes for the Wave 7C registry. */
export const PROVIDER_ADAPTER_CODES = [
  'fake',
  'opencode',
  'codex',
  'claude',
  'cursor'
] as const

export type ProviderAdapterCode = (typeof PROVIDER_ADAPTER_CODES)[number]

export type ProviderAvailability = {
  readonly available: boolean
  readonly reason?: string
  /** When true, adapter satisfies contract without live SDK/CLI. */
  readonly stub?: boolean
}

export type ProviderPreflightRequest = {
  readonly workspaceRoot?: string
  readonly runtimeRoot?: string
  readonly skipAuthProbe?: boolean
}

export type ProviderPreflightResult = {
  readonly ok: boolean
  readonly reason?: string
  readonly stub?: boolean
}

export type ProviderTurnRequest = {
  readonly prompt?: string
  readonly sessionId?: string | null
  readonly model?: string
  readonly workspaceRoot?: string
  readonly runtimeRoot?: string
  readonly abortSignal?: AbortSignal
}

export interface ProviderTurn {
  readonly turnId: string
  readonly sessionId?: string | null
  stream(signal?: AbortSignal): AsyncIterable<ProviderEvent>
  cancel(reason?: string): Promise<void>
  close(): Promise<void>
}

/**
 * Production-shaped Provider adapter contract.
 * Business layers depend only on this surface + ProviderEvent.
 */
export interface ProviderAdapter {
  readonly code: ProviderAdapterCode
  /** True when this instance is stub-backed (no live SDK). Fake is never stub. */
  readonly stubMode: boolean
  discover(): Promise<ProviderAvailability>
  preflight(request?: ProviderPreflightRequest): Promise<ProviderPreflightResult>
  runTurn(request?: ProviderTurnRequest): Promise<ProviderTurn>
  classifyError(error: unknown): ProviderError
}

export type ProviderRegistry = {
  get(code: string): ProviderAdapter | undefined
  list(): readonly ProviderAdapter[]
  codes(): readonly ProviderAdapterCode[]
  has(code: string): boolean
}
