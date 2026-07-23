import type { Event, Part, TextPart } from '@opencode-ai/sdk/v2'
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client'
import { spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { createServer } from 'net'
import { buildOpenCodeServerPlan } from '../../providers/opencode/server-plan'
import { spawnProviderInvocation } from '../../providers/spawn'
import { throwSdkTurnError } from '../errors'
import {
  createTurnError,
  isTurnError,
  TURN_CANCELLED,
  type TurnError
} from '../../../shared/turn-errors.ts'
import type { AgentTurnInput, AgentTurnChunk, AgentTurnOptions } from '../types'
import { advanceTextSnapshot, appendTextPiece } from '../delta-emit'
import { extractLooseReasoningText } from '../reasoning-text'
import {
  assertRoleTurnReply,
  partialCompletedChunk,
  recordOpencodeToolPartActivity
} from '../turn-scope'
import { abortReason, createProviderTurnScope } from '../provider-turn'
import {
  buildOpencodeAutoQuestionAnswers,
  parseOpencodeQuestions,
  resolveOpencodeToolsConfig,
  type OpencodeQuestionDto
} from './opencode-config'
import { resolveInputCapabilityProfile } from '../capabilities'
import {
  createOpencodeLongTurnFetch,
  isTransientOpencodeTransportDetail
} from './opencode-transport'

export { isTransientOpencodeTransportDetail } from './opencode-transport'

interface OpencodeServerHandle {
  url: string
  close(): void
  processExit: Promise<never>
}

/**
 * Auto-answer OpenCode `question` so the turn continues (do not reject).
 * See `./opencode-config.ts` for issue/PR notes and policy.
 */
async function autoReplyOpencodeQuestion(
  client: OpencodeClient,
  cwd: string,
  requestID: string,
  questions: ReadonlyArray<OpencodeQuestionDto>
): Promise<void> {
  try {
    await client.question.reply({
      requestID,
      directory: cwd,
      answers: buildOpencodeAutoQuestionAnswers(questions)
    })
  } catch {
    // best-effort — turn may already be aborted
  }
}

async function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(
            createTurnError('provider.opencode.server_exited', {
              detail: 'Unable to allocate OpenCode server port'
            })
          )
        }
      })
    })
  })
}

function formatOpencodeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const withCause = error as { message?: unknown; cause?: unknown }
    const message = typeof withCause.message === 'string' ? withCause.message : ''
    const cause =
      withCause.cause && typeof withCause.cause === 'object' && 'message' in withCause.cause
        ? String((withCause.cause as { message: unknown }).message)
        : withCause.cause
          ? String(withCause.cause)
          : ''
    if (message && cause) return `${message}: ${cause}`
    if (message) return message
    if (cause) return cause
  }
  return 'OpenCode request failed'
}

function createOpencodeSessionTurnError(detail: string): TurnError {
  if (isTransientOpencodeTransportDetail(detail)) {
    return createTurnError('provider.opencode.stream_disconnected', { detail })
  }
  return createTurnError('provider.opencode.session_error', { detail })
}

function extractPartsText(parts: Part[] | undefined): string {
  if (!parts?.length) return ''
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function appendTail(current: string, chunk: string, maxLength = 12_000): string {
  const next = current + chunk
  return next.length > maxLength ? next.slice(next.length - maxLength) : next
}

function stopProcessTree(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32' && proc.pid) {
    const result = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    if (!result.error && result.status === 0) return
  }
  proc.kill()
}

function formatServerStartFailure(
  message: string,
  output: string,
  env: Record<string, string>
): TurnError {
  const details = stripAnsi(output).trim()
  const context = [
    env.HOME ? `HOME=${env.HOME}` : null,
    env.USERPROFILE ? `USERPROFILE=${env.USERPROFILE}` : null,
    env.XDG_DATA_HOME ? `XDG_DATA_HOME=${env.XDG_DATA_HOME}` : null
  ]
    .filter(Boolean)
    .join(' ')
  const detail = [
    context ? `OpenCode env: ${context}` : null,
    details ? `OpenCode output:\n${details}` : null
  ]
    .filter(Boolean)
    .join('\n')
  if (message.includes('超时') || message.includes('timeout') || message.includes('timed out')) {
    return createTurnError('provider.opencode.server_timeout', { detail })
  }
  if (message.includes('exited') || message.includes('exit')) {
    return createTurnError('provider.opencode.server_exited', { detail })
  }
  return createTurnError('provider.opencode.server_exited', {
    detail: `${message}\n${detail}`.trim()
  })
}

async function startOpencodeServer(options: {
  hostname: string
  port: number
  cwd: string
  config: import('@opencode-ai/sdk/v2').Config
  env: Record<string, string>
  executable: string
  prefixArgs: readonly string[]
  signal?: AbortSignal | undefined
  serveArgs: readonly string[]
  timeoutMs?: number | undefined
}): Promise<OpencodeServerHandle> {
  const env = {
    ...options.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config)
  }
  // Pin OS cwd to the project workspace so a ignored/mismatched `directory`
  // query cannot fall back to the CodeTask process cwd (program directory).
  const proc = spawnProviderInvocation(
    { executable: options.executable, prefixArgs: options.prefixArgs },
    options.serveArgs,
    {
      cwd: options.cwd,
      env,
      stdio: 'pipe'
    }
  ) as ChildProcessWithoutNullStreams

  let clearAbort = (): void => {}
  let output = ''
  let stdoutBuffer = ''
  let settled = false

  const url = await new Promise<string>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearAbort()
      reject(error)
    }

    const timeout = setTimeout(() => {
      stopProcessTree(proc)
      fail(formatServerStartFailure('Timed out waiting for OpenCode server to start', output, env))
    }, options.timeoutMs ?? 20_000)

    const abort = (): void => {
      stopProcessTree(proc)
      fail(TURN_CANCELLED)
    }
    clearAbort = (): void => {
      options.signal?.removeEventListener('abort', abort)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output = appendTail(output, text)
      stdoutBuffer += text
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const clean = stripAnsi(line).trim()
        if (!clean.startsWith('opencode server listening')) continue
        const match = clean.match(/on\s+(https?:\/\/[^\s]+)/)
        const matchedUrl = match?.[1]
        if (!matchedUrl) {
          fail(
            formatServerStartFailure(
              `Unable to parse OpenCode server address: ${clean}`,
              output,
              env
            )
          )
          return
        }
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearAbort()
        resolve(matchedUrl)
        return
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      output = appendTail(output, chunk.toString())
    })

    proc.on('exit', (code) => {
      fail(formatServerStartFailure(`OpenCode server exited with code ${code}`, output, env))
    })

    proc.on('error', (error) => {
      fail(formatServerStartFailure(error.message, output, env))
    })
  })

  const processExit = new Promise<never>((_, reject) => {
    proc.on('exit', (code) => {
      reject(formatServerStartFailure(`OpenCode server exited with code ${code}`, output, env))
    })
    proc.on('error', (error) => {
      reject(formatServerStartFailure(error.message, output, env))
    })
  })

  return {
    url,
    close() {
      clearAbort()
      stopProcessTree(proc)
    },
    processExit
  }
}

function isSessionEvent(event: Event, sessionId: string): boolean {
  const props = event.properties as { sessionID?: string } | undefined
  return !props?.sessionID || props.sessionID === sessionId
}

function isTerminalAssistantFinish(finish: string | undefined): boolean {
  return Boolean(finish && finish !== 'tool-calls')
}

async function loadLatestAssistantText(
  client: OpencodeClient,
  cwd: string,
  sessionId: string
): Promise<string> {
  const messages = await client.session.messages({
    sessionID: sessionId,
    directory: cwd
  })
  if (messages.error || !Array.isArray(messages.data)) return ''

  for (const item of [...messages.data].reverse()) {
    const info = item.info as { role?: string } | undefined
    if (info?.role !== 'assistant') continue
    const text = extractPartsText(item.parts)
    if (text) return text
  }

  return ''
}

async function ensureOpencodeSession(
  client: OpencodeClient,
  cwd: string,
  runtimeSessionId?: string | null
): Promise<string> {
  if (runtimeSessionId) {
    const existing = await client.session.get({
      sessionID: runtimeSessionId,
      directory: cwd
    })
    if (!existing.error && existing.data?.id) {
      return existing.data.id
    }
  }

  const created = await client.session.create({
    directory: cwd
  })
  if (created.error || !created.data?.id) {
    throw createOpencodeSessionTurnError(
      formatOpencodeError(created.error ?? 'OpenCode session creation failed')
    )
  }
  return created.data.id
}

export async function* streamOpencodeTurn(
  input: AgentTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client')
  const plan = buildOpenCodeServerPlan(input, { outerSandbox: options?.outerSandbox })
  const capabilityProfile = resolveInputCapabilityProfile(input)
  const port = await pickEphemeralPort()

  const server = await startOpencodeServer({
    hostname: plan.hostname,
    port,
    cwd: plan.cwd,
    config: plan.config,
    env: plan.env,
    executable: plan.executable,
    prefixArgs: plan.prefixArgs,
    serveArgs: plan.buildServeArgs(port),
    signal: options?.signal
  })

  // Node undici's default 300s bodyTimeout aborts long session.prompt waits;
  // OpenCode SDK's req.timeout=false only works on Bun. Use an Agent with
  // timeouts disabled so planner/task turns can run past five minutes.
  const longTurnFetch = createOpencodeLongTurnFetch()
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: input.cwd,
    fetch: longTurnFetch.fetch
  })

  const turnScope = createProviderTurnScope(input.role, options, {
    processExit: server.processExit
  })
  const eventAbort = new AbortController()
  const promptAbort = new AbortController()
  const abortTurn = (): void => {
    const reason = abortReason(turnScope.signal)
    eventAbort.abort(reason)
    promptAbort.abort(reason)
  }
  turnScope.signal.addEventListener('abort', abortTurn, { once: true })
  if (turnScope.signal.aborted) abortTurn()

  let sessionId = input.runtimeSessionId ?? ''
  let reply = ''
  let thinking = ''

  try {
    sessionId = await ensureOpencodeSession(client, input.cwd, input.runtimeSessionId)
    reply = ''
    thinking = ''

    const subscription = await client.event.subscribe(
      {
        directory: input.cwd
      },
      {
        signal: eventAbort.signal
      }
    )
    const eventStream = subscription.stream

    const promptPromise = client.session.prompt(
      {
        sessionID: sessionId,
        directory: input.cwd,
        // Per-prompt tools disable (session permission path). Still may be
        // ignored on older OpenCode builds — auto-reply remains the safety net.
        tools: resolveOpencodeToolsConfig(capabilityProfile),
        parts: [{ type: 'text', text: input.prompt }],
        ...(input.systemPrompt !== undefined ? { system: input.systemPrompt } : {})
      },
      {
        signal: promptAbort.signal
      }
    )
    void promptPromise.catch(() => undefined)

    let idle = false
    const eventIterator = eventStream[Symbol.asyncIterator]()
    let promptResult: Awaited<typeof promptPromise> | undefined
    const assistantMessageIds = new Set<string>()
    const textPartIds = new Set<string>()
    const reasoningPartIds = new Set<string>()
    const openToolIds = new Set<string>()

    const emitReasoningDelta = function* (nextThinking: string): Generator<AgentTurnChunk> {
      if (!nextThinking || nextThinking === thinking) return
      const advanced = advanceTextSnapshot(thinking, nextThinking)
      thinking = advanced.text
      turnScope.recordProgress('thinking_delta')
      if (advanced.delta) yield { type: 'thinking_delta', content: advanced.delta }
    }

    try {
      while (promptResult === undefined) {
        const winner = await turnScope.race(
          Promise.race([
            eventIterator.next().then((next) => ({ kind: 'event' as const, next })),
            promptPromise.then((result) => ({ kind: 'prompt' as const, result }))
          ])
        )

        if (winner.kind === 'prompt') {
          promptResult = winner.result
          break
        }

        if (winner.next.done) break

        const event = winner.next.value as Event
        // Only count this session — other sessions on the shared event bus
        // must not keep the stall watchdog artificially alive.
        if (!isSessionEvent(event, sessionId)) continue
        turnScope.recordProgress('provider_event')

        if (event.type === 'question.asked' || event.type === 'question.v2.asked') {
          const props = event.properties as {
            id?: string
            requestID?: string
            questions?: Array<{
              options?: Array<{ label?: string }>
              multiple?: boolean
              custom?: boolean
            }>
          }
          const requestID = props.id ?? props.requestID
          if (requestID) {
            void autoReplyOpencodeQuestion(
              client,
              input.cwd,
              requestID,
              parseOpencodeQuestions(props.questions)
            )
          }
          turnScope.recordProgress('tool_updated')
          continue
        }

        if (event.type === 'message.part.updated') {
          const props = event.properties as {
            part?: {
              id?: string
              callID?: string
              messageID?: string
              type?: string
              text?: string
              tool?: string
              state?: {
                status?: string
                title?: string
                input?: { [key: string]: unknown }
              }
            }
          }
          const part = props.part
          if (part?.type === 'tool') {
            recordOpencodeToolPartActivity(part, turnScope, openToolIds)
            continue
          }
          const reasoningText = extractLooseReasoningText(part)
          if (reasoningText && part?.messageID && assistantMessageIds.has(part.messageID)) {
            if (part.id) reasoningPartIds.add(part.id)
            yield* emitReasoningDelta(reasoningText)
            continue
          }
          if (part?.type === 'text' && part.messageID && assistantMessageIds.has(part.messageID)) {
            if (part.id) textPartIds.add(part.id)
            if (typeof part.text === 'string' && part.text !== reply) {
              const advanced = advanceTextSnapshot(reply, part.text)
              reply = advanced.text
              turnScope.recordProgress('text_delta')
              if (advanced.delta) yield { type: 'delta', content: advanced.delta }
            }
          }
          continue
        }

        if (event.type === 'message.part.delta') {
          const props = event.properties as {
            partID?: string
            field?: string
            delta?: string
          }
          if (
            props.field === 'text' &&
            props.delta &&
            props.partID &&
            textPartIds.has(props.partID)
          ) {
            const advanced = appendTextPiece(reply, props.delta)
            reply = advanced.text
            turnScope.recordProgress('text_delta')
            if (advanced.delta) yield { type: 'delta', content: advanced.delta }
          } else if (
            (props.field === 'text' || props.field === 'reasoning' || props.field === 'thinking') &&
            props.delta &&
            props.partID &&
            reasoningPartIds.has(props.partID)
          ) {
            const advanced = appendTextPiece(thinking, props.delta)
            thinking = advanced.text
            turnScope.recordProgress('thinking_delta')
            if (advanced.delta) yield { type: 'thinking_delta', content: advanced.delta }
          }
          continue
        }

        if (event.type === 'message.updated') {
          const props = event.properties as {
            info?: { id?: string; role?: string; finish?: string }
          }
          if (props.info?.role === 'assistant' && props.info.id) {
            assistantMessageIds.add(props.info.id)
          }
          if (props.info?.role === 'assistant' && isTerminalAssistantFinish(props.info.finish)) {
            turnScope.recordProgress('tool_completed')
            break
          }
          continue
        }

        if (event.type === 'session.next.text.delta') {
          const props = event.properties as { delta?: string }
          if (props.delta) {
            const advanced = appendTextPiece(reply, props.delta)
            reply = advanced.text
            turnScope.recordProgress('text_delta')
            if (advanced.delta) yield { type: 'delta', content: advanced.delta }
          }
          continue
        }

        if (event.type === 'session.next.text.ended') {
          const props = event.properties as { text?: string }
          if (props.text) {
            const advanced = advanceTextSnapshot(reply, props.text)
            reply = advanced.text
            turnScope.recordProgress('text_delta')
            if (advanced.delta) yield { type: 'delta', content: advanced.delta }
          }
          continue
        }

        if (event.type === 'session.error') {
          const props = event.properties as { error?: { message?: string } }
          throw createOpencodeSessionTurnError(props.error?.message ?? 'OpenCode session error')
        }

        if (event.type === 'session.idle') {
          idle = true
          turnScope.recordProgress('heartbeat')
          break
        }

        if (event.type === 'session.status') {
          const props = event.properties as { status?: { type?: string } }
          if (props.status?.type === 'idle') {
            idle = true
            turnScope.recordProgress('heartbeat')
            break
          }
        }
      }
    } finally {
      eventAbort.abort()
      await Promise.race([
        eventIterator.return?.() ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 500))
      ])
    }

    if (promptResult === undefined) {
      promptResult = await turnScope.race(promptPromise)
    }
    if (promptResult?.error) {
      throw createOpencodeSessionTurnError(formatOpencodeError(promptResult.error))
    }

    if (!reply.trim()) {
      reply = extractPartsText(promptResult?.data?.parts)
      if (!reply && idle) {
        reply = await loadLatestAssistantText(client, input.cwd, sessionId)
      }
      if (reply) {
        turnScope.recordProgress('text_delta')
        const advanced = advanceTextSnapshot('', reply)
        reply = advanced.text
        if (advanced.delta) yield { type: 'delta', content: advanced.delta }
      }
    }

    assertRoleTurnReply({ role: input.role, reply, providerLabel: 'OpenCode' })

    yield {
      type: 'completed',
      reply: reply.trim() || '',
      runtimeSessionId: sessionId
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
    throwOpencodeError(error)
  } finally {
    turnScope.dispose()
    turnScope.signal.removeEventListener('abort', abortTurn)
    abortTurn()
    longTurnFetch.close()
    server.close()
  }
}

function throwOpencodeError(error: unknown): never {
  if (error instanceof Error && error.name === 'AbortError') {
    throw TURN_CANCELLED
  }
  if (isTurnError(error)) throw error
  const detail = formatOpencodeError(error)
  if (isTransientOpencodeTransportDetail(detail)) {
    throw createOpencodeSessionTurnError(detail)
  }
  throwSdkTurnError(error)
}
