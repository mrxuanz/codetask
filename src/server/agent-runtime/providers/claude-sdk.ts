import { throwSdkTurnError } from '../errors'
import { buildClaudeTurnOptions } from '../../providers/claude/turn-options'
import { createTurnError } from '../../../shared/turn-errors.ts'
import type { AgentTurnInput, AgentTurnChunk, AgentTurnOptions } from '../types'
import { advanceTextSnapshot, appendTextPiece } from '../delta-emit'
import {
  recordClaudeStreamActivity,
  assertRoleTurnReply,
  partialCompletedChunk
} from '../turn-scope'
import { abortReason, createProviderTurnScope, forwardAbortSignal } from '../provider-turn'
import { sandboxTurnDebug } from '../../debug/sandbox-turn'
import {
  requiresClaudeSdkSpawnGateway,
  spawnClaudeSdkInvocation
} from '../../providers/claude/sdk-spawn'
import type {
  SpawnOptions as ClaudeSdkSpawnOptions,
  SpawnedProcess
} from '@anthropic-ai/claude-agent-sdk'

export async function* streamClaudeTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const plan = buildClaudeTurnOptions(input, { outerSandbox: options?.outerSandbox })
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const executableInvocation = plan.executableInvocation
  const spawnClaudeCodeProcess =
    executableInvocation && requiresClaudeSdkSpawnGateway(executableInvocation)
      ? (spawnOptions: ClaudeSdkSpawnOptions): SpawnedProcess =>
          spawnClaudeSdkInvocation(executableInvocation, spawnOptions) as SpawnedProcess
      : undefined
  let reply = ''
  let thinking = ''

  sandboxTurnDebug('claude: turn options', {
    outerSandbox: plan.outerSandbox,
    readOnly: plan.readOnly,
    installationId: plan.installationId,
    pathToClaudeCodeExecutable: plan.pathToClaudeCodeExecutable,
    structuredSpawn: Boolean(spawnClaudeCodeProcess),
    settingSources: plan.settingSources,
    pinMcpConfig: plan.pinMcpConfig
  })

  const turnScope = createProviderTurnScope(input.role, options, {})
  const turnAbort = new AbortController()
  if (turnScope.signal.aborted) {
    throw abortReason(turnScope.signal)
  }
  const turnAbortListener = forwardAbortSignal(turnScope.signal, turnAbort)

  const stream = query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      systemPrompt: plan.systemPrompt,
      settingSources: [...plan.settingSources],
      ...(plan.readOnly ? { skills: [], plugins: [] } : {}),
      tools: [...plan.builtins],
      allowedTools: [...plan.allowedTools],
      disallowedTools: [...plan.disallowedTools],
      permissionMode: 'bypassPermissions',
      persistSession: true,
      abortController: turnAbort,
      env: plan.env,
      sandbox: { enabled: false },
      ...(plan.model !== undefined ? { model: plan.model } : {}),
      ...(plan.resume ? { resume: plan.resume } : {}),
      ...(plan.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: plan.pathToClaudeCodeExecutable }
        : {}),
      ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
      ...(plan.pinMcpConfig
        ? {
            mcpServers: plan.mcpServers as NonNullable<
              NonNullable<Parameters<typeof query>[0]['options']>['mcpServers']
            >,
            strictMcpConfig: true
          }
        : {})
    }
  })
  let sessionId = input.runtimeSessionId ?? null
  const messageIterator = stream[Symbol.asyncIterator]()
  let streamEndedNormally = false

  try {
    while (true) {
      const next = await turnScope.race(messageIterator.next())
      if (next.done) {
        streamEndedNormally = true
        break
      }

      const message = next.value
      recordClaudeStreamActivity(message, turnScope)

      const typed = message as {
        type?: string
        session_id?: string
        result?: string
        event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
        message?: { content?: Array<{ type?: string; text?: string; thinking?: string }> }
      }

      if (typed.session_id) {
        sessionId = typed.session_id
      }

      if (typed.type === 'stream_event') {
        const delta = typed.event?.delta
        if (
          typed.event?.type === 'content_block_delta' &&
          delta?.type === 'thinking_delta' &&
          typeof delta.thinking === 'string' &&
          delta.thinking
        ) {
          const advanced = appendTextPiece(thinking, delta.thinking)
          thinking = advanced.text
          turnScope.recordProgress('thinking_delta')
          if (advanced.delta) yield { type: 'thinking_delta', content: advanced.delta }
          continue
        }
        if (
          typed.event?.type === 'content_block_delta' &&
          delta?.type === 'text_delta' &&
          delta.text
        ) {
          const advanced = appendTextPiece(reply, delta.text)
          reply = advanced.text
          turnScope.recordProgress('text_delta')
          if (advanced.delta) yield { type: 'delta', content: advanced.delta }
        }
        continue
      }

      if (typed.type === 'result' && typed.result) {
        const advanced = advanceTextSnapshot(reply, typed.result)
        reply = advanced.text
        turnScope.recordProgress('text_delta')
        if (advanced.delta) yield { type: 'delta', content: advanced.delta }
        continue
      }

      const blocks = typed.message?.content
      if (!blocks) continue

      for (const block of blocks) {
        if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking.trim()
        ) {
          const advanced = advanceTextSnapshot(thinking, block.thinking)
          thinking = advanced.text
          turnScope.recordProgress('thinking_delta')
          if (advanced.delta) yield { type: 'thinking_delta', content: advanced.delta }
        }
      }

      const text = blocks
        .filter((block) => block.type === 'text' || block.text)
        .map((block) => block.text ?? '')
        .join('')
        .trim()

      if (text) {
        const advanced = advanceTextSnapshot(reply, text)
        reply = advanced.text
        turnScope.recordProgress('text_delta')
        if (advanced.delta) yield { type: 'delta', content: advanced.delta }
      }
    }
  } catch (error) {
    const partial = partialCompletedChunk({
      reply,
      runtimeSessionId: sessionId,
      graceCancelled: turnScope.graceCancelled
    })
    if (partial) {
      yield partial
      return
    }
    if (turnAbort.signal.aborted || turnScope.signal.aborted) {
      throw abortReason(turnScope.signal)
    }
    throwSdkTurnError(error)
  } finally {
    turnScope.signal.removeEventListener('abort', turnAbortListener)
    turnScope.dispose()
    await messageIterator.return?.(undefined).catch(() => {})
  }

  if (!streamEndedNormally) {
    throw createTurnError('turn.incomplete', {
      detail: 'Claude SDK stream ended abnormally'
    })
  }

  assertRoleTurnReply({ role: input.role, reply, providerLabel: 'Claude' })

  yield {
    type: 'completed',
    reply: reply.trim() || '',
    runtimeSessionId: sessionId
  }
}
