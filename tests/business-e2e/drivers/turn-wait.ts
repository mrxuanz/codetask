import {
  isRetryableMcpTerminalWaitError,
  waitForMcpTerminalViaSlices,
  type McpTerminalWaitRetry
} from './mcp-terminal-wait'
import type { McpToolClient } from '../mcp/client'

type TurnWaitClient = Pick<McpToolClient, 'callTool'>

export type TurnWaitRetry = McpTerminalWaitRetry

/** @deprecated Prefer {@link isRetryableMcpTerminalWaitError} */
export const isRetryableMcpTurnWaitError = isRetryableMcpTerminalWaitError

/**
 * Wait through bounded MCP requests so Node's HTTP response-header timeout cannot
 * terminate a healthy, long-running CodeTask conversation turn.
 */
export async function waitForTurnTerminalViaMcp(
  mcp: TurnWaitClient,
  input: {
    threadId: string
    turnId: string
    sliceTimeoutMs?: number
    retryDelayMs?: number
    onRetry?: (retry: TurnWaitRetry) => void
  }
): Promise<Record<string, unknown>> {
  return waitForMcpTerminalViaSlices(mcp, {
    toolName: 'codetask_wait_turn',
    args: { threadId: input.threadId, turnId: input.turnId },
    sliceTimeoutMs: input.sliceTimeoutMs,
    retryDelayMs: input.retryDelayMs,
    onRetry: input.onRetry
  })
}
