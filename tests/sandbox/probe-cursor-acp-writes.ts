/**
 * Evidence probe: Cursor ACP file writes under runtimeRoot
 * - host (non-outer-sandbox conversation path)
 * - outer OS sandbox (task-worker path)
 *
 * Distinguishes mkdir-only vs actual files.
 *
 *   node --import ./tests/tsx-tsconfig.mjs --import tsx tests/sandbox/probe-cursor-acp-writes.ts
 */
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runAcpBootstrapProbe } from './acp-bootstrap-probe'
import { buildCursorTurnPlan } from '../../src/server/providers/cursor/turn-plan'
import { prepareProviderRuntimeForTest } from '../helpers/provider-runtime'
import { buildSandboxEnv } from '../../src/server/sandbox/env'
import {
  applyProviderReadRoots,
  applyProviderWriteRoots,
  collectPolicyReadRoots,
  collectPolicyWriteRoots,
  createSandboxPolicy
} from '../../src/server/sandbox/policy'
import { resolveProviderReadRoots } from '../../src/server/sandbox/provider-read-roots'
import {
  providerRuntimeReadRoots,
  providerRuntimeWriteRoots
} from '../../src/server/sandbox/provider-auth/types'
import { resolveCursorAgentExecutable } from '../../src/server/agent-runtime/cursor-acp/command'

const require = createRequire(import.meta.url)

type TreeSnap = { dirs: string[]; files: string[]; totalBytes: number }

function walkRel(root: string): TreeSnap {
  const dirs: string[] = []
  const files: string[] = []
  let totalBytes = 0
  const walk = (abs: string, rel: string): void => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childAbs = join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        dirs.push(childRel)
        walk(childAbs, childRel)
      } else if (entry.isFile()) {
        files.push(childRel)
        try {
          totalBytes += statSync(childAbs).size
        } catch {
          // ignore
        }
      }
    }
  }
  if (existsSync(root)) walk(root, '')
  return { dirs: dirs.sort(), files: files.sort(), totalBytes }
}

function diff(before: TreeSnap, after: TreeSnap) {
  const bd = new Set(before.dirs)
  const bf = new Set(before.files)
  return {
    newDirs: after.dirs.filter((d) => !bd.has(d)),
    newFiles: after.files.filter((f) => !bf.has(f)),
    bytesDelta: after.totalBytes - before.totalBytes
  }
}

function wirePolicy(policy: ReturnType<typeof createSandboxPolicy>): string {
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

function loadNative(): {
  preflight: () => void
  launchSandboxedWorker: (opts: Record<string, unknown>) => {
    endStdin: () => void
    waitForAttestation: (ms: number) => boolean
    readStdoutChunk: (n: number) => Buffer
    readStderrChunk: (n: number) => Buffer
    pollExit: () => number | null
    kill: () => void
    close: () => void
    evidence: { backend?: string }
  }
} {
  const candidates = [
    join(process.cwd(), 'native/codeteam-sandbox'),
    join(process.cwd(), 'native/codeteam-sandbox/index.js')
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch {
      // continue
    }
  }
  throw new Error('native sandbox addon not loadable')
}

function resolveSandboxRunner(probeScript: string): {
  command: string
  args: string[]
  extraReadRoots: string[]
} {
  const tsxLoader = join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')
  const tsxTsconfig = join(process.cwd(), 'tests/tsx-tsconfig.mjs')
  const extraReadRoots: string[] = [process.cwd(), join(process.cwd(), 'node_modules'), dirname(tsxLoader)]
  const nodeCandidates = [
    process.env.VOLTA_HOME
      ? join(process.env.VOLTA_HOME, 'tools/image/node/24.18.0/bin/node')
      : '',
    '/Users/xhz/.volta/tools/image/node/24.18.0/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node'
  ].filter(Boolean)

  for (const command of nodeCandidates) {
    if (!existsSync(command)) continue
    try {
      const resolved = realpathSync(command)
      if (/electron/i.test(resolved)) continue
      extraReadRoots.push(dirname(resolved))
      return {
        command: resolved,
        args: [
          '--import',
          pathToFileURL(tsxTsconfig).href,
          '--import',
          pathToFileURL(tsxLoader).href,
          probeScript
        ],
        extraReadRoots
      }
    } catch {
      // continue
    }
  }
  throw new Error('no suitable node binary for sandbox probe')
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'codetask-cursor-writes-'))
  const hostRuntime = join(base, 'host-runtime')
  const sandboxRuntime = join(base, 'sandbox-runtime')
  const workspace = join(base, 'workspace')
  mkdirSync(hostRuntime, { recursive: true })
  mkdirSync(sandboxRuntime, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# cursor write probe\n', 'utf8')

  const hostDotCursor = join(process.env.HOME ?? '', '.cursor')
  const hostDotCursorBefore = existsSync(hostDotCursor)
    ? walkRel(hostDotCursor)
    : { dirs: [], files: [], totalBytes: 0 }

  console.log('[probe] base', base)
  console.log('[probe] agent', resolveCursorAgentExecutable() || '(missing)')

  // ── Host / non-sandbox ────────────────────────────────────────────
  const hostEmpty = walkRel(hostRuntime)
  mkdirSync(join(hostRuntime, 'tmp'), { recursive: true })
  const hostAfterMkdir = walkRel(hostRuntime)
  const hostMkdirDiff = diff(hostEmpty, hostAfterMkdir)

  const hostPlan = buildCursorTurnPlan(
    {
      provider: 'cursorcli',
      role: 'conversation',
      cwd: workspace,
      runtimeRoot: hostRuntime,
      prompt: 'ping',
      capabilityProfile: 'chat-write'
    },
    { outerSandbox: false, approveMcps: true }
  )
  const hostBeforeAcp = walkRel(hostRuntime)
  const hostAcp = await runAcpBootstrapProbe({ cwd: workspace, envPatch: hostPlan.env })
  const hostAfterAcp = walkRel(hostRuntime)
  const hostAcpDiff = diff(hostBeforeAcp, hostAfterAcp)

  console.log('\n=== HOST (non-outer-sandbox) ===')
  console.log('CURSOR_DATA_DIR', hostPlan.env.CURSOR_DATA_DIR ?? '(unset — host default)')
  console.log('mkdir-only newDirs', hostMkdirDiff.newDirs)
  console.log('mkdir-only newFiles', hostMkdirDiff.newFiles)
  console.log('acp', { ok: hostAcp.ok, phase: hostAcp.phase, message: hostAcp.message })
  console.log('after-ACP newDirs', hostAcpDiff.newDirs)
  console.log('after-ACP newFiles', hostAcpDiff.newFiles)
  console.log('after-ACP bytesDelta', hostAcpDiff.bytesDelta)

  // ── Outer sandbox ─────────────────────────────────────────────────
  const sandboxEmpty = walkRel(sandboxRuntime)
  const prepared = prepareProviderRuntimeForTest('cursorcli', sandboxRuntime, {
    workspaceRoot: workspace
  })
  const sandboxPlan = buildCursorTurnPlan(
    {
      provider: 'cursorcli',
      role: 'task-worker',
      cwd: workspace,
      runtimeRoot: sandboxRuntime,
      prompt: 'ping',
      capabilityProfile: 'task-sandbox'
    },
    { outerSandbox: true, approveMcps: true }
  )
  const envRecord = buildSandboxEnv({
    runtimeRoot: sandboxRuntime,
    providerEnv: { ...prepared.environment, ...sandboxPlan.env },
    mcpToken: 'probe'
  })
  const sandboxAfterPrepare = walkRel(sandboxRuntime)
  const sandboxPrepareDiff = diff(sandboxEmpty, sandboxAfterPrepare)

  let policy = createSandboxPolicy({
    role: 'task-worker',
    workspaceRoot: workspace,
    runtimeRoot: sandboxRuntime
  })
  const runner = resolveSandboxRunner(join(process.cwd(), 'tests/sandbox/acp-bootstrap-probe.ts'))
  policy = applyProviderReadRoots(policy, [
    ...resolveProviderReadRoots('cursorcli'),
    ...providerRuntimeReadRoots(prepared),
    ...runner.extraReadRoots,
    process.cwd(),
    join(process.cwd(), 'tests'),
    join(process.cwd(), 'node_modules'),
    // tsx may cache under the process tmpdir; allow read or force TMPDIR into runtime.
    tmpdir()
  ])
  policy = applyProviderWriteRoots(policy, [
    ...providerRuntimeWriteRoots(prepared),
    sandboxRuntime,
    // Probe-only: allow tsx cache under OS tmp if TMPDIR redirect is ignored.
    tmpdir()
  ])

  const cursorDataDir =
    sandboxPlan.env.CURSOR_DATA_DIR ?? envRecord.CURSOR_DATA_DIR ?? '(unset — host default)'
  const runtimeTmp = join(sandboxRuntime, 'tmp')
  mkdirSync(runtimeTmp, { recursive: true })

  const probeEnvEntries = Object.entries({
    ...envRecord,
    CODETASK_PROBE_CWD: workspace,
    CODETASK_RUNTIME_ROOT: sandboxRuntime,
    CODETASK_PROBE_HOME: envRecord.HOME ?? '',
    CODETASK_PROBE_CURSOR_CONFIG_DIR: envRecord.CURSOR_CONFIG_DIR ?? '',
    CODETASK_PROBE_ENV_CURSOR_DATA_DIR: typeof cursorDataDir === 'string' ? cursorDataDir : '',
    CODETASK_PROBE_ENV_TMPDIR: envRecord.TMPDIR ?? '',
    CODETASK_PROBE_ENV_TEMP: envRecord.TEMP ?? '',
    CODETASK_PROBE_ENV_TMP: envRecord.TMP ?? ''
  })
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(([key, value]) => ({ key, value }))

  const native = loadNative()
  native.preflight()
  const sandboxBeforeAcp = walkRel(sandboxRuntime)
  const handle = native.launchSandboxedWorker({
    policyJson: wirePolicy(policy),
    command: runner.command,
    args: runner.args,
    cwd: process.cwd(),
    env: probeEnvEntries,
    readRoots: collectPolicyReadRoots(policy),
    writeRoots: collectPolicyWriteRoots(policy)
  })
  handle.endStdin()
  if (!handle.waitForAttestation(30_000)) {
    handle.kill()
    handle.close()
    throw new Error('sandbox attestation timeout')
  }
  const sandboxBackend = handle.evidence.backend

  let stdout = ''
  let stderr = ''
  const deadline = Date.now() + 180_000
  let exitCode: number | null = null
  while (Date.now() < deadline) {
    const out = handle.readStdoutChunk(64 * 1024)
    if (out.length) stdout += out.toString('utf8')
    const err = handle.readStderrChunk(64 * 1024)
    if (err.length) stderr += err.toString('utf8')
    exitCode = handle.pollExit()
    if (exitCode !== null) break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (exitCode === null) {
    handle.kill()
  }
  handle.close()

  let sandboxAcp: { ok: boolean; phase: string; message?: string } = {
    ok: false,
    phase: 'unknown'
  }
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; phase?: string; message?: string }
    sandboxAcp = {
      ok: Boolean(parsed.ok),
      phase: parsed.phase ?? 'unknown',
      message: parsed.message
    }
  } catch {
    sandboxAcp = {
      ok: false,
      phase: 'parse',
      message: stderr.trim().slice(-400) || line.slice(0, 400) || 'no json'
    }
  }

  const sandboxAfterAcp = walkRel(sandboxRuntime)
  const sandboxAcpDiffRaw = diff(sandboxBeforeAcp, sandboxAfterAcp)
  const ignoreNames = new Set(['.sandbox-attestation.json', 'emit-sandbox-attestation.cjs'])
  const sandboxAcpDiff = {
    newDirs: sandboxAcpDiffRaw.newDirs,
    newFiles: sandboxAcpDiffRaw.newFiles.filter((f) => !ignoreNames.has(f)),
    bytesDelta: sandboxAcpDiffRaw.bytesDelta
  }
  const underCursor = (paths: string[]) =>
    paths.filter((f) => f === '.cursor' || f.startsWith('.cursor/'))
  const sandboxCursorNewFiles = underCursor(sandboxAcpDiff.newFiles)
  const sandboxCursorNewDirs = underCursor(sandboxAcpDiff.newDirs)

  console.log('\n=== SANDBOX (outer OS sandbox) ===')
  console.log('CURSOR_DATA_DIR', cursorDataDir)
  console.log('prepare/mkdir newDirs', sandboxPrepareDiff.newDirs)
  console.log('prepare/mkdir newFiles', sandboxPrepareDiff.newFiles)
  console.log('acp', { ...sandboxAcp, exitCode, backend: sandboxBackend })
  console.log('after-ACP newDirs (excl attestation)', sandboxAcpDiff.newDirs)
  console.log('after-ACP newFiles (excl attestation)', sandboxAcpDiff.newFiles)
  console.log('after-ACP under .cursor files', sandboxCursorNewFiles)
  console.log('after-ACP under .cursor dirs', sandboxCursorNewDirs)
  console.log('after-ACP bytesDelta', sandboxAcpDiff.bytesDelta)

  const hostDotCursorAfter = existsSync(hostDotCursor)
    ? walkRel(hostDotCursor)
    : { dirs: [], files: [], totalBytes: 0 }
  const hostDotDiff = diff(hostDotCursorBefore, hostDotCursorAfter)
  console.log('\n=== ~/.cursor side effects ===')
  console.log('newFiles', hostDotDiff.newFiles.length, hostDotDiff.newFiles.slice(0, 30))
  console.log('bytesDelta', hostDotDiff.bytesDelta)

  const report = {
    fixture: base,
    hostNonSandbox: {
      acpOk: hostAcp.ok,
      cursorDataDir: hostPlan.env.CURSOR_DATA_DIR ?? null,
      mkdirOnlyCreatesDirs: hostMkdirDiff.newDirs.length > 0 && hostMkdirDiff.newFiles.length === 0,
      mkdirNewDirs: hostMkdirDiff.newDirs,
      mkdirNewFiles: hostMkdirDiff.newFiles,
      acpWroteFilesUnderRuntime: hostAcpDiff.newFiles.length > 0,
      acpNewDirs: hostAcpDiff.newDirs,
      acpNewFiles: hostAcpDiff.newFiles,
      acpBytesDelta: hostAcpDiff.bytesDelta
    },
    outerSandbox: {
      acpOk: sandboxAcp.ok,
      cursorDataDir,
      prepareCreatesDirs: sandboxPrepareDiff.newDirs.length > 0,
      prepareNewDirs: sandboxPrepareDiff.newDirs,
      prepareNewFiles: sandboxPrepareDiff.newFiles,
      acpWroteFilesUnderRuntimeExclAttestation: sandboxAcpDiff.newFiles.length > 0,
      acpWroteFilesUnderCursorDataDir: sandboxCursorNewFiles.length > 0,
      acpNewDirs: sandboxAcpDiff.newDirs,
      acpNewFiles: sandboxAcpDiff.newFiles,
      acpCursorNewFiles: sandboxCursorNewFiles,
      acpCursorNewDirs: sandboxCursorNewDirs,
      acpBytesDelta: sandboxAcpDiff.bytesDelta,
      phase: sandboxAcp.phase,
      message: sandboxAcp.message
    },
    hostDotCursor: {
      newFileCount: hostDotDiff.newFiles.length,
      newFilesSample: hostDotDiff.newFiles.slice(0, 30),
      bytesDelta: hostDotDiff.bytesDelta
    },
    verdict: {
      host: {
        createsEmptyDirsBeforeAcp: hostMkdirDiff.newDirs.length > 0,
        acpWritesFilesToRuntime: hostAcpDiff.newFiles.length > 0,
        acpOk: hostAcp.ok
      },
      sandbox: {
        createsEmptyDirsBeforeAcp: sandboxPrepareDiff.newDirs.length > 0,
        acpWritesFilesToCursorDataDir: sandboxCursorNewFiles.length > 0,
        acpWritesNonAttestationFilesToRuntime: sandboxAcpDiff.newFiles.length > 0,
        acpOk: sandboxAcp.ok
      }
    }
  }

  const out = join(process.cwd(), 'cursor-acp-writes-report.json')
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log('\n======== VERDICT ========')
  console.log(JSON.stringify(report.verdict, null, 2))
  console.log('full report:', out)
  console.log('=========================\n')

  process.exit(hostAcp.ok && sandboxAcp.ok ? 0 : 2)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
