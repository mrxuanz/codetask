import type { FailureClass } from '../reports/writer'
import { progress } from '../reports/progress'
import { resolveOpencodeBudgets, TIMEOUTS } from '../config/timeouts'
import {
  classifyDriverCatchError,
  classifyOpencodePromptError,
  extractPromptFailure,
  extractPromptText,
  serializePromptError
} from './opencode-errors'

export type OpencodeCanaryResult = {
  ok: boolean
  classification?: FailureClass
  error?: string
}

/**
 * Minimal OpenCode canary before any OpenCode-driver business cases.
 * Confirms host OpenCode configuration, Test MCP reachability, and response text.
 */
export async function runOpencodeCanary(input: {
  mcpUrl: string
  workspaceRoot: string
}): Promise<OpencodeCanaryResult> {
  progress('supervisor', 'opencode.canary.start')

  try {
    await assertMcpReachable(input.mcpUrl)
  } catch (error) {
    const message = `mcp_unreachable:${String(error)}`
    progress('supervisor', 'opencode.canary.failed', {
      classification: 'mcp_failed',
      error: message
    })
    return { ok: false, classification: 'mcp_failed', error: message }
  }

  // Lazy-import driver helpers to keep canary colocated without circular init issues.
  const { runIsolatedOpencodePrompt } = await import('./opencode-prompt')
  const budgets = resolveOpencodeBudgets({
    timeoutMs: TIMEOUTS.opencodeCanaryMs
  })

  try {
    const result = await runIsolatedOpencodePrompt({
      workspaceRoot: input.workspaceRoot,
      mcpUrl: input.mcpUrl,
      capabilityId: 'canary',
      prompt: 'Reply with exactly the token CANARY_OK and nothing else.',
      budgets,
      label: 'canary'
    })
    const failure = extractPromptFailure(result.promptResult)
    if (failure) {
      const classification = classifyOpencodePromptError(failure)
      const error = `opencode_canary_prompt_error:${serializePromptError(failure)}`
      progress('supervisor', 'opencode.canary.failed', { classification, error })
      return { ok: false, classification, error }
    }
    const text = extractPromptText(result.promptResult).trim()
    if (text !== 'CANARY_OK') {
      const error = `opencode_canary_unexpected_response:${JSON.stringify(text)}`
      progress('supervisor', 'opencode.canary.failed', {
        classification: 'agent_failed',
        error
      })
      return { ok: false, classification: 'agent_failed', error }
    }
    progress('supervisor', 'opencode.canary.ok')
    return { ok: true }
  } catch (error) {
    const classification = classifyDriverCatchError(error)
    const message = String(error)
    progress('supervisor', 'opencode.canary.failed', { classification, error: message })
    return { ok: false, classification, error: message }
  }
}

async function assertMcpReachable(mcpUrl: string): Promise<void> {
  const statusUrl = new URL(mcpUrl)
  statusUrl.pathname = '/capability-report'
  statusUrl.searchParams.set('capabilityId', 'canary-ping')
  const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`http_${response.status}`)
  await response.json()
}
