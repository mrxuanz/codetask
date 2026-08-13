import { mkdirSync, writeFileSync } from 'node:fs'
import type { AgentDriver, DriverResult, DriverStartInput } from './contract'
import { progress } from '../reports/progress'
import { resolveOpencodeBudgets } from '../config/timeouts'
import { classifyDriverCatchError } from './opencode-errors'
import { runIsolatedOpencodePrompt, waitForCapabilityReport } from './opencode-prompt'
import { buildAgentOperatorPrompt } from './operator-prompt'

/**
 * OpenCode SDK driver: one server + one session per case.
 * Injects only the case-scoped Test MCP as a remote MCP server.
 *
 * Staged budgets (see resolveOpencodeBudgets):
 * - startup / prompt / capability-report stay finite by default
 * - workerMs is unbounded by default (wait for business API / case report)
 * - positive `timeoutMs` shrinks all stages under one ceiling
 * - `--no-timeout` unlocks stage ceilings (forbidden in CI)
 */
export class OpenCodeDriver implements AgentDriver {
  readonly name = 'opencode'

  async start(input: DriverStartInput): Promise<DriverResult> {
    const events: DriverResult['events'] = []
    const push = (type: string, detail?: unknown): void => {
      events.push({ type, at: new Date().toISOString(), detail })
      progress(input.caseId, type, detail)
    }
    const budgets = resolveOpencodeBudgets({
      timeoutMs: input.timeoutMs,
      noTimeout: input.noTimeout
    })
    progress(input.caseId, 'driver.start', {
      driver: this.name,
      timeoutMs: input.timeoutMs,
      noTimeout: Boolean(input.noTimeout),
      budgets: {
        startupMs: budgets.startupMs,
        promptMs: budgets.promptMs,
        capabilityReportMs: budgets.capabilityReportMs,
        workerMs: budgets.workerMs
      }
    })

    const conversationCore = input.conversationCore.trim()
    if (!conversationCore) {
      return {
        ok: false,
        classification: 'runner_crash',
        error: 'conversation_core_required',
        events
      }
    }

    // create_task-era cases were deleted from the catalog in architecture 03.

    mkdirSync(input.agentRoot, { recursive: true })
    const prompt = buildAgentOperatorPrompt(input)
    writeFileSync(`${input.agentRoot}/prompt.md`, prompt, 'utf8')

    try {
      await runIsolatedOpencodePrompt({
        workspaceRoot: input.workspaceRoot,
        mcpUrl: input.mcpUrl,
        capabilityId: input.capabilityId,
        prompt,
        budgets,
        label: input.caseId,
        onEvent: (type, detail) => push(type, detail),
        afterSuccessfulPrompt: async () => {
          const report = await waitForCapabilityReport(
            input.mcpUrl,
            input.capabilityId,
            budgets.capabilityReportMs,
            { noTimeout: budgets.noTimeout }
          )
          push('case.reported', { status: report?.status ?? null })
          if (!report || report.status !== 'completed') {
            throw new Error(`agent_no_report:${JSON.stringify(report)}`)
          }
        }
      })

      return { ok: true, events }
    } catch (error) {
      push('error', { error: String(error) })
      return {
        ok: false,
        classification: classifyDriverCatchError(error),
        error: String(error),
        events
      }
    } finally {
      await this.cleanup()
    }
  }

  async cleanup(): Promise<void> {
    // Process lifetime is owned by runIsolatedOpencodePrompt.
  }
}
