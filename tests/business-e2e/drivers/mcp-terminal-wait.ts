import type { McpToolClient } from '../mcp/client'

export const DEFAULT_WAIT_SLICE_MS = 30_000
export const DEFAULT_RETRY_DELAY_MS = 500

type McpWaitClient = Pick<McpToolClient, 'callTool'>

export type McpTerminalWaitRetry = {
  attempt: number
  error: string
}

/**
 * Node fetch/undici defaults headersTimeout to 300s. A single unbounded
 * `tools/call` that polls CodeTask forever never sends response headers in
 * time, so the client dies with `TypeError: fetch failed`. Slice waits stay
 * under that ceiling; only read-only wait tools may retry.
 */
export function isRetryableMcpTerminalWaitError(error: unknown): boolean {
  const text = String(error).toLowerCase()
  return /timeout:(?:job_|turn_)|fetch failed|econnreset|econnrefused|etimedout|socket|network|aborterror/.test(
    text
  )
}

export async function waitForMcpTerminalViaSlices(
  mcp: McpWaitClient,
  input: {
    toolName: 'codetask_wait_job' | 'codetask_wait_turn'
    args: Record<string, unknown>
    sliceTimeoutMs?: number
    retryDelayMs?: number
    onRetry?: (retry: McpTerminalWaitRetry) => void
  }
): Promise<Record<string, unknown>> {
  const sliceTimeoutMs = input.sliceTimeoutMs ?? DEFAULT_WAIT_SLICE_MS
  const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  for (let attempt = 1; ; attempt++) {
    try {
      return (await mcp.callTool(input.toolName, {
        ...input.args,
        timeoutMs: sliceTimeoutMs
      })) as Record<string, unknown>
    } catch (error) {
      if (!isRetryableMcpTerminalWaitError(error)) throw error
      input.onRetry?.({ attempt, error: String(error) })
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  }
}
