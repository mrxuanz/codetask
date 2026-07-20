import type { AnySandboxPolicy, SandboxEvidence } from './types'
import { assertSandboxEvidence, sha256Policy } from './evidence'
import { SandboxError } from './types'
import type { SandboxChild } from '../../../native/codeteam-sandbox/index.d'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { loadSandboxNative } from './native'
import { SANDBOX_REAP_POLL_MS, type SandboxReapStatus } from './session-state'
import { serializeSandboxPolicy } from './wire'

export interface SpawnedSandboxWorker {
  handle: SandboxChild
  policy: AnySandboxPolicy
}

export interface LaunchedSandbox extends SpawnedSandboxWorker {
  evidence: SandboxEvidence
}

const ATTESTATION_TIMEOUT_MS = 10_000

function mapEvidence(raw: SandboxChild['evidence']): SandboxEvidence {
  return {
    protocolVersion: raw.protocolVersion as 1 | 2,
    active: true,
    backend: raw.backend as SandboxEvidence['backend'],
    policySha256: raw.policySha256,
    sandboxPid: raw.sandboxPid,
    effectiveReadRootsHash: raw.effectiveReadRootsHash,
    effectiveWriteRootsHash: raw.effectiveWriteRootsHash,
    warnings: raw.warnings ?? []
  }
}

export async function launchSandboxedWorker(input: {
  policy: AnySandboxPolicy
  command: string
  args: string[]
  env: Record<string, string>
  readRoots?: string[] | undefined
  writeRoots?: string[] | undefined
  signal?: AbortSignal | undefined
}): Promise<SpawnedSandboxWorker> {
  sandboxTurnDebug('sandbox launcher: load native + spawn', {
    command: input.command,
    args: input.args,
    cwd: input.policy.cwd,
    role: input.policy.role,
    policyVersion: input.policy.version
  })
  const native = loadSandboxNative()
  const handle = native.launchSandboxedWorker({
    policyJson: serializeSandboxPolicy(input.policy),
    command: input.command,
    args: input.args,
    cwd: input.policy.cwd,
    env: Object.entries(input.env).map(([key, value]) => ({ key, value })),
    readRoots: input.readRoots,
    writeRoots: input.writeRoots
  })

  const abortHandler = (): void => {
    handle.kill()
  }
  if (input.signal?.aborted) {
    abortHandler()
  } else {
    input.signal?.addEventListener('abort', abortHandler, { once: true })
  }

  sandboxTurnDebug('sandbox launcher: spawn handle ready', {
    pid: handle.pid,
    policyVersion: input.policy.version
  })

  return { handle, policy: input.policy }
}

export function awaitSandboxWorkerAttestation(
  spawned: SpawnedSandboxWorker,
  options?: { timeoutMs?: number }
): LaunchedSandbox {
  const { handle, policy } = spawned
  const timeoutMs = options?.timeoutMs ?? ATTESTATION_TIMEOUT_MS

  sandboxTurnDebug('sandbox launcher: waiting for attestation', { timeoutMs })

  const attested = handle.waitForAttestation(timeoutMs)
  if (!attested) {
    handle.kill()
    handle.close()
    throw new SandboxError(
      `sandbox helper attestation timed out after ${timeoutMs}ms`,
      'sandbox.launcher.attestation_timeout'
    )
  }

  const evidence = mapEvidence(handle.evidence)
  assertSandboxEvidence(evidence, policy)

  if (evidence.policySha256 !== sha256Policy(policy)) {
    handle.kill()
    handle.close()
    throw new SandboxError(
      'sandbox addon policy attestation mismatch',
      'sandbox.launcher.attestation'
    )
  }

  sandboxTurnDebug('sandbox launcher: attestation complete', {
    pid: handle.pid,
    backend: evidence.backend,
    sandboxPid: evidence.sandboxPid,
    policyVersion: evidence.protocolVersion,
    readRootsHash: evidence.effectiveReadRootsHash,
    writeRootsHash: evidence.effectiveWriteRootsHash
  })

  return { handle, evidence, policy }
}

export function pollSandboxExit(handle: SandboxChild): number | null {
  return handle.pollExit()
}

export interface ReapSandboxChildResult {
  code: number | null
  status: SandboxReapStatus
}

export async function reapSandboxChild(
  handle: SandboxChild,
  options?: { pollMs?: number; maxWaitMs?: number; signal?: AbortSignal | undefined }
): Promise<ReapSandboxChildResult> {
  const pollMs = options?.pollMs ?? SANDBOX_REAP_POLL_MS
  const maxWaitMs = options?.maxWaitMs ?? 0
  const started = Date.now()

  const abortIfNeeded = (): ReapSandboxChildResult | null => {
    if (!options?.signal?.aborted) return null
    handle.kill()
    handle.close()
    return { code: -1, status: 'cancelled' }
  }

  while (true) {
    const aborted = abortIfNeeded()
    if (aborted) {
      sandboxTurnDebug('sandbox launcher: reapSandboxChild cancelled', aborted)
      return aborted
    }

    const code = pollSandboxExit(handle)
    if (code !== null) {
      sandboxTurnDebug('sandbox launcher: reapSandboxChild done', { code, status: 'exited' })
      return { code, status: 'exited' }
    }

    if (maxWaitMs > 0 && Date.now() - started > maxWaitMs) {
      handle.kill()
      handle.close()
      sandboxTurnDebug('sandbox launcher: reapSandboxChild timed out', { maxWaitMs })
      return { code: -1, status: 'timed_out' }
    }

    await sleep(pollMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function drainStdoutBuffer(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = []
  let rest = buffer
  let newline = rest.indexOf('\n')
  while (newline !== -1) {
    const line = rest.slice(0, newline).trim()
    rest = rest.slice(newline + 1)
    if (line) lines.push(line)
    newline = rest.indexOf('\n')
  }
  return { lines, rest }
}

export async function* readSandboxStdoutLines(
  handle: SandboxChild,
  options?: {
    keepReading?: () => boolean
    pollExit?: () => number | null
    maxIdleMs?: number
    signal?: AbortSignal | undefined
  }
): AsyncGenerator<string> {
  const keepReading = options?.keepReading ?? (() => false)
  const pollExit = options?.pollExit
  const maxIdleMs = pollExit ? 0 : (options?.maxIdleMs ?? 120_000)
  let buffer = ''
  let lastDataAt = Date.now()
  let lastHeartbeatAt = Date.now()
  const heartbeatMs = 5_000

  while (true) {
    if (options?.signal?.aborted) {
      throw new SandboxError('sandbox turn cancelled', 'sandbox.turn.cancelled')
    }
    const chunk = handle.readStdoutChunk(64 * 1024)
    if (chunk.length > 0) {
      lastDataAt = Date.now()
      const drained = drainStdoutBuffer(buffer + chunk.toString('utf8'))
      buffer = drained.rest
      for (const line of drained.lines) {
        yield line
      }
      continue
    }

    let exitCode: number | null = null
    try {
      exitCode = pollExit?.() ?? null
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'sandbox.child_closed') {
        exitCode = -1
      } else {
        throw error
      }
    }
    if (exitCode !== null) {
      while (true) {
        const tail = handle.readStdoutChunk(64 * 1024)
        if (tail.length === 0) break
        const drained = drainStdoutBuffer(buffer + tail.toString('utf8'))
        buffer = drained.rest
        for (const line of drained.lines) {
          yield line
        }
      }
      if (buffer.length > 0) {
        const line = buffer.trim()
        if (line) yield line
        buffer = ''
      }
      break
    }

    if (keepReading()) {
      if (maxIdleMs > 0 && Date.now() - lastDataAt > maxIdleMs) {
        sandboxTurnDebug('readSandboxStdoutLines: idle timeout', { maxIdleMs })
        break
      }
      if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
        lastHeartbeatAt = Date.now()
        sandboxTurnDebug('readSandboxStdoutLines: waiting for stdout', {
          idleMs: Date.now() - lastDataAt,
          bufferBytes: buffer.length
        })
      }
      await sleep(25)
      continue
    }

    if (buffer.length > 0) {
      const line = buffer.trim()
      if (line) yield line
    }
    break
  }
}

export function terminateSandboxTree(handle: SandboxChild): void {
  handle.kill()
  handle.close()
}
