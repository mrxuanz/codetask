import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { progress } from '../reports/progress'
import { BUSINESS_E2E_TEMP_PREFIX } from './run-layout'

/**
 * Business E2E state is per-run and lives under the OS temp directory. Preflight
 * therefore only reaps interrupted workers and their stale temp roots; it never
 * scans, copies, or deletes runtime/database state inside the repository.
 */
export function runPreflightCleanup(): void {
  killLeftoverBusinessProcesses()

  const removed: string[] = []
  for (const name of listDirNames(tmpdir())) {
    if (!name.startsWith(BUSINESS_E2E_TEMP_PREFIX)) continue
    const target = join(tmpdir(), name)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    removed.push(target)
  }

  progress('supervisor', 'preflight.temp_roots_cleared', { removed })
}

function killLeftoverBusinessProcesses(): void {
  const patterns = [
    BUSINESS_E2E_TEMP_PREFIX,
    'tests/business-e2e/supervisor/case-worker-main',
    'tests\\business-e2e\\supervisor\\case-worker-main'
  ]
  const signaled = killProcessesMatching(patterns)
  sleepMs(400)
  const hard = killProcessesMatching(patterns, true)
  sleepMs(200)
  progress('supervisor', 'preflight.processes_cleared', {
    patternsSignaled: signaled + hard
  })
}

function killProcessesMatching(patterns: string[], force = false): number {
  const selfPid = process.pid
  const parentPid = process.ppid
  const matches = processListMatching(patterns).filter(
    (row) => row.pid !== selfPid && row.pid !== parentPid
  )
  let signaled = 0
  for (const row of matches) {
    if (killPid(row.pid, force)) signaled += 1
  }
  return signaled
}

function matchesPattern(commandLine: string, patterns: string[]): boolean {
  const lower = commandLine.toLowerCase()
  const slashNormalized = lower.replace(/\//g, '\\')
  const compact = lower.replace(/["']+/g, ' ').replace(/\s+/g, ' ')
  for (const pattern of patterns) {
    const normalizedPattern = pattern.toLowerCase()
    if (
      lower.includes(normalizedPattern) ||
      slashNormalized.includes(normalizedPattern.replace(/\//g, '\\'))
    ) {
      return true
    }
    if (compact.includes(normalizedPattern.replace(/\s+/g, ' '))) return true
  }
  return false
}

function processListMatching(patterns: string[]): Array<{ pid: number; commandLine: string }> {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 }
    )
    if ((result.status ?? 1) !== 0 || !result.stdout?.trim()) return []
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      const out: Array<{ pid: number; commandLine: string }> = []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const pid = Number((row as { ProcessId?: unknown }).ProcessId)
        const commandLine = String((row as { CommandLine?: unknown }).CommandLine ?? '')
        if (!Number.isFinite(pid) || pid <= 0 || !commandLine) continue
        if (matchesPattern(commandLine, patterns)) out.push({ pid, commandLine })
      }
      return out
    } catch {
      return []
    }
  }

  const result = spawnSync('ps', ['-ax', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  if ((result.status ?? 1) !== 0 || !result.stdout) return []
  const out: Array<{ pid: number; commandLine: string }> = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(\d+)\s+(.*)$/.exec(line.trim())
    if (!match) continue
    const pid = Number(match[1])
    const commandLine = match[2] ?? ''
    if (Number.isFinite(pid) && commandLine && matchesPattern(commandLine, patterns)) {
      out.push({ pid, commandLine })
    }
  }
  return out
}

function killPid(pid: number, force = false): boolean {
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T']
    if (force) args.push('/F')
    return (spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' }).status ?? 1) === 0
  }

  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
    return true
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
      return true
    } catch {
      return false
    }
  }
}

function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Busy-wait fallback for runtimes without Atomics.wait on the main thread.
    }
  }
}

function listDirNames(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}
