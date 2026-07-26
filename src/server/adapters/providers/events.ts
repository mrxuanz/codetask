/**
 * Unified ProviderEvent surface for the new adapter layer (重构.md §8.2).
 * Domain / application must never depend on Codex/Claude/OpenCode/ACP raw events.
 */

export type ProviderResult = {
  readonly reply: string
  readonly sessionId?: string | null
  readonly partial?: boolean
}

export type ProviderError = {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly category?:
    | 'auth'
    | 'availability'
    | 'cancelled'
    | 'timeout'
    | 'protocol'
    | 'unknown'
}

export type ProviderEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'tool_started'; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: 'tool_finished'; readonly toolCallId: string; readonly outcome: 'ok' | 'error' }
  | { readonly type: 'progress'; readonly code: string; readonly message?: string }
  | {
      readonly type: 'usage'
      readonly inputTokens?: number
      readonly outputTokens?: number
    }
  | { readonly type: 'result'; readonly result: ProviderResult }
  | { readonly type: 'error'; readonly error: ProviderError }
