import { spawn, type ChildProcessWithoutNullStreams, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import {
  initializeProcessHostEnvironment,
  processHostEnvironmentSource
} from '../../../src/server/host-environment'
import { DefaultProviderInstallationResolver } from '../../../src/server/providers/installation'
import type { CommandInvocation } from '../../../src/shared/providers/installation'
import type { OpencodeBudgets } from '../config/timeouts'
import { TIMEOUTS } from '../config/timeouts'
import { extractPromptFailure, isMeaningfulSdkError, serializePromptError } from './opencode-errors'

const nodeRequire = createRequire(import.meta.url)
const crossSpawn = nodeRequire('cross-spawn') as typeof spawn

export type IsolatedPromptResult = {
  promptResult: unknown
  url: string
  sessionId: string
  events: Array<{ type: string; detail?: unknown }>
}

export async function runIsolatedOpencodePrompt(input: {
  workspaceRoot: string
  mcpUrl: string
  capabilityId: string
  prompt: string
  budgets: OpencodeBudgets
  label?: string
  onEvent?: (type: string, detail?: unknown) => void
  /** Runs after a successful prompt while the OpenCode server is still alive. */
  afterSuccessfulPrompt?: (ctx: {
    promptResult: unknown
    url: string
    sessionId: string
  }) => Promise<void>
}): Promise<IsolatedPromptResult> {
  const events: IsolatedPromptResult['events'] = []
  const push = (type: string, detail?: unknown): void => {
    events.push({ type, detail })
    input.onEvent?.(type, detail)
  }

  const port = await pickPort()
  await initializeProcessHostEnvironment()
  const hostEnv = processHostEnvironmentSource.snapshot()
  const config = buildOpencodeHarnessConfig(
    input.mcpUrl,
    input.capabilityId,
    hostEnv.OPENCODE_CONFIG_CONTENT
  )
  const env: NodeJS.ProcessEnv = { ...hostEnv }
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'opencode_config_content') delete env[key]
    }
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)

  const invocation = resolveOpencodeInvocation(hostEnv)
  const proc = crossSpawn(
    invocation.executable,
    [...invocation.prefixArgs, 'serve', `--hostname=127.0.0.1`, `--port=${port}`],
    {
      cwd: input.workspaceRoot,
      env,
      windowsHide: true,
      // The case worker is already a dedicated process group. Keeping OpenCode
      // inside it lets supervisor cleanup terminate the complete case tree.
      detached: false
    }
  ) as ChildProcessWithoutNullStreams

  if (!proc.pid) throw new Error('opencode_spawn_failed')
  push('opencode.spawned', { pid: proc.pid, port, label: input.label ?? null })

  const longFetch = createBusinessOpencodeFetch(input.budgets.promptMs)
  try {
    const url = await waitForOpencodeUrl(proc, input.budgets.startupMs)
    push('opencode.ready', { url })

    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client')
    const client = createOpencodeClient({
      baseUrl: url,
      directory: input.workspaceRoot,
      fetch: longFetch.fetch
    })

    const session = await withTimeout(
      client.session.create({
        title: `business-e2e-${input.label ?? 'case'}`,
        directory: input.workspaceRoot
      }),
      input.budgets.promptMs,
      'timeout:opencode_session_create'
    )
    if (session.error || !session.data?.id) {
      throw new Error(`opencode_session_create_failed:${JSON.stringify(session.error ?? {})}`)
    }
    const sessionId = session.data.id
    push('opencode.session', { sessionId })

    const promptResult = await withTimeout(
      client.session.prompt({
        sessionID: sessionId,
        directory: input.workspaceRoot,
        parts: [{ type: 'text', text: input.prompt }]
      }),
      input.budgets.promptMs,
      'timeout:opencode_prompt'
    )
    const failure = extractPromptFailure(promptResult)
    if (failure) {
      // Never retry the whole prompt: business prompts may already have made
      // non-idempotent MCP calls before a transport/provider failure surfaced.
      throw new Error(`opencode_prompt_failed:${serializePromptError(failure)}`)
    }
    push('opencode.prompt_done', {
      hasData: (promptResult as { data?: unknown } | null)?.data !== undefined,
      rawKeys:
        promptResult != null && typeof promptResult === 'object'
          ? Object.keys(promptResult as object)
          : []
    })

    if (input.afterSuccessfulPrompt) {
      await input.afterSuccessfulPrompt({ promptResult, url, sessionId })
    }

    return { promptResult, url, sessionId, events }
  } finally {
    longFetch.close()
    await stopTree(proc)
  }
}

export function buildOpencodeHarnessConfig(
  mcpUrl: string,
  capabilityId: string,
  inheritedConfigContent?: string
): Record<string, unknown> {
  let inherited: Record<string, unknown> = {}
  if (inheritedConfigContent?.trim()) {
    const parsed = JSON.parse(inheritedConfigContent) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('opencode_host_config_invalid:expected_object')
    }
    inherited = parsed as Record<string, unknown>
  }
  const inheritedMcp =
    inherited.mcp && typeof inherited.mcp === 'object' && !Array.isArray(inherited.mcp)
      ? (inherited.mcp as Record<string, unknown>)
      : {}
  const inheritedPermission =
    inherited.permission &&
    typeof inherited.permission === 'object' &&
    !Array.isArray(inherited.permission)
      ? (inherited.permission as Record<string, unknown>)
      : {}

  return {
    ...inherited,
    mcp: {
      ...inheritedMcp,
      'codetask-business-test': {
        type: 'remote',
        url: mcpUrl,
        enabled: true,
        headers: {
          Accept: 'application/json, text/event-stream',
          'X-Business-Capability': capabilityId
        }
      }
    },
    permission: {
      ...inheritedPermission,
      edit: 'deny',
      bash: 'deny',
      webfetch: 'deny'
    }
  }
}

function resolveOpencodeInvocation(
  hostEnv: Readonly<Record<string, string | undefined>>
): CommandInvocation {
  const installation = new DefaultProviderInstallationResolver().resolve('opencode', {
    settings: {
      enabled: true,
      executable: { mode: 'auto' },
      approveMcps: false
    },
    hostEnv,
    platform: process.platform
  })
  if (!installation) throw new Error('opencode_provider_unavailable:not_installed')
  return installation.invocation
}

export async function waitForCapabilityReport(
  mcpUrl: string,
  capabilityId: string,
  timeoutMs: number,
  options?: { signal?: AbortSignal; pollMs?: number; noTimeout?: boolean }
): Promise<{ status?: string; summary?: string } | null> {
  const statusUrl = new URL(mcpUrl)
  statusUrl.pathname = '/capability-report'
  statusUrl.searchParams.set('capabilityId', capabilityId)
  const pollMs = options?.pollMs ?? 1_000
  const noTimeout =
    options?.noTimeout === true ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs >= Number.MAX_SAFE_INTEGER
  // timeoutMs <= 0 without noTimeout → immediate miss (never infinite)
  const deadline = noTimeout
    ? null
    : Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0)
  let lastError: unknown

  for (;;) {
    if (options?.signal?.aborted) throw new Error('timeout:capability_report_aborted')
    try {
      const response = await fetch(statusUrl)
      if (!response.ok) throw new Error(`http_${response.status}`)
      const body = (await response.json()) as {
        report?: { status?: string; summary?: string } | null
      }
      if (body.report) return body.report
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    if (deadline !== null && Date.now() >= deadline) {
      if (lastError) throw new Error(`mcp_capability_report_unreachable:${String(lastError)}`)
      return null
    }
    await sleep(pollMs)
  }
}

function createBusinessOpencodeFetch(promptMs: number): {
  fetch: typeof globalThis.fetch
  close(): void
} {
  const { Agent } = nodeRequire('undici') as {
    Agent: new (options?: {
      headersTimeout?: number
      bodyTimeout?: number
      connect?: { timeout?: number }
    }) => { close(): Promise<void> | void }
  }
  const bounded =
    Number.isFinite(promptMs) && promptMs > 0 && promptMs < Number.MAX_SAFE_INTEGER ? promptMs : 0
  const agent = new Agent({
    // 0 = undici unlimited; only used for explicit --no-timeout.
    headersTimeout: bounded,
    bodyTimeout: bounded,
    connect: { timeout: Math.min(60_000, bounded || 60_000) }
  })
  const fetchWithAgent: typeof globalThis.fetch = ((input, init) =>
    globalThis.fetch(input, {
      ...(init ?? {}),
      dispatcher: agent
    } as RequestInit)) as typeof globalThis.fetch
  return {
    fetch: fetchWithAgent,
    close() {
      try {
        void agent.close()
      } catch {
        /* ignore */
      }
    }
  }
}

function waitForOpencodeUrl(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    let stdoutBuffer = ''
    let settled = false
    const startupMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs < Number.MAX_SAFE_INTEGER
        ? Math.min(timeoutMs, TIMEOUTS.agentStartupMs)
        : timeoutMs >= Number.MAX_SAFE_INTEGER
          ? Number.MAX_SAFE_INTEGER
          : TIMEOUTS.agentStartupMs
    const timer =
      startupMs >= Number.MAX_SAFE_INTEGER
        ? null
        : setTimeout(() => {
            void stopTree(proc)
            fail(new Error(`timeout:opencode_server_start`))
          }, startupMs)

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      stdoutBuffer += text
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu')
        const clean = line.replace(ansiColor, '').trim()
        if (!clean.startsWith('opencode server listening')) continue
        const match = clean.match(/on\s+(https?:\/\/[^\s]+)/)
        if (!match?.[1]) continue
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(match[1])
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    proc.on('exit', (code) => {
      fail(new Error(`opencode_exited:${code}:${output.slice(-1500)}`))
    })
    proc.on('error', (error) => fail(error))
  })
}

function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('opencode_port_alloc_failed'))
      })
    })
  })
}

async function stopTree(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32' && proc.pid) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    return
  }
  proc.kill('SIGTERM')
  if (await waitForExit(proc, 2_000)) return
  proc.kill('SIGKILL')
  await waitForExit(proc, 1_000)
}

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.off('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    proc.once('exit', onExit)
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0 || ms >= Number.MAX_SAFE_INTEGER) return promise
  let timer: NodeJS.Timeout | undefined
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (timer) clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Re-export for callers that previously used local helper
export { isMeaningfulSdkError }
