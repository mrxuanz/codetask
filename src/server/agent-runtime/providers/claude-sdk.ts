import {
  applyTaskIdempotencyEnv,
  buildSandboxPreparedProviderEnv,
  buildProviderChildEnv
} from '../env'
import { throwSdkTurnError } from '../errors'
import { buildClaudeMcpServers } from '../mcp'
import { resolveClaudeSettingSources, resolveClaudeSystemPrompt } from './claude-policy'
import { CLI_FULL_ACCESS_BUILTINS, roleRequiresOuterSandbox } from '../roles'
import {
  CLI_READ_ONLY_BUILTINS,
  capabilityProfileIsReadOnly,
  resolveInputCapabilityProfile
} from '../capabilities'
import { createTurnError } from '../../../shared/turn-errors.ts'
import type { AgentTurnInput, AgentTurnChunk, AgentTurnOptions } from '../types'
import { advanceTextSnapshot, appendTextPiece } from '../delta-emit'
import {
  recordClaudeStreamActivity,
  assertRoleTurnReply,
  partialCompletedChunk
} from '../turn-scope'
import { abortReason, createProviderTurnScope, forwardAbortSignal } from '../provider-turn'

export async function* streamClaudeTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const outerSandbox = options?.outerSandbox ?? false
  if (!outerSandbox && roleRequiresOuterSandbox(input.role)) {
    throw createTurnError('sandbox.required', {
      detail: 'Claude bypassPermissions requires OS outer sandbox'
    })
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const capabilityProfile = resolveInputCapabilityProfile(input)
  const readOnly = capabilityProfileIsReadOnly(capabilityProfile)
  const builtins = readOnly ? [...CLI_READ_ONLY_BUILTINS] : [...CLI_FULL_ACCESS_BUILTINS]
  let reply = ''
  let thinking = ''

  const userMcpServers = input.userMcpServers ?? {}
  // Always build the CodeTask MCP map so we can pin it with strictMcpConfig when
  // host settingSources are loaded (overrides ~/.claude settings MCP).
  const mcpServers = buildClaudeMcpServers(input.mcpUrl, userMcpServers)
  const mcpServerNames = Object.keys(mcpServers)
  const mcpToolAllowlist = mcpServerNames.map((name) => `mcp__${name}__*`)
  const allowedTools = mcpToolAllowlist.length > 0 ? [...builtins, ...mcpToolAllowlist] : builtins

  const turnScope = createProviderTurnScope(input.role, options, {})
  const turnAbort = new AbortController()
  if (turnScope.signal.aborted) {
    throw abortReason(turnScope.signal)
  }
  const turnAbortListener = forwardAbortSignal(turnScope.signal, turnAbort)

  const providerEnv = outerSandbox
    ? buildSandboxPreparedProviderEnv()
    : buildProviderChildEnv(input.runtimeRoot, { preserveHostIdentity: true })
  applyTaskIdempotencyEnv(providerEnv, input.idempotencyKey)

  const settingSources = resolveClaudeSettingSources(outerSandbox, capabilityProfile)
  // When host settings load, pin MCP to CodeTask's map (possibly empty) so user
  // ~/.claude MCP does not leak in. Outer-sandbox turns already use empty
  // settingSources and only need MCP when CodeTask injected servers.
  const pinMcpConfig = settingSources.length > 0 || mcpServerNames.length > 0

  const stream = query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      systemPrompt: resolveClaudeSystemPrompt(input.systemPrompt),
      settingSources,
      // Read-only: disable filesystem skills/plugins even though user settings load.
      ...(readOnly ? { skills: [], plugins: [] } : {}),
      tools: builtins,
      allowedTools,
      disallowedTools: readOnly
        ? ['AskUserQuestion', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent']
        : ['AskUserQuestion'],
      permissionMode: 'bypassPermissions',
      persistSession: true,
      abortController: turnAbort,
      env: providerEnv,
      // Keep Claude's inner sandbox off; OS outer sandbox (when used) is the boundary.
      sandbox: { enabled: false },
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.runtimeSessionId ? { resume: input.runtimeSessionId } : {}),
      ...(pinMcpConfig
        ? {
            mcpServers: mcpServers as NonNullable<
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
