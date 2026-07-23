import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runAcpBootstrapProbe, type AcpBootstrapProbeResult } from './acp-bootstrap-probe'
import { getProviderDriverForTest, prepareProviderAuthForTest } from '../helpers/provider-runtime'
import { buildSandboxEnv } from '../../src/server/sandbox/env'
import {
  applyProviderReadRoots,
  applyProviderWriteRoots,
  collectPolicyReadRoots,
  collectPolicyWriteRoots,
  policyForRole
} from '../../src/server/sandbox/policy'
import { resolveProviderReadRoots } from '../../src/server/sandbox/provider-read-roots'
import { probeCursorAgentAuth } from '../../src/server/agent-runtime/cursor-acp/errors'
import {
  resolveCursorAgentCommand,
  resolveCursorAgentExecutable
} from '../../src/server/agent-runtime/cursor-acp/command'

const require = createRequire(import.meta.url)

const args = process.argv.slice(2)

function readArg(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const skipSandbox = args.includes('--skip-sandbox')
const workspaceArg = readArg('--workspace')

function log(section: string, message: string, extra?: unknown): void {
  const prefix = `[cursor-acp-sandbox:${section}]`
  if (extra !== undefined) console.log(prefix, message, extra)
  else console.log(prefix, message)
}

function resolveSandboxRunner(): { command: string; args: string[]; extraReadRoots: string[] } {
  const probeScript = join(process.cwd(), 'tests/sandbox/acp-bootstrap-probe.ts')
  const tsxCli = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
  const electronBin = join(process.cwd(), 'node_modules/electron/dist/electron')
  const extraReadRoots: string[] = []

  const systemCandidates = ['/usr/bin/node', '/usr/local/bin/node']
  for (const candidate of systemCandidates) {
    if (existsSync(candidate)) {
      extraReadRoots.push(dirname(candidate))
      if (existsSync(tsxCli)) {
        return { command: candidate, args: [tsxCli, probeScript], extraReadRoots }
      }
      return { command: candidate, args: ['--import', 'tsx', probeScript], extraReadRoots }
    }
  }

  if (existsSync(electronBin) && existsSync(tsxCli)) {
    extraReadRoots.push(dirname(electronBin))
    return {
      command: electronBin,
      args: [tsxCli, probeScript],
      extraReadRoots
    }
  }

  const fromPath = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
  if (fromPath) {
    try {
      const resolved = realpathSync(fromPath)
      extraReadRoots.push(dirname(resolved))
      return {
        command: resolved,
        args: existsSync(tsxCli) ? [tsxCli, probeScript] : ['--import', 'tsx', probeScript],
        extraReadRoots
      }
    } catch {
      extraReadRoots.push(dirname(fromPath))
      return {
        command: fromPath,
        args: existsSync(tsxCli) ? [tsxCli, probeScript] : ['--import', 'tsx', probeScript],
        extraReadRoots
      }
    }
  }

  throw new Error('No runnable Node/Electron found for sandbox ACP probe')
}

function wirePolicy(policy: ReturnType<typeof policyForRole>): string {
  return JSON.stringify({
    version: policy.version,
    role: policy.role,
    cwd: policy.cwd,
    runtime_root: policy.runtimeRoot,
    filesystem: {
      default_access: policy.filesystem.defaultAccess,
      allowed_read_roots: policy.filesystem.allowedReadRoots,
      allowed_write_roots: policy.filesystem.allowedWriteRoots,
      protected_names: policy.filesystem.protectedNames,
      allow_system_runtime: policy.filesystem.allowSystemRuntime
    },
    network: {
      mode: policy.network.mode,
      allow_loopback: policy.network.allowLoopback,
      allow_unix_sockets: policy.network.allowUnixSockets
    },
    process: {
      isolate_from_host: policy.process.isolateFromHost,
      allow_own_descendant_signals: policy.process.allowOwnDescendantSignals,
      deny_ptrace: policy.process.denyPtrace
    }
  })
}

function loadNative(): {
  launchSandboxedWorker: (input: Record<string, unknown>) => {
    writeStdin: (buf: Buffer) => void
    endStdin: () => void
    waitForAttestation: (ms: number) => boolean
    readStdoutChunk: (n: number) => Buffer
    readStderrChunk: (n: number) => Buffer
    pollExit: () => number | null
    kill: () => void
    close: () => void
    evidence: { backend: string; active: boolean }
  }
  preflight: () => void
} {
  const addonPath = join(process.cwd(), 'native/codeteam-sandbox')
  if (!existsSync(join(addonPath, 'index.js'))) {
    throw new Error('native addon missing — run npm run build:sandbox')
  }
  return require(addonPath)
}

interface CliPreflightResult {
  ok: boolean
  command: string
  executable: string
  stdout: string
  stderr: string
  exitCode: number | null
  authProbe: string | null
  elapsedMs: number
}

function runCliPreflight(
  label: string,
  envPatch: Record<string, string>,
  cwd: string
): CliPreflightResult {
  const started = Date.now()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, envPatch)
  env.CODETASK_OUTER_SANDBOX = '1'

  const command = resolveCursorAgentCommand()
  const executable = resolveCursorAgentExecutable(command, env)
  const authProbe = probeCursorAgentAuth(executable, env)

  const status = spawnSync(command, ['status'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true
  })

  const result: CliPreflightResult = {
    ok: status.status === 0 && !authProbe,
    command,
    executable,
    stdout: (status.stdout ?? '').trim().slice(0, 500),
    stderr: (status.stderr ?? '').trim().slice(0, 500),
    exitCode: status.status,
    authProbe,
    elapsedMs: Date.now() - started
  }

  log(label, 'agent status', {
    ok: result.ok,
    exitCode: result.exitCode,
    authProbe: result.authProbe,
    stdoutPreview: result.stdout.slice(0, 120)
  })

  return result
}

async function runSandboxProbe(input: {
  label: string
  policy: ReturnType<typeof policyForRole>
  envRecord: Record<string, string>
  cwd: string
  runtimeRoot: string
  envPatch: Record<string, string>
}): Promise<AcpBootstrapProbeResult & { exitCode: number | null; sandboxBackend?: string }> {
  const native = loadNative()
  native.preflight()

  const runner = resolveSandboxRunner()

  const envEntries = Object.entries({
    ...input.envRecord,
    CODETASK_PROBE_CWD: input.cwd,
    CODETASK_RUNTIME_ROOT: input.runtimeRoot,
    CODETASK_PROBE_HOME: input.envPatch.HOME ?? input.runtimeRoot,
    CODETASK_PROBE_CURSOR_CONFIG_DIR: input.envPatch.CURSOR_CONFIG_DIR ?? ''
  })
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => ({ key, value }))

  log(input.label, 'launch sandbox probe', {
    command: runner.command,
    args: runner.args,
    backend: 'pending',
    readRoots: input.policy.filesystem.allowedReadRoots.length
  })

  const handle = native.launchSandboxedWorker({
    policyJson: wirePolicy(input.policy),
    command: runner.command,
    args: runner.args,
    cwd: input.cwd,
    env: envEntries,
    readRoots: collectPolicyReadRoots(input.policy),
    writeRoots: collectPolicyWriteRoots(input.policy)
  })

  handle.endStdin()

  if (!handle.waitForAttestation(30_000)) {
    handle.kill()
    handle.close()
    throw new Error(`${input.label}: sandbox attestation timeout`)
  }

  const backend = handle.evidence.backend
  let stdout = ''
  let stderr = ''
  const deadline = Date.now() + 180_000

  while (Date.now() < deadline) {
    const out = handle.readStdoutChunk(64 * 1024)
    if (out.length) stdout += out.toString('utf8')
    const err = handle.readStderrChunk(64 * 1024)
    if (err.length) stderr += err.toString('utf8')

    const code = handle.pollExit()
    if (code !== null) {
      handle.close()
      const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
      try {
        const parsed = JSON.parse(line) as AcpBootstrapProbeResult
        return { ...parsed, exitCode: code, sandboxBackend: backend }
      } catch {
        return {
          ok: false,
          phase: 'spawn',
          message: `probe output not JSON: ${line.slice(0, 200) || stderr.slice(0, 200)}`,
          totalMs: 0,
          outerSandbox: true,
          executable: '',
          cliArgs: [],
          envKeys: {},
          exitCode: code,
          sandboxBackend: backend,
          stderrTail: stderr.trim().slice(-400) || undefined
        }
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }

  handle.kill()
  handle.close()
  throw new Error(`${input.label}: sandbox probe timed out`)
}

function runSandboxCliPreflight(
  label: string,
  policy: ReturnType<typeof policyForRole>,
  envRecord: Record<string, string>,
  cwd: string
): CliPreflightResult {
  const native = loadNative()
  native.preflight()

  const command = resolveCursorAgentCommand()
  const envEntries = Object.entries({ ...envRecord, CODETASK_OUTER_SANDBOX: '1' }).map(
    ([key, value]) => ({ key, value })
  )

  const shellCmd =
    process.platform === 'win32' ? `${command} status` : `${command} status 2>&1 | head -n 8`

  const handle = native.launchSandboxedWorker({
    policyJson: wirePolicy(policy),
    command: process.platform === 'win32' ? 'cmd.exe' : 'sh',
    args: process.platform === 'win32' ? ['/c', shellCmd] : ['-lc', shellCmd],
    cwd,
    env: envEntries,
    readRoots: collectPolicyReadRoots(policy),
    writeRoots: collectPolicyWriteRoots(policy)
  })
  handle.endStdin()

  if (!handle.waitForAttestation(30_000)) {
    handle.kill()
    handle.close()
    throw new Error(`${label}: attestation timeout`)
  }

  let stdout = ''
  let stderr = ''
  const started = Date.now()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    stdout += handle.readStdoutChunk(64 * 1024).toString('utf8')
    stderr += handle.readStderrChunk(64 * 1024).toString('utf8')
    const code = handle.pollExit()
    if (code !== null) {
      handle.close()
      const env = { ...envRecord, CODETASK_OUTER_SANDBOX: '1' }
      const executable = resolveCursorAgentExecutable(command, env)
      const authProbe = probeCursorAgentAuth(executable, env)
      return {
        ok: code === 0 && !authProbe,
        command,
        executable,
        stdout: stdout.trim().slice(0, 500),
        stderr: stderr.trim().slice(0, 500),
        exitCode: code,
        authProbe,
        elapsedMs: Date.now() - started
      }
    }
  }
  handle.kill()
  handle.close()
  throw new Error(`${label}: agent status timed out`)
}

function printComparison(report: Record<string, unknown>): void {
  console.log('\n======== Cursor ACP host vs sandbox ========')
  console.log(JSON.stringify(report, null, 2))
  console.log('============================================\n')

  const hostAcp = report.hostAcp as AcpBootstrapProbeResult | undefined
  const sandboxAcp = report.sandboxAcp as AcpBootstrapProbeResult | undefined

  if (hostAcp && sandboxAcp) {
    console.log('Summary:')
    console.log(
      `  Host preflight (agent status): ${(report.hostPreflight as CliPreflightResult)?.ok ? 'OK' : 'FAIL'}`
    )
    console.log(
      `  Host ACP authenticate:         ${hostAcp.ok ? 'OK' : `FAIL @ ${hostAcp.phase} — ${hostAcp.message}`}`
    )
    if (!skipSandbox) {
      console.log(
        `  Sandbox preflight:           ${(report.sandboxPreflight as CliPreflightResult)?.ok ? 'OK' : 'FAIL'}`
      )
      console.log(
        `  Sandbox ACP authenticate:    ${sandboxAcp.ok ? 'OK' : `FAIL @ ${sandboxAcp.phase} — ${sandboxAcp.message}`}`
      )
    }

    if ((report.hostPreflight as CliPreflightResult)?.ok && !hostAcp.ok) {
      console.log(
        '\n⚠️  Preflight OK but host ACP failed → CLI login snapshot ≠ ACP authenticate path'
      )
    }
    if (hostAcp.ok && sandboxAcp && !sandboxAcp.ok) {
      console.log(
        '\n⚠️  Host ACP OK but sandbox ACP failed → likely sandbox env / auth snapshot / bwrap issue'
      )
    }
    if (!hostAcp.ok && sandboxAcp && !sandboxAcp.ok) {
      console.log('\n⚠️  Both failed → check agent login, network, or Cursor CLI version')
    }
  }
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'codetask-cursor-acp-sandbox-'))
  const runtimeRoot = join(base, 'runtime')
  const workspace = workspaceArg ? resolve(workspaceArg) : join(base, 'workspace')
  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# acp sandbox probe\n', 'utf8')

  log('setup', 'fixture', { workspace, runtimeRoot, projectRoot: process.cwd() })

  const cursorDriver = getProviderDriverForTest('cursorcli')
  const authPrepared = prepareProviderAuthForTest('cursorcli', runtimeRoot, {
    workspaceRoot: workspace
  })
  let providerPreflightOk = true
  let providerPreflightError: string | undefined
  try {
    const installation = await cursorDriver.discover()
    if (!installation) throw new Error('Cursor CLI installation was not discovered')
    cursorDriver.preflight({ preparedAuth: authPrepared, installation })
    log('setup', 'CursorDriver.preflight OK')
  } catch (error) {
    providerPreflightOk = false
    providerPreflightError = error instanceof Error ? error.message : String(error)
    log('setup', 'CursorDriver.preflight FAIL', providerPreflightError)
  }

  const dataDir = process.env.CODETASK_DATA_DIR?.trim() || join(process.cwd(), 'data')
  const sandboxRunner = resolveSandboxRunner()
  const sandboxEnv = buildSandboxEnv({
    runtimeRoot,
    dataDir,
    providerEnv: authPrepared.envPatch
  })

  let policy = policyForRole({
    role: 'task-worker',
    workspaceRoot: workspace,
    runtimeRoot
  })
  policy = applyProviderWriteRoots(policy, authPrepared.writeRoots)
  policy = applyProviderReadRoots(policy, [
    ...resolveProviderReadRoots('cursorcli'),
    ...authPrepared.readRoots,
    dataDir,
    process.cwd(),
    join(process.cwd(), 'node_modules'),
    ...sandboxRunner.extraReadRoots
  ])

  const report: Record<string, unknown> = {
    platform: process.platform,
    workspace,
    runtimeRoot,
    authDiagnostics: authPrepared.diagnostics,
    providerPreflightOk,
    providerPreflightError,
    hostPreflight: null as CliPreflightResult | null,
    hostAcp: null as AcpBootstrapProbeResult | null,
    sandboxPreflight: null as CliPreflightResult | null,
    sandboxAcp: null as (AcpBootstrapProbeResult & { sandboxBackend?: string }) | null,
    failures: [] as string[]
  }

  try {
    report.hostPreflight = runCliPreflight('host-preflight', authPrepared.envPatch, workspace)
    report.hostAcp = await runAcpBootstrapProbe({
      cwd: workspace,
      envPatch: authPrepared.envPatch
    })

    if (!skipSandbox) {
      report.sandboxPreflight = runSandboxCliPreflight(
        'sandbox-preflight',
        policy,
        sandboxEnv,
        workspace
      )
      report.sandboxAcp = await runSandboxProbe({
        label: 'sandbox-acp',
        policy,
        envRecord: sandboxEnv,
        cwd: workspace,
        runtimeRoot,
        envPatch: authPrepared.envPatch
      })
    }
  } finally {
    authPrepared.cleanupPlan()
  }

  const failures = report.failures as string[]
  if (!report.hostPreflight || !(report.hostPreflight as CliPreflightResult).ok) {
    failures.push('host preflight (agent status) failed')
  }
  if (!report.hostAcp || !(report.hostAcp as AcpBootstrapProbeResult).ok) {
    failures.push(`host ACP: ${(report.hostAcp as AcpBootstrapProbeResult)?.message ?? 'unknown'}`)
  }
  if (!skipSandbox) {
    if (!report.sandboxPreflight || !(report.sandboxPreflight as CliPreflightResult).ok) {
      failures.push('sandbox preflight (agent status) failed')
    }
    if (!report.sandboxAcp || !(report.sandboxAcp as AcpBootstrapProbeResult).ok) {
      failures.push(
        `sandbox ACP: ${(report.sandboxAcp as AcpBootstrapProbeResult)?.message ?? 'unknown'}`
      )
    }
  }

  printComparison(report)

  if (failures.length > 0) {
    console.error('Failures:', failures)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[cursor-acp-sandbox] fatal:', error)
    process.exit(1)
  })
}
