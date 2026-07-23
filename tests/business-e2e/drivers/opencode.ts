import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDriver, DriverResult, DriverStartInput } from './contract'
import { progress } from '../reports/progress'
import { buildCreateHtmlUserMessage, htmlFileNameForConversationCore } from '../config/sdk-html'
import { resolveOpencodeBudgets } from '../config/timeouts'
import { classifyDriverCatchError } from './opencode-errors'
import { runIsolatedOpencodePrompt, waitForCapabilityReport } from './opencode-prompt'

/**
 * OpenCode SDK driver: one server + one session per case.
 * Injects only the case-scoped Test MCP as a remote MCP server.
 *
 * Staged hard timeouts (see resolveOpencodeBudgets):
 * - startup / prompt / capability-report / worker
 * - `timeoutMs <= 0` uses defaults (never infinite)
 * - infinite only via explicit `noTimeout` (forbidden in CI)
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

    mkdirSync(input.agentRoot, { recursive: true })
    const skillText = input.skillPaths
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n\n---\n\n')

    const message =
      typeof input.fixture?.message === 'string'
        ? input.fixture.message
        : input.caseId === 'CHAT-HTML-001'
          ? buildCreateHtmlUserMessage(
              input.expectedHtmlFile?.trim() || htmlFileNameForConversationCore(conversationCore)
            )
          : '请用中文简短回答：1+1等于几？'

    const caseHints: Record<string, string> = {
      'CHAT-HTML-001':
        'Create project/thread with the conversation coreCode. Ask the product agent to create the SDK-named HTML file in workspace root (opencode.html / cursor.html / …) containing BUSINESS_E2E_CHAT_HTML. Wait for turn completion, then report with expectedHtmlFile in artifacts.',
      'G4-001':
        'Only unlock and send the first fixture phase (fuzzy). Do NOT unlock later phases. After the assistant replies, list drafts; do not confirm a full draft. Report completed with observations about missing info.',
      'G4-002':
        'Unlock fixture phases one at a time with case_next_fixture, send each message as a turn, until all phases are unlocked. Then list drafts and report.',
      'G4-003':
        'Complete staged collection like G4-002, then inspect draft fields via codetask_get_thread_drafts and report which required fields are present.',
      'G4-012':
        'Complete staged collection, then codetask_confirm_draft and codetask_confirm_draft_final. Verify latest job/planning exists, then report.',
      'DRAFT-MULTITURN-001':
        'Full draft multiturn: unlock all phases one-by-one, send turns, confirm draft and confirm-final, then report.'
    }

    const prompt = [
      skillText,
      '',
      '## Runtime context',
      `- caseId: ${input.caseId}`,
      `- workspaceRoot to use when creating project: ${input.workspaceRoot}`,
      `- conversationCore to use for every CodeTask thread: ${conversationCore}`,
      input.caseId.startsWith('G4') || input.caseId.startsWith('DRAFT')
        ? '- Use case_next_fixture for user messages; do not invent later phases early.'
        : `- user message for the conversation turn: ${message}`,
      caseHints[input.caseId] ? `- case-specific instructions: ${caseHints[input.caseId]}` : '',
      '',
      'Execute the skill using only the allowed Test MCP tools. Call report_case_result exactly once when done.'
    ]
      .filter(Boolean)
      .join('\n')

    writeFileSync(join(input.agentRoot, 'prompt.md'), prompt, 'utf8')

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
