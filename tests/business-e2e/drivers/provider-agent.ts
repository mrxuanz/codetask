import { mkdirSync, writeFileSync } from 'node:fs'
import {
  getAgentTurnProvider,
  getProviderDescriptor,
  getProviderRuntimeManager
} from '@codetask/provider-runtime-node'
import { initializeProcessHostEnvironment } from '@codetask/agent-runtime/host-environment'
import type { AgentTurnChunk } from '@codetask/agent-runtime/types'
import type { AgentDriver, DriverResult, DriverStartInput } from './contract'
import type { LiveOperatorCode } from '../config/operators'
import { OPERATOR_PROTOCOLS } from '../config/operators'
import { resolveAgentBudgets } from '../config/timeouts'
import { progress } from '../reports/progress'
import { classifyDriverCatchError } from './opencode-errors'
import { waitForCapabilityReport } from './opencode-prompt'
import { buildAgentOperatorPrompt } from './operator-prompt'

const TEST_MCP_SERVER_NAME = 'codetask-business-test'
const MCP_ACCEPT = 'application/json, text/event-stream'

/** Provider-native user MCP configuration, including the case capability header.
 * The shapes intentionally mirror the production CodeTask provider adapters.
 */
export function buildOperatorMcpServers(input: {
  operator: LiveOperatorCode
  mcpUrl: string
  capabilityId: string
  allowedTools: readonly string[]
}): Record<string, unknown> {
  const sharedHeaders = {
    Accept: MCP_ACCEPT,
    'X-Business-Capability': input.capabilityId
  }
  const tools = Object.fromEntries(
    input.allowedTools.map((name) => [name, { approval_mode: 'approve' as const }])
  )

  if (input.operator === 'codex') {
    return {
      [TEST_MCP_SERVER_NAME]: {
        url: input.mcpUrl,
        http_headers: sharedHeaders,
        required: true,
        default_tools_approval_mode: 'approve',
        tools
      }
    }
  }
  if (input.operator === 'claude') {
    return {
      [TEST_MCP_SERVER_NAME]: {
        type: 'http',
        url: input.mcpUrl,
        headers: sharedHeaders
      }
    }
  }
  if (input.operator === 'cursor') {
    return {
      [TEST_MCP_SERVER_NAME]: {
        url: input.mcpUrl,
        headers: sharedHeaders
      }
    }
  }
  return {
    [TEST_MCP_SERVER_NAME]: {
      type: 'remote',
      url: input.mcpUrl,
      enabled: true,
      headers: sharedHeaders
    }
  }
}

function pushChunkEvent(
  push: (type: string, detail?: unknown) => void,
  chunk: AgentTurnChunk
): void {
  if (chunk.type === 'delta' || chunk.type === 'thinking_delta') {
    push(`operator.${chunk.type}`, { chars: chunk.content.length })
    return
  }
  if (chunk.type === 'error') {
    push('operator.error_chunk', { code: chunk.code ?? null, message: chunk.message })
    return
  }
  push('operator.completed', {
    replyChars: chunk.reply.length,
    runtimeSessionId: chunk.runtimeSessionId ?? null,
    partial: chunk.partial === true
  })
}

/**
 * SDK/ACP outer actor. This is deliberately test-only, but it enters through the
 * same Provider Registry + Runtime Manager used by CodeTask itself.
 */
export class ProviderAgentDriver implements AgentDriver {
  readonly name: LiveOperatorCode
  readonly protocol: 'sdk' | 'acp'
  private cleaned = false

  constructor(readonly operator: Exclude<LiveOperatorCode, 'opencode'>) {
    this.name = operator
    const protocol = OPERATOR_PROTOCOLS[operator]
    if (protocol !== 'sdk' && protocol !== 'acp') {
      throw new Error(`unsupported_provider_agent_protocol:${operator}:${protocol}`)
    }
    this.protocol = protocol
  }

  async start(input: DriverStartInput): Promise<DriverResult> {
    const events: DriverResult['events'] = []
    const push = (type: string, detail?: unknown): void => {
      events.push({ type, at: new Date().toISOString(), detail })
      progress(input.caseId, type, detail)
    }
    const budgets = resolveAgentBudgets({
      timeoutMs: input.timeoutMs,
      noTimeout: input.noTimeout
    })
    const prompt = buildAgentOperatorPrompt(input)

    mkdirSync(input.agentRoot, { recursive: true })
    writeFileSync(`${input.agentRoot}/prompt.md`, prompt, 'utf8')
    progress(input.caseId, 'driver.start', {
      driver: this.name,
      protocol: this.protocol,
      timeoutMs: input.timeoutMs,
      noTimeout: Boolean(input.noTimeout)
    })

    const controller = new AbortController()
    const timeout =
      Number.isFinite(budgets.promptMs) && budgets.promptMs < Number.MAX_SAFE_INTEGER
        ? setTimeout(
            () => controller.abort(new Error(`timeout:${this.operator}_operator_turn`)),
            budgets.promptMs
          )
        : null

    try {
      await initializeProcessHostEnvironment()
      const descriptor = getProviderDescriptor(this.operator)
      if (descriptor.capabilities.protocol !== this.protocol) {
        throw new Error(
          `operator_protocol_mismatch:${this.operator}:${descriptor.capabilities.protocol}`
        )
      }

      const provider = getAgentTurnProvider(this.operator)
      if (provider.protocol !== this.protocol) {
        throw new Error(`operator_runtime_protocol_mismatch:${this.operator}:${provider.protocol}`)
      }
      const stream = provider.streamTurn(
        {
          provider: this.operator,
          role: 'conversation',
          cwd: input.workspaceRoot,
          prompt,
          systemPrompt:
            'You are the outer business-E2E operator. Use the case-scoped MCP tools to operate CodeTask exactly as a human would.',
          userMcpServers: buildOperatorMcpServers({
            operator: this.operator,
            mcpUrl: input.mcpUrl,
            capabilityId: input.capabilityId,
            allowedTools: input.allowedTools
          }),
          capabilityProfile: 'chat-read',
          providerRuntimeScopeId: `business-e2e:operator:${input.caseRunId}:${this.operator}`
        },
        { signal: controller.signal }
      )

      let completed = false
      for await (const chunk of stream) {
        pushChunkEvent(push, chunk)
        if (chunk.type === 'error') throw new Error(`operator_error:${chunk.message}`)
        if (chunk.type === 'completed') completed = true
      }
      if (!completed) throw new Error(`${this.operator}_operator_stream_incomplete`)

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
      if (timeout) clearTimeout(timeout)
      await this.cleanup()
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return
    this.cleaned = true
    await getProviderRuntimeManager().closeAll()
  }
}
