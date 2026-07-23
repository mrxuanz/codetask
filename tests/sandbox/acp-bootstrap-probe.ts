import { Readable, Writable } from 'node:stream'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext
} from '@agentclientprotocol/sdk'
import { buildCursorAcpCliArgs } from '../../src/server/providers/cursor/turn-plan'
import { stripElectronInheritedEnv } from '../../src/server/agent-runtime/env'
import {
  classifyCursorAcpError,
  probeCursorAgentAuth
} from '../../src/server/agent-runtime/cursor-acp/errors'
import {
  resolveCursorAgentCommand,
  resolveCursorAgentExecutable,
  spawnCursorAgent
} from '../../src/server/agent-runtime/cursor-acp/command'
import { createCursorPermissionHandler } from '../../src/server/agent-runtime/cursor-acp/permissions'

const AUTH_TIMEOUT_MS = 120_000

export interface AcpBootstrapProbeResult {
  ok: boolean
  phase: 'preflight' | 'spawn' | 'initialize' | 'authenticate' | 'done'
  message?: string
  initializeMs?: number
  authenticateMs?: number
  totalMs: number
  outerSandbox: boolean
  executable: string
  cliArgs: string[]
  envKeys: {
    HOME?: string
    CURSOR_CONFIG_DIR?: string
    CODETASK_OUTER_SANDBOX?: string
    CODETASK_RUNTIME_ROOT?: string
  }
  stderrTail?: string
}

function mergeEnv(base: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, base)
  stripElectronInheritedEnv(env)
  env.CODETASK_OUTER_SANDBOX = '1'
  return env
}

function killChild(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    return
  }
  child.kill()
}

async function acpRequestWithTimeout<T>(
  label: string,
  request: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Cursor ACP ${label} timeout (${timeoutMs / 1000}s)`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runAcpBootstrapProbe(input: {
  cwd: string
  envPatch: Record<string, string>
}): Promise<AcpBootstrapProbeResult> {
  const started = Date.now()
  const env = mergeEnv(input.envPatch)
  const command = resolveCursorAgentCommand()
  const executable = resolveCursorAgentExecutable(command, env)
  const cliArgs = buildCursorAcpCliArgs({ outerSandbox: true, cwd: input.cwd })
  const envKeys = {
    HOME: env.HOME,
    CURSOR_CONFIG_DIR: env.CURSOR_CONFIG_DIR,
    CODETASK_OUTER_SANDBOX: env.CODETASK_OUTER_SANDBOX,
    CODETASK_RUNTIME_ROOT: env.CODETASK_RUNTIME_ROOT
  }

  const authIssue = probeCursorAgentAuth(executable, env)
  if (authIssue) {
    return {
      ok: false,
      phase: 'preflight',
      message: authIssue,
      totalMs: Date.now() - started,
      outerSandbox: true,
      executable,
      cliArgs,
      envKeys
    }
  }

  const child = spawnCursorAgent(command, cliArgs, {
    cwd: input.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  if (!child.stdin || !child.stdout) {
    return {
      ok: false,
      phase: 'spawn',
      message: 'Cursor ACP stdio unavailable',
      totalMs: Date.now() - started,
      outerSandbox: true,
      executable,
      cliArgs,
      envKeys
    }
  }

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
    if (stderr.length > 8000) stderr = stderr.slice(-8000)
  })

  const approvePermission = createCursorPermissionHandler()
  const app = client({ name: 'codetask-acp-probe' }).onRequest(
    methods.client.session.requestPermission,
    async (ctx) => approvePermission({ params: { options: ctx.params.options } })
  )

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(writable, readable)

  let initializeMs: number | undefined
  let authenticateMs: number | undefined

  try {
    await app.connectWith(stream, async (ctx: ClientContext) => {
      const initStarted = Date.now()
      await acpRequestWithTimeout(
        'initialize',
        ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            _meta: { parameterizedModelPicker: true }
          },
          clientInfo: { name: 'codetask-acp-probe', version: '1.0.0' }
        }),
        AUTH_TIMEOUT_MS
      )
      initializeMs = Date.now() - initStarted

      const authStarted = Date.now()
      await acpRequestWithTimeout(
        'authenticate',
        ctx.request(methods.agent.authenticate, { methodId: 'cursor_login' }),
        AUTH_TIMEOUT_MS
      )
      authenticateMs = Date.now() - authStarted
    })

    return {
      ok: true,
      phase: 'done',
      initializeMs,
      authenticateMs,
      totalMs: Date.now() - started,
      outerSandbox: true,
      executable,
      cliArgs,
      envKeys
    }
  } catch (error) {
    const message = classifyCursorAcpError(error, {
      phase:
        authenticateMs === undefined && initializeMs !== undefined ? 'authenticate' : 'initialize',
      stderr: stderr.trim(),
      command: executable
    })
    return {
      ok: false,
      phase: initializeMs === undefined ? 'initialize' : 'authenticate',
      message,
      initializeMs,
      authenticateMs,
      totalMs: Date.now() - started,
      outerSandbox: true,
      executable,
      cliArgs,
      envKeys,
      stderrTail: stderr.trim().slice(-600) || undefined
    }
  } finally {
    killChild(child)
  }
}

async function main(): Promise<void> {
  const cwd = process.env.CODETASK_PROBE_CWD?.trim() || process.cwd()
  const envPatch: Record<string, string> = {}
  if (process.env.CODETASK_PROBE_HOME) envPatch.HOME = process.env.CODETASK_PROBE_HOME
  if (process.env.CODETASK_PROBE_CURSOR_CONFIG_DIR) {
    envPatch.CURSOR_CONFIG_DIR = process.env.CODETASK_PROBE_CURSOR_CONFIG_DIR
  }
  if (process.env.CODETASK_RUNTIME_ROOT) {
    envPatch.CODETASK_RUNTIME_ROOT = process.env.CODETASK_RUNTIME_ROOT
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CODETASK_PROBE_ENV_') && value) {
      envPatch[key.slice('CODETASK_PROBE_ENV_'.length)] = value
    }
  }

  const result = await runAcpBootstrapProbe({ cwd, envPatch })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        phase: 'spawn',
        message,
        totalMs: 0,
        outerSandbox: true,
        executable: '',
        cliArgs: [],
        envKeys: {}
      })}\n`
    )
    process.exit(1)
  })
}
