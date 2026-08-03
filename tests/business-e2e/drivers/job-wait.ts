import {
  isRetryableMcpTerminalWaitError,
  waitForMcpTerminalViaSlices,
  type McpTerminalWaitRetry
} from './mcp-terminal-wait'
import type { McpToolClient } from '../mcp/client'

type JobWaitClient = Pick<McpToolClient, 'callTool'>

export type JobWaitRetry = McpTerminalWaitRetry

export const isRetryableMcpJobWaitError = isRetryableMcpTerminalWaitError

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
  return waitForMcpTerminalViaSlices(mcp, {
    toolName: 'codetask_wait_job',
    args: { threadId: input.threadId, jobId: input.jobId },
    sliceTimeoutMs: input.sliceTimeoutMs,
    retryDelayMs: input.retryDelayMs,
    onRetry: input.onRetry
  })
}
