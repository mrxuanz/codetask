/**
 * Provider contract for application workflows (Fake Provider in Wave 6).
 * Real SDK adapters land in later waves.
 */

export type ExecuteTaskRequest = {
  readonly jobId: string
  readonly taskId: string
  readonly attemptId: string
  readonly title?: string
  readonly abortSignal?: AbortSignal
  readonly timeoutMs?: number
}

export type ExecuteTaskOutcome =
  | { readonly kind: 'succeeded'; readonly resultHash: string; readonly raw?: unknown }
  | { readonly kind: 'failed'; readonly errorCode: string }
  | { readonly kind: 'inconclusive'; readonly errorCode?: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout' }

export interface ProviderPort {
  readonly code: string
  discover(): Promise<{ available: boolean }>
  preflight(request: unknown): Promise<{ ok: boolean; reason?: string }>
  runTurn(request: unknown): Promise<{ turnId: string }>
  executeTask(request: ExecuteTaskRequest): Promise<ExecuteTaskOutcome>
}

export interface ProviderRegistryPort {
  get(code: string): ProviderPort | undefined
}
