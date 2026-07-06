import { throwSdkTurnError } from '../errors'
import { sandboxTurnDebug } from '../../debug/sandbox-turn'
import { buildCodexTurnPlan } from './codex-policy'
import { createTurnError, TURN_CANCELLED } from '../../../shared/turn-errors.ts'
import type { AgentTurnInput, AgentTurnChunk, AgentTurnOptions } from '../types'
import { advanceTextSnapshot } from '../delta-emit'
import { extractCodexReasoningText } from '../reasoning-text'
import { TurnWatchdog, assertRoleTurnReply, recordCodexThreadItemActivity } from '../turn-watchdog'

function extractAgentText(item: { type?: string; text?: string }): string | null {
  if (item.type === 'agent_message' && item.text) {
    return item.text
  }
  return null
}

function extractReasoningText(item: {
  type?: string
  text?: string
  summary_text?: string[]
  summaryText?: string[]
  raw_content?: string[]
  rawContent?: string[]
  summary?: Array<{ type?: string; text?: string }>
}): string | null {
  return extractCodexReasoningText(item)
}

function logCodexMcpItem(item: {
  type?: string
  server?: string
  tool?: string
  status?: string
  error?: { message?: string }
}): void {
  if (item.type !== 'mcp_tool_call') return
  sandboxTurnDebug('codex: mcp_tool_call', {
    server: item.server,
    tool: item.tool,
    status: item.status,
    error: item.error?.message
  })
}

export async function* streamCodexTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const { Codex } = await import('@openai/codex-sdk')
  const userMcpServers = input.userMcpServers ?? {}
  const plan = buildCodexTurnPlan(input, {
    outerSandbox: options?.outerSandbox,
    userMcpServers
  })

  sandboxTurnDebug('codex: turn plan', {
    role: plan.role,
    outerSandbox: plan.outerSandbox,
    sandboxMode: plan.threadOptions.sandboxMode,
    mcpToolNames: plan.mcpToolNames
  })

  const codex = new Codex({
    env: plan.env,
    ...(plan.sdkConfig
      ? {
          config: plan.sdkConfig as NonNullable<ConstructorParameters<typeof Codex>[0]>['config']
        }
      : {})
  })

  const thread = input.runtimeSessionId
    ? codex.resumeThread(input.runtimeSessionId, plan.threadOptions)
    : codex.startThread(plan.threadOptions)

  const prompt = input.systemPrompt
    ? `${input.systemPrompt}\n\n---\n\n${input.prompt}`
    : input.prompt

  const turnAbort = new AbortController()
  const externalSignal = options?.signal
  if (externalSignal?.aborted) {
    throw TURN_CANCELLED
  }
  externalSignal?.addEventListener('abort', () => turnAbort.abort(), { once: true })

  const watchdog = new TurnWatchdog({
    role: input.role,
    externalSignal,
    onAbort: () => turnAbort.abort()
  })
  watchdog.arm()

  const streamed = await thread.runStreamed(prompt, { signal: turnAbort.signal })
  let reply = ''
  let thinking = ''
  let turnFinished = false

  const finishTurn = function* (): Generator<AgentTurnChunk, void, unknown> {
    turnFinished = true
    assertRoleTurnReply({ role: input.role, reply, providerLabel: 'Codex' })
    sandboxTurnDebug('codex: turn.completed')
    yield {
      type: 'completed',
      reply: reply.trim() || '',
      runtimeSessionId: thread.id
    }
    turnAbort.abort()
  }

  const eventIterator = streamed.events[Symbol.asyncIterator]()

  try {
    while (true) {
      const next = await watchdog.race(eventIterator.next())
      if (next.done) break

      const event = next.value
      watchdog.recordActivity('provider_event')

      if (
        event.type === 'item.updated' ||
        event.type === 'item.started' ||
        event.type === 'item.completed'
      ) {
        logCodexMcpItem(event.item)
        recordCodexThreadItemActivity(event.item, watchdog)
      }

      if (event.type === 'item.updated' || event.type === 'item.completed') {
        const reasoning = extractReasoningText(event.item)
        if (reasoning && reasoning !== thinking) {
          const advanced = advanceTextSnapshot(thinking, reasoning)
          thinking = advanced.text
          watchdog.recordActivity('thinking_delta')
          if (advanced.delta) yield { type: 'thinking_delta', content: advanced.delta }
        }

        const text = extractAgentText(event.item)
        if (text && text !== reply) {
          const advanced = advanceTextSnapshot(reply, text)
          reply = advanced.text
          watchdog.recordActivity('text_delta')
          if (advanced.delta) yield { type: 'delta', content: advanced.delta }
        }
        continue
      }

      if (event.type === 'item.started') {
        const reasoning = extractReasoningText(event.item)
        if (reasoning && reasoning !== thinking) {
          const advanced = advanceTextSnapshot(thinking, reasoning)
          thinking = advanced.text
          watchdog.recordActivity('thinking_delta')
          if (advanced.delta) yield { type: 'thinking_delta', content: advanced.delta }
        }
        continue
      }

      if (event.type === 'turn.completed') {
        yield* finishTurn()
        return
      }

      if (event.type === 'turn.failed') {
        sandboxTurnDebug('codex: turn.failed', {
          role: plan.role,
          message: event.error.message
        })
        throw new Error(event.error.message)
      }
    }
  } catch (error) {
    if (turnFinished) return
    if (turnAbort.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      sandboxTurnDebug('codex: turn aborted', {
        role: plan.role,
        replyChars: reply.length,
        aborted: true
      })
      throw TURN_CANCELLED
    }
    sandboxTurnDebug('codex: turn error', {
      role: plan.role,
      replyChars: reply.length,
      error: error instanceof Error ? error.message : String(error)
    })
    throwSdkTurnError(error)
  } finally {
    watchdog.dispose()
    await eventIterator.return?.(undefined).catch(() => {})
  }

  if (!turnFinished) {
    sandboxTurnDebug('codex: stream ended without turn.completed', {
      role: plan.role,
      replyChars: reply.length
    })
    throw createTurnError('provider.codex.stream_disconnected', {
      detail: 'Codex stream ended without turn.completed'
    })
  }
}
