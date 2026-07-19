import { spawn, type ChildProcessWithoutNullStreams, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { AgentDriver, DriverResult, DriverStartInput } from './contract'
import { progress } from '../reports/progress'

const nodeRequire = createRequire(import.meta.url)
const crossSpawn = nodeRequire('cross-spawn') as typeof spawn

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

function stopTree(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32' && proc.pid) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    return
  }
  try {
    if (proc.pid) process.kill(-proc.pid, 'SIGTERM')
  } catch {
    proc.kill('SIGTERM')
  }
}

function resolveOpencodeBin(): string {
  return process.env.CODETASK_OPENCODE_BIN?.trim() || process.env.OPENCODE_BIN?.trim() || 'opencode'
}

function isMeaningfulSdkError(error: unknown): boolean {
  if (error == null || error === false) return false
  if (typeof error === 'object') {
    const keys = Object.keys(error as object)
    if (keys.length === 0) return false
  }
  if (typeof error === 'string' && error.trim() === '') return false
  return true
}

function createBusinessOpencodeFetch(): {
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
  const agent = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: { timeout: 60_000 }
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

/**
 * OpenCode SDK driver: one server + one session per case.
 * Injects only the case-scoped Test MCP as a remote MCP server.
 */
export class OpenCodeDriver implements AgentDriver {
  readonly name = 'opencode'
  private proc: ChildProcessWithoutNullStreams | null = null

  async start(input: DriverStartInput): Promise<DriverResult> {
    const events: DriverResult['events'] = []
    const push = (type: string, detail?: unknown): void => {
      events.push({ type, at: new Date().toISOString(), detail })
      progress(input.caseId, type, detail)
    }
    progress(input.caseId, 'driver.start', { driver: this.name, timeoutMs: input.timeoutMs })

    mkdirSync(input.agentRoot, { recursive: true })
    const skillText = input.skillPaths
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n\n---\n\n')

    const message =
      typeof input.fixture?.message === 'string'
        ? input.fixture.message
        : '请用中文简短回答：1+1等于几？'

    const caseHints: Record<string, string> = {
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
      // Prefer letting OpenCode drive MCP tools. If OpenCode auth/MCP wiring fails,
      // fall back is not allowed for G3 — surface provider errors clearly.
      const port = await pickPort()
      const config = {
        model: process.env.BUSINESS_OPENCODE_MODEL?.trim() || undefined,
        mcp: {
          'codetask-business-test': {
            type: 'remote',
            url: input.mcpUrl,
            enabled: true,
            headers: {
              Accept: 'application/json, text/event-stream',
              'X-Business-Capability': input.capabilityId
            }
          }
        },
        permission: {
          edit: 'deny',
          bash: 'deny',
          webfetch: 'deny'
        }
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: input.agentRoot,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
      }

      const bin = resolveOpencodeBin()
      this.proc = crossSpawn(bin, ['serve', `--hostname=127.0.0.1`, `--port=${port}`], {
        cwd: input.workspaceRoot,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32'
      }) as ChildProcessWithoutNullStreams

      if (!this.proc.pid) throw new Error('opencode_spawn_failed')
      push('opencode.spawned', { pid: this.proc.pid, port })

      const url = await waitForOpencodeUrl(this.proc, input.timeoutMs)
      push('opencode.ready', { url })

      const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client')
      const longFetch = createBusinessOpencodeFetch()
      const client = createOpencodeClient({
        baseUrl: url,
        directory: input.workspaceRoot,
        fetch: longFetch.fetch
      })

      try {
        const session = await client.session.create({
          title: `business-e2e-${input.caseId}`,
          directory: input.workspaceRoot
        })
        if (session.error || !session.data?.id) {
          throw new Error(`opencode_session_create_failed:${JSON.stringify(session.error ?? {})}`)
        }
        const sessionId = session.data.id
        push('opencode.session', { sessionId })

        let promptResult = await client.session.prompt({
          sessionID: sessionId,
          directory: input.workspaceRoot,
          parts: [{ type: 'text', text: prompt }]
        })
        if (isMeaningfulSdkError(promptResult.error)) {
          push('opencode.prompt_retry', { error: promptResult.error })
          await new Promise((r) => setTimeout(r, 2000))
          promptResult = await client.session.prompt({
            sessionID: sessionId,
            directory: input.workspaceRoot,
            parts: [{ type: 'text', text: prompt }]
          })
        }
        if (isMeaningfulSdkError(promptResult.error)) {
          throw new Error(
            `opencode_prompt_failed:${JSON.stringify(promptResult.error ?? promptResult)}`
          )
        }
        push('opencode.prompt_done', {
          hasData: promptResult.data !== undefined,
          rawKeys: Object.keys(promptResult as object)
        })

        const report = await waitForCapabilityReport(
          input.mcpUrl,
          input.capabilityId,
          input.timeoutMs
        )
        push('case.reported', { status: report?.status })
        if (!report || report.status !== 'completed') {
          throw new Error(`agent_no_report:${JSON.stringify(report)}`)
        }

        return { ok: true, events }
      } finally {
        longFetch.close()
      }
    } catch (error) {
      push('error', { error: String(error) })
      const text = String(error)
      let classification = 'agent_failed'
      if (text.includes('timeout') || text.includes('Timed out')) classification = 'timeout'
      else if (text.includes('ENOENT') || text.includes('not found'))
        classification = 'provider_unavailable'
      return { ok: false, classification, error: text, events }
    } finally {
      await this.cleanup()
    }
  }

  async cleanup(): Promise<void> {
    if (this.proc) {
      stopTree(this.proc)
      this.proc = null
    }
  }
}

async function waitForCapabilityReport(
  mcpUrl: string,
  capabilityId: string,
  timeoutMs: number
): Promise<{ status?: string; summary?: string } | null> {
  const statusUrl = new URL(mcpUrl)
  statusUrl.pathname = '/capability-report'
  statusUrl.searchParams.set('capabilityId', capabilityId)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl)
      const body = (await response.json()) as {
        report?: { status?: string; summary?: string } | null
      }
      if (body.report) return body.report
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return null
}

function waitForOpencodeUrl(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    let stdoutBuffer = ''
    let settled = false
    const timer = setTimeout(() => {
      stopTree(proc)
      fail(new Error(`timeout:opencode_server_start`))
    }, Math.min(timeoutMs, 60_000))

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      stdoutBuffer += text
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const clean = line.replace(/\u001b\[[0-9;]*m/g, '').trim()
        if (!clean.startsWith('opencode server listening')) continue
        const match = clean.match(/on\s+(https?:\/\/[^\s]+)/)
        if (!match?.[1]) continue
        if (settled) return
        settled = true
        clearTimeout(timer)
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
