import type { McpToolClient } from '../mcp/client'

const DEFAULT_WAIT_SLICE_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 500

type JobWaitClient = Pick<McpToolClient, 'callTool'>

export type JobWaitRetry = {
  attempt: number
  error: string
}

export function isRetryableMcpJobWaitError(error: unknown): boolean {
  const text = String(error).toLowerCase()
  return /timeout:job_|fetch failed|econnreset|econnrefused|etimedout|socket|network|aborterror/.test(
    text
  )
}

/**
 * Wait through bounded MCP requests so Node's HTTP response-header timeout cannot
 * terminate a healthy, long-running CodeTask job. Only this read-only operation is
 * retried; mutation tools must never use this helper.
 */
export async function waitForJobTerminalViaMcp(
  mcp: JobWaitClient,
  input: {
    threadId: string
    jobId: string
    sliceTimeoutMs?: number
    retryDelayMs?: number
    onRetry?: (retry: JobWaitRetry) => void
  }
): Promise<Record<string, unknown>> {
  const sliceTimeoutMs = input.sliceTimeoutMs ?? DEFAULT_WAIT_SLICE_MS
  const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  for (let attempt = 1; ; attempt++) {
    try {
      return (await mcp.callTool('codetask_wait_job', {
        threadId: input.threadId,
        jobId: input.jobId,
        timeoutMs: sliceTimeoutMs
      })) as Record<string, unknown>
    } catch (error) {
      if (!isRetryableMcpJobWaitError(error)) throw error
      input.onRetry?.({ attempt, error: String(error) })
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  }
}
