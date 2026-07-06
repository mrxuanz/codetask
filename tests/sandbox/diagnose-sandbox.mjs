import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const caseFilter = args.includes('--case') ? args[args.indexOf('--case') + 1] : 'all'

function log(section, message, extra) {
  const prefix = `[diagnose:${section}]`
  if (extra !== undefined) {
    console.log(prefix, message, extra)
  } else {
    console.log(prefix, message)
  }
}

function serializeSandboxPolicy(policy) {
  return JSON.stringify({
    version: policy.version,
    role: policy.role,
    cwd: policy.cwd,
    runtime_root: policy.runtimeRoot,
    filesystem: {
      default: policy.filesystem.default,
      rules: policy.filesystem.rules.map((rule) => ({
        path: rule.path,
        access: rule.access
      })),
      protected_names: policy.filesystem.protectedNames
    },
    network: {
      ip: policy.network.ip,
      inbound: policy.network.inbound,
      allow_loopback: policy.network.allowLoopback,
      unix_sockets: policy.network.unixSockets
    },
    process: {
      isolate_from_host: policy.process.isolateFromHost,
      allow_own_descendant_signals: policy.process.allowOwnDescendantSignals,
      deny_ptrace: policy.process.denyPtrace
    }
  })
}

function policyForRole(role, workspaceRoot, runtimeRoot) {
  const rules = [{ path: runtimeRoot, access: 'write' }]
  if (role === 'task-worker') {
    rules.push({ path: workspaceRoot, access: 'write' })
  }
  return {
    version: 1,
    role,
    cwd: workspaceRoot,
    runtimeRoot,
    filesystem: {
      default: 'read',
      rules,
      protectedNames: ['.agents', '.codex', '.codeteam']
    },
    network: { ip: 'full', inbound: false, allowLoopback: true, unixSockets: [] },
    process: {
      isolateFromHost: true,
      allowOwnDescendantSignals: true,
      denyPtrace: true
    }
  }
}

function loadNative() {
  const addonPath = join(process.cwd(), 'native/codeteam-sandbox')
  if (!existsSync(join(addonPath, 'index.js'))) {
    throw new Error('native addon missing; run: npm run build:sandbox')
  }
  return require(addonPath)
}

function sandboxHome() {
  if (process.env.CODETASK_SANDBOX_HOME?.trim()) {
    return process.env.CODETASK_SANDBOX_HOME.trim()
  }
  const local = process.env.LOCALAPPDATA
  if (local) return join(local, 'codetask', 'sandbox-home')
  return join(process.cwd(), 'data', 'sandbox-home')
}

function ensureWindowsSetup(native) {
  if (process.platform !== 'win32') return
  const home = sandboxHome()
  mkdirSync(join(home, 'sandbox'), { recursive: true })
  if (native.windowsSetupStatus(home)) {
    log('setup', `Windows sandbox ready (${home})`)
    return
  }
  log('setup', 'Running windowsSetup (may prompt UAC once)...')
  native.windowsSetup(
    process.execPath,
    join(process.cwd(), 'native/codeteam-sandbox/setup-entry.js'),
    join(process.cwd(), 'native/codeteam-sandbox/runner-entry.js'),
    home,
    process.cwd()
  )
  if (!native.windowsSetupStatus(home)) {
    throw new Error('windowsSetup finished but marker not ready')
  }
  log('setup', 'windowsSetup OK')
}

function buildSandboxEnv(runtimeRoot, profileMode) {
  const hostProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const env = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: runtimeRoot,
    TMPDIR: join(runtimeRoot, 'tmp'),
    TEMP: join(runtimeRoot, 'tmp'),
    TMP: join(runtimeRoot, 'tmp'),
    XDG_CONFIG_HOME: join(runtimeRoot, 'config'),
    XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
    XDG_DATA_HOME: join(runtimeRoot, 'data'),
    CODETASK_RUNTIME_ROOT: runtimeRoot,
    CODETASK_OUTER_SANDBOX: '1'
  }

  if (hostProfile) {
    env.CODETASK_SANDBOX_HOST_PROFILE = hostProfile
  }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    if (process.env[key]) env[key] = process.env[key]
  }

  if (process.platform === 'win32') {
    env.ELECTRON_RUN_AS_NODE = '1'
    env.ELECTRON_DISABLE_CRASH_REPORTER = '1'
    env.CHROME_CRASHPAD_HANDLER_PID = '0'

    if (profileMode === 'isolated') {
      env.USERPROFILE = runtimeRoot
      env.APPDATA = join(runtimeRoot, 'AppData', 'Roaming')
      env.LOCALAPPDATA = join(runtimeRoot, 'AppData', 'Local')
      env.CLAUDE_CONFIG_DIR = join(runtimeRoot, '.claude')
      env.BREAKPAD_DUMP_LOCATION = join(runtimeRoot, 'tmp', 'crashpad')
      if (/^[A-Za-z]:/.test(runtimeRoot)) {
        env.HOMEDRIVE = runtimeRoot.slice(0, 2)
        env.HOMEPATH = runtimeRoot.slice(2) || '\\'
      }
    } else if (profileMode === 'host-read') {
      env.USERPROFILE = hostProfile
      env.APPDATA = join(hostProfile, 'AppData', 'Roaming')
      env.LOCALAPPDATA = join(hostProfile, 'AppData', 'Local')
      env.CLAUDE_CONFIG_DIR = join(hostProfile, '.claude')
    }
  }

  return env
}

function ensureRuntimeDirs(runtimeRoot) {
  for (const sub of [
    'tmp',
    'tmp/crashpad',
    'config',
    'cache',
    'data',
    'AppData/Roaming',
    'AppData/Local',
    '.claude'
  ]) {
    mkdirSync(join(runtimeRoot, sub), { recursive: true })
  }
}

function drainChunks(handle, readFn) {
  const chunks = []
  for (;;) {
    const buf = readFn(64 * 1024)
    if (!buf || buf.length === 0) break
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runSandboxCase(native, options) {
  const { name, policy, command, args, stdinPayload, env, timeoutMs = 180_000 } = options

  log(name, 'launching', { command, args: args.slice(0, 3) })

  const handle = native.launchSandboxedWorker({
    policyJson: serializeSandboxPolicy(policy),
    command,
    args,
    cwd: policy.cwd,
    env: Object.entries(env).map(([key, value]) => ({ key, value }))
  })

  if (stdinPayload !== undefined) {
    handle.writeStdin(Buffer.from(JSON.stringify(stdinPayload), 'utf8'))
  }
  handle.endStdin()

  let stdout = ''
  let stderr = ''
  let processDone = false
  const exitPromise = Promise.resolve().then(() => {
    const code = handle.wait()
    processDone = true
    return code
  })

  const deadline = Date.now() + timeoutMs
  while (!processDone && Date.now() < deadline) {
    const chunk = handle.readStdoutChunk(64 * 1024)
    if (chunk?.length) {
      stdout += chunk.toString('utf8')
    } else {
      await sleep(25)
    }
    const errChunk = handle.readStderrChunk(64 * 1024)
    if (errChunk?.length) stderr += errChunk.toString('utf8')
  }

  const exitCode = await exitPromise
  stdout += drainChunks(handle, (n) => handle.readStdoutChunk(n))
  stderr += drainChunks(handle, (n) => handle.readStderrChunk(n))
  handle.close()

  const result = {
    name,
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    evidence: handle.evidence
  }

  if (exitCode !== 0) {
    log(name, `FAILED exit=${exitCode}`)
    if (stderr) console.error(stderr)
  } else {
    log(name, 'OK')
  }
  return result
}

function resolveClaudeExe() {
  const fromPath = spawnSync('where', ['claude'], { encoding: 'utf8', shell: true })
  if (fromPath.status === 0) {
    const line = fromPath.stdout.split(/\r?\n/).find((l) => l.trim())
    if (line?.endsWith('.exe')) return line.trim()
    if (line) {
      const ps1 = line.trim()
      const dir = ps1.replace(/\\claude\.ps1$/i, '')
      const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      if (existsSync(exe)) return exe
    }
  }
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'),
    join(
      process.env.ProgramFiles ?? 'C:\\Program Files',
      'nodejs',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe'
    )
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function parseWorkerProbes(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed.type === 'completed' && parsed.probes) return parsed.probes
    } catch {
      // best-effort, ignore parse errors
    }
  }
  return null
}

async function main() {
  if (process.env.CODETASK_DISABLE_OUTER_SANDBOX === '1') {
    console.error('Refusing to run with CODETASK_DISABLE_OUTER_SANDBOX=1')
    process.exit(2)
  }

  log('host', `execPath=${process.execPath}`)
  log('host', `electron=${process.versions.electron ?? 'n/a'} node=${process.version}`)

  const native = loadNative()
  native.preflight()
  ensureWindowsSetup(native)

  const base = mkdtempSync(join(tmpdir(), 'codeteam-diagnose-'))
  const workspace = process.cwd()
  const runtime = join(base, 'runtime')
  ensureRuntimeDirs(runtime)

  const plannerPolicy = policyForRole('planner', workspace, runtime)
  const workerScript = join(process.cwd(), 'tests/sandbox/diagnose-worker.mjs')
  const claudeExe = resolveClaudeExe()
  log('host', `claudeExe=${claudeExe ?? 'NOT FOUND'}`)
  log('host', `workspace=${workspace}`)
  log('host', `runtime=${runtime}`)

  const workerInput = {
    workspaceRoot: workspace,
    runtimeRoot: runtime,
    hostProfile: process.env.USERPROFILE ?? '',
    claudeExe,
    nodeExe: process.execPath
  }

  const cases = []

  if (caseFilter === 'all' || caseFilter === 'ping') {
    cases.push(
      runSandboxCase(native, {
        name: 'ping-electron',
        policy: plannerPolicy,
        command: process.execPath,
        args: ['-e', "console.log(JSON.stringify({type:'completed',reply:'pong'}))"],
        env: buildSandboxEnv(runtime, 'isolated')
      })
    )
  }

  if (caseFilter === 'all' || caseFilter === 'worker') {
    cases.push(
      runSandboxCase(native, {
        name: 'diagnose-worker-isolated',
        policy: plannerPolicy,
        command: process.execPath,
        args: [workerScript],
        stdinPayload: workerInput,
        env: buildSandboxEnv(runtime, 'isolated')
      })
    )
  }

  if (caseFilter === 'all' || caseFilter === 'worker-host') {
    cases.push(
      runSandboxCase(native, {
        name: 'diagnose-worker-host-profile',
        policy: plannerPolicy,
        command: process.execPath,
        args: [workerScript],
        stdinPayload: workerInput,
        env: buildSandboxEnv(runtime, 'host-read')
      })
    )
  }

  if ((caseFilter === 'all' || caseFilter === 'claude') && claudeExe) {
    cases.push(
      runSandboxCase(native, {
        name: 'claude-version-isolated',
        policy: plannerPolicy,
        command: claudeExe,
        args: ['--version'],
        env: buildSandboxEnv(runtime, 'isolated')
      })
    )
    cases.push(
      runSandboxCase(native, {
        name: 'claude-version-host-profile',
        policy: plannerPolicy,
        command: claudeExe,
        args: ['--version'],
        env: buildSandboxEnv(runtime, 'host-read')
      })
    )
  }

  const results = await Promise.all(cases)
  const reportPath = join(base, 'report.json')
  const report = {
    platform: process.platform,
    execPath: process.execPath,
    claudeExe,
    workspace,
    runtime,
    hostProfile: process.env.USERPROFILE,
    results: results.map((r) => {
      const probes = parseWorkerProbes(r.stdout)
      return { ...r, probes }
    })
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

  console.log('\n========== SUMMARY ==========')
  for (const r of report.results) {
    console.log(`- ${r.name}: exit=${r.exitCode}`)
    if (r.probes) {
      for (const p of r.probes) {
        if (p.label && 'ok' in p) {
          console.log(`    ${p.label}: ${p.ok ? 'OK' : 'FAIL'}${p.error ? ` (${p.error})` : ''}`)
        }
      }
    } else if (r.stderr) {
      console.log(`    stderr: ${r.stderr.split('\n')[0]}`)
    }
  }
  console.log(`\nFull report: ${reportPath}`)
  console.log(`(temp base retained for inspection: ${base})`)

  const failed = report.results.some((r) => r.exitCode !== 0)
  if (failed) process.exit(1)
}

main().catch((error) => {
  console.error('[diagnose] fatal:', error)
  process.exit(1)
})
