import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { realpathSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SANDBOX_COMMAND_STARTED_MARKER = '__CODETASK_SANDBOX_COMMAND_STARTED__'

export function sandboxTestsEnabled() {
  if (process.env.CODETASK_DISABLE_OUTER_SANDBOX === '1') {
    return { enabled: false, reason: 'CODETASK_DISABLE_OUTER_SANDBOX=1' }
  }
  const addonPath = join(process.cwd(), 'native/codeteam-sandbox')
  if (!existsSync(join(addonPath, 'index.js'))) {
    return { enabled: false, reason: 'native addon missing; run npm run build:sandbox' }
  }
  let hasNodeBinary = false
  try {
    const entries = readdirSync(addonPath)
    hasNodeBinary = entries.some((entry) => entry.endsWith('.node'))
  } catch {
    // ignore readdir failures
  }
  if (!hasNodeBinary) {
    return { enabled: false, reason: 'native .node binary not built; run npm run build:sandbox' }
  }
  return { enabled: true }
}

let runtimeGate

/**
 * Detect hosts that explicitly deny nested OS sandboxes (for example, running
 * this suite from inside another macOS seatbelt). A broken sandbox remains a
 * hard failure; only a positively identified host restriction may skip.
 */
export function sandboxRuntimeTestsEnabled() {
  if (runtimeGate) return runtimeGate
  const buildGate = sandboxTestsEnabled()
  if (!buildGate.enabled) return (runtimeGate = buildGate)

  const native = loadNative()
  const fixture = createSandboxFixture('codetask-sandbox-runtime-gate-')
  let handle
  try {
    const policy = sandboxPolicyForRole('planner', fixture.workspace, fixture.runtime)
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const args = process.platform === 'win32' ? ['/c', 'exit 0'] : ['-lc', 'exit 0']
    handle = native.launchSandboxedWorker({
      policyJson: wirePolicy(policy),
      command: shell,
      args,
      cwd: policy.cwd,
      env: [{ key: 'CODETASK_OUTER_SANDBOX', value: '1' }]
    })
    handle.endStdin()
    if (handle.waitForAttestation(3_000)) {
      return (runtimeGate = { enabled: true })
    }
    const stderr = drain(handle, 'stderr')
    const nestedSandboxDenied =
      /sandbox_apply:\s*Operation not permitted|nested sandbox|not permitted by host sandbox/i.test(
        stderr
      )
    if (nestedSandboxDenied && process.env.CODETASK_REQUIRE_SANDBOX_TESTS !== '1') {
      return (runtimeGate = {
        enabled: false,
        reason: `host denies nested OS sandbox: ${stderr.trim().slice(0, 300)}`
      })
    }
    return (runtimeGate = { enabled: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      /sandbox_apply:\s*Operation not permitted|nested sandbox|not permitted by host sandbox/i.test(
        message
      ) &&
      process.env.CODETASK_REQUIRE_SANDBOX_TESTS !== '1'
    ) {
      return (runtimeGate = {
        enabled: false,
        reason: `host denies nested OS sandbox: ${message.slice(0, 300)}`
      })
    }
    return (runtimeGate = { enabled: true })
  } finally {
    try {
      handle?.kill()
      handle?.close()
    } catch {
      // Gate cleanup is best effort.
    }
    fixture.cleanup()
  }
}

export function loadNative() {
  const gate = sandboxTestsEnabled()
  if (!gate.enabled) {
    throw new Error(gate.reason)
  }
  return require(join(process.cwd(), 'native/codeteam-sandbox'))
}

export function expectedBackend() {
  switch (process.platform) {
    case 'linux':
      return 'linux-bwrap-seccomp'
    case 'darwin':
      return 'macos-seatbelt'
    case 'win32':
      return 'windows-elevated'
    default:
      return null
  }
}

function uniqueRoots(roots) {
  const seen = new Set()
  const out = []
  for (const root of roots) {
    const key = root.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

export function sandboxPolicyForRole(role, workspaceRoot, runtimeRoot, options = {}) {
  const workspace = realpathSync(workspaceRoot)
  const runtime = realpathSync(runtimeRoot)
  const allowedReadRoots = uniqueRoots([
    workspace,
    runtime,
    join(runtime, 'tmp'),
    dirname(process.execPath),
    ...(options.extraReadRoots ?? [])
  ])
  const allowedWriteRoots = uniqueRoots([runtime, join(runtime, 'tmp')])

  if (role === 'task-worker') {
    allowedWriteRoots.push(workspace)
  }

  if (
    (role === 'work-verifier' || role === 'milestone-verifier' || role === 'slice-verifier') &&
    options.verifierOutputRoot
  ) {
    allowedWriteRoots.push(realpathSync(options.verifierOutputRoot))
  }

  return {
    role,
    cwd: workspace,
    runtimeRoot: runtime,
    filesystem: {
      defaultAccess: 'none',
      allowedReadRoots,
      allowedWriteRoots,
      protectedNames: ['.git', '.agents', '.codex', '.codeteam'],
      allowSystemRuntime: true
    },
    network: {
      mode: 'full',
      allowLoopback: true,
      allowUnixSockets: []
    },
    process: {
      isolateFromHost: true,
      allowOwnDescendantSignals: true,
      denyPtrace: true
    }
  }
}

export function wirePolicy(policy) {
  return JSON.stringify({
    version: 2,
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

export function sha256Policy(policy) {
  return createHash('sha256').update(wirePolicy(policy)).digest('hex')
}

export function createSandboxFixture(prefix = 'codeteam-sandbox-fixture-') {
  const base = mkdtempSync(join(tmpdir(), prefix))
  const workspace = join(base, 'workspace')
  const runtime = join(base, 'runtime')
  const verifierOutput = join(base, 'verifier-out')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(runtime, { recursive: true })
  mkdirSync(verifierOutput, { recursive: true })
  return {
    base,
    workspace,
    runtime,
    verifierOutput,
    cleanup() {
      rmSync(base, { recursive: true, force: true })
    }
  }
}

export function outsideWriteProbePath() {
  return process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'codeteam-outside-probe.txt')
    : '/etc/codeteam-outside-probe.txt'
}

export function platformRuntimeReadCommand() {
  if (process.platform === 'win32') {
    const hosts = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'drivers',
      'etc',
      'hosts'
    )
    return `type "${hosts}"`
  }
  return 'head -n 1 /etc/hosts'
}

export function shellQuote(path) {
  if (process.platform === 'win32') {
    return `"${path.replace(/"/g, '""')}"`
  }
  return `"${path.replace(/"/g, '\\"')}"`
}

export async function runInSandbox(native, policy, shellCommand, env = []) {
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
  const markedCommand =
    process.platform === 'win32'
      ? `echo ${SANDBOX_COMMAND_STARTED_MARKER} & ${shellCommand}`
      : `printf '%s\\n' '${SANDBOX_COMMAND_STARTED_MARKER}'; ${shellCommand}`
  const shellArgs = process.platform === 'win32' ? ['/c', markedCommand] : ['-lc', markedCommand]

  const handle = native.launchSandboxedWorker({
    policyJson: wirePolicy(policy),
    command: shell,
    args: shellArgs,
    cwd: policy.cwd,
    env: [{ key: 'CODETASK_OUTER_SANDBOX', value: '1' }, ...env]
  })

  handle.endStdin()

  if (!handle.waitForAttestation(15_000)) {
    const stderr = drain(handle, 'stderr').trim()
    handle.kill()
    handle.close()
    throw new Error(
      `sandbox helper attestation timeout${stderr ? `; stderr: ${stderr.slice(0, 2_000)}` : ''}`
    )
  }

  const evidence = handle.evidence
  if (!evidence.active) {
    handle.kill()
    handle.close()
    throw new Error('sandbox evidence not active after attestation')
  }

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const code = handle.pollExit()
    if (code !== null && code !== undefined) {
      const stdout = drain(handle, 'stdout')
      const stderr = drain(handle, 'stderr')
      handle.close()
      return { code, stdout, stderr, evidence }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  handle.kill()
  handle.close()
  throw new Error('sandbox timed out')
}

function drain(handle, stream) {
  const chunks = []
  const read =
    stream === 'stdout' ? handle.readStdoutChunk.bind(handle) : handle.readStderrChunk.bind(handle)
  for (;;) {
    let buf
    try {
      buf = read(64 * 1024)
    } catch {
      break
    }
    if (!buf || buf.length === 0) break
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function assertCommandStarted(result, label) {
  if (!result.evidence?.active) {
    throw new Error(`${label}: sandbox command had no active attestation`)
  }
  if (!result.stdout.includes(SANDBOX_COMMAND_STARTED_MARKER)) {
    throw new Error(
      `${label}: sandbox helper started but the tested command did not; stdout=${result.stdout}; stderr=${result.stderr}`
    )
  }
}

export function assertFails(promise, label) {
  return promise.then((result) => {
    assertCommandStarted(result, label)
    if (result.code === 0) {
      throw new Error(`${label}: expected failure, got code 0; stderr=${result.stderr}`)
    }
    return result
  })
}

export function assertSucceeds(promise, label) {
  return promise.then((result) => {
    assertCommandStarted(result, label)
    if (result.code !== 0) {
      throw new Error(`${label}: expected success, got code ${result.code}: ${result.stderr}`)
    }
    return result
  })
}

export async function assertEscapeBlocked(promise, label, verifyUnchanged) {
  const result = await promise
  assertCommandStarted(result, label)
  if (result.code !== 0) {
    verifyUnchanged()
    return result
  }
  try {
    verifyUnchanged()
    return result
  } catch (error) {
    throw new Error(
      `${label}: sandbox escape — command exited 0 but side effect occurred: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function spawnHostSentinel() {
  if (process.platform === 'win32') {
    const child = spawn('ping', ['127.0.0.1', '-n', '600'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return {
      pid: child.pid,
      isAlive() {
        try {
          process.kill(child.pid, 0)
          return true
        } catch {
          return false
        }
      },
      cleanup() {
        if (this.isAlive()) {
          try {
            child.kill()
          } catch {
            spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' })
          }
        }
      }
    }
  }

  const child = spawn('sleep', ['600'], { stdio: 'ignore' })
  return {
    pid: child.pid,
    isAlive() {
      try {
        process.kill(child.pid, 0)
        return true
      } catch {
        return false
      }
    },
    cleanup() {
      if (this.isAlive()) {
        try {
          child.kill('SIGTERM')
        } catch {
          // best-effort cleanup
        }
      }
    }
  }
}

export function killHostFromSandboxCommand(hostPid) {
  if (process.platform === 'win32') {
    return `taskkill /PID ${hostPid} /F`
  }
  return `kill -9 ${hostPid}`
}

export function symlinkEscapeWriteCommand(workspace, outsideTarget) {
  const linkPath = join(workspace, 'escape-link')
  if (process.platform === 'win32') {
    return `mklink "${linkPath}" "${outsideTarget}" >nul 2>&1 && echo hacked> "${linkPath}"`
  }
  return `ln -sf "${outsideTarget}" "${linkPath}" && echo hacked > "${linkPath}"`
}

export function dockerSocketWriteCommand() {
  if (process.platform === 'win32') {
    return 'echo hacked> "\\\\.\\pipe\\docker_engine"'
  }
  return 'test -S /var/run/docker.sock && echo hacked > /var/run/docker.sock || exit 1'
}

export function ptraceHostCommand(hostPid) {
  if (process.platform === 'win32') {
    return `powershell -NoProfile -Command "try { (Get-Process -Id ${hostPid}).Kill(); exit 0 } catch { exit 1 }"`
  }
  if (process.platform === 'darwin') {
    // --batch propagates command failures; interactive lldb can print an attach
    // denial yet still exit 0 after processing the explicit `quit` command.
    return `lldb --batch -p ${hostPid} -o quit >/dev/null 2>&1`
  }
  return `gdb -p ${hostPid} -batch -ex quit 2>/dev/null`
}

export function killOwnChildInSandboxCommand() {
  if (process.platform === 'win32') {
    return 'ping 127.0.0.1 -n 300 >nul & for /f "tokens=2" %a in (\'tasklist /fi "imagename eq ping.exe" /nh ^| find "ping.exe"\') do taskkill /PID %a /F >nul 2>&1'
  }
  return 'sleep 300 & pid=$!; kill -9 $pid; wait $pid 2>/dev/null; exit 0'
}

export function debugAttachAvailable() {
  if (process.platform === 'win32') {
    return true
  }
  if (process.platform === 'darwin') {
    return spawnSync('which', ['lldb'], { encoding: 'utf8' }).status === 0
  }
  return spawnSync('which', ['gdb'], { encoding: 'utf8' }).status === 0
}
