import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { progress } from '../reports/progress'

/**
 * Preflight on every business-e2e start:
 * 1) kill leftover processes
 * 2) always wipe test DB + .runtime (no carry-over jobs/drafts)
 * --keep-runtime is ignored for wipe (debug copies must be made before rerun).
 */
export function runPreflightCleanup(options: { repoRoot: string; keepRuntime?: boolean }): void {
  const e2eRoot = join(options.repoRoot, 'tests/business-e2e')
  const runtimeRoot = join(e2eRoot, '.runtime')
  const scratchDirs = [runtimeRoot, join(e2eRoot, '.tmp'), join(e2eRoot, '.cache')]
  for (const name of listDirNames(e2eRoot)) {
    if (name.startsWith('.trash-') || name.startsWith('.runtime-trash-')) {
      scratchDirs.push(join(e2eRoot, name))
    }
  }

  if (options.keepRuntime) {
    progress('supervisor', 'preflight.keep_runtime', {
      note: '启动仍强制清空测试数据库与.runtime；如需留档请先自行拷贝'
    })
  }

  progress('supervisor', 'preflight.database_reset_begin', {
    note: '开始清空业务测试数据库与运行数据'
  })

  killLeftoverBusinessProcesses(runtimeRoot)
  killLeftoverOpencodeServe()

  // Explicit DB wipe first (in case dir delete is partial)
  const dbRemoved = wipeTestDatabases(e2eRoot)
  progress('supervisor', 'preflight.database_cleared', {
    removed: dbRemoved,
    note: '测试数据库已清空'
  })

  const cleared: Array<{ path: string; removed: number }> = []
  for (const dir of scratchDirs) {
    if (!existsSync(dir)) continue
    const removed = countEntries(dir)
    clearDirectoryWithRetries(dir, runtimeRoot)
    cleared.push({ path: dir, removed })
  }

  // Second pass: any leftover sqlite under business-e2e
  const leftoverDbs = wipeTestDatabases(e2eRoot)
  if (leftoverDbs.length > 0) {
    progress('supervisor', 'preflight.database_clear_retry', { removed: leftoverDbs })
  }

  if (existsSync(runtimeRoot) && countEntries(runtimeRoot) > 0) {
    progress('supervisor', 'preflight.runtime_clear_failed', { path: runtimeRoot })
    throw new Error(`preflight_runtime_not_cleared:${runtimeRoot}`)
  }

  const stillDb = findDbFiles(e2eRoot)
  if (stillDb.length > 0) {
    progress('supervisor', 'preflight.database_clear_failed', { stillDb })
    throw new Error(`preflight_database_not_cleared:${stillDb.join(',')}`)
  }

  mkdirSync(runtimeRoot, { recursive: true })
  progress('supervisor', 'preflight.runtime_cleared', {
    path: runtimeRoot,
    cleared,
    note: '已重置运行目录；本次将使用全新空库'
  })
}

/** Remove sqlite / data dirs used by prior business-e2e runs. */
function wipeTestDatabases(e2eRoot: string): string[] {
  const removed: string[] = []
  for (const file of findDbFiles(e2eRoot)) {
    try {
      rmSync(file, { force: true, maxRetries: 5, retryDelay: 100 })
      removed.push(file)
    } catch {
      forceRemovePath(file)
      removed.push(file)
    }
  }
  // Also drop data/bootstrap trees that hold app.db
  for (const dir of findNamedDirs(e2eRoot, new Set(['data', 'bootstrap', 'db']))) {
    forceRemovePath(dir)
    removed.push(dir)
  }
  return removed
}

function findDbFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        // Do not walk into node_modules / fixtures source trees
        if (name === 'node_modules' || name === 'fixtures' || name === 'skills') continue
        walk(full)
        continue
      }
      if (
        name === 'app.db' ||
        name.endsWith('.db') ||
        name.endsWith('.db-wal') ||
        name.endsWith('.db-shm') ||
        name.endsWith('.db-journal') ||
        name.endsWith('.sqlite') ||
        name.endsWith('.sqlite3')
      ) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out
}

function findNamedDirs(root: string, names: Set<string>): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (!existsSync(dir) || depth > 8) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'fixtures' || name === 'skills') continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      if (names.has(name) && dir.includes('.runtime')) out.push(full)
      walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

function killLeftoverBusinessProcesses(runtimeRoot: string): void {
  const patterns = [
    runtimeRoot,
    'tests/business-e2e/.runtime',
    'tests\\business-e2e\\.runtime',
    'tests/business-e2e/supervisor/case-worker-main',
    'business-e2e/.runtime/runs'
  ]
  const signaled = killProcessesMatching(patterns)
  sleepMs(400)
  const hard = killProcessesMatching(patterns, true)
  sleepMs(200)
  progress('supervisor', 'preflight.processes_cleared', {
    patternsSignaled: signaled + hard
  })
}

function killLeftoverOpencodeServe(): void {
  const isOpencodeServe = (commandLine: string): boolean => {
    const compact = commandLine.toLowerCase().replace(/["']+/g, ' ').replace(/\s+/g, ' ')
    return compact.includes('opencode') && /\sserve(\s|$)/.test(compact)
  }

  let signaled = 0
  for (const row of processListMatching(['opencode', 'opencode.exe'])) {
    if (!isOpencodeServe(row.commandLine)) continue
    if (killPid(row.pid, false)) signaled += 1
  }
  sleepMs(500)
  const leftover = processListMatching(['opencode', 'opencode.exe']).filter((row) =>
    isOpencodeServe(row.commandLine)
  )
  for (const row of leftover) {
    if (killPid(row.pid, true)) signaled += 1
  }
  if (leftover.length > 0) sleepMs(300)
  const remaining = processListMatching(['opencode', 'opencode.exe']).filter((row) =>
    isOpencodeServe(row.commandLine)
  ).length
  progress('supervisor', 'preflight.opencode_serve_cleared', {
    patternsSignaled: signaled,
    remaining
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
    const p = pattern.toLowerCase()
    if (lower.includes(p) || slashNormalized.includes(p.replace(/\//g, '\\'))) return true
    // Windows quoted argv: opencode.exe" "serve → still matches "opencode serve"
    if (compact.includes(p.replace(/\s+/g, ' '))) return true
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
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\d+)\s+(.*)$/.exec(trimmed)
    if (!match) continue
    const pid = Number(match[1])
    const commandLine = match[2] ?? ''
    if (!Number.isFinite(pid) || !commandLine) continue
    if (matchesPattern(commandLine, patterns)) out.push({ pid, commandLine })
  }
  return out
}

function killPid(pid: number, force = false): boolean {
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T']
    if (force) args.push('/F')
    const result = spawnSync('taskkill', args, {
      windowsHide: true,
      stdio: 'ignore'
    })
    return (result.status ?? 1) === 0
  }

  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    return true
  } catch {
    const result = spawnSync('kill', [force ? '-9' : '-TERM', String(pid)], {
      encoding: 'utf8',
      stdio: 'ignore'
    })
    return (result.status ?? 1) === 0
  }
}

function clearDirectoryWithRetries(dir: string, runtimeRoot: string): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    forceRemovePath(dir)
    if (!existsSync(dir)) return
    if (existsSync(dir) && countEntries(dir) === 0) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      if (!existsSync(dir)) return
    }
    progress('supervisor', 'preflight.runtime_clear_retry', {
      path: dir,
      attempt: attempt + 1,
      error: 'EPERM_or_busy'
    })
    killLeftoverBusinessProcesses(runtimeRoot)
    killLeftoverOpencodeServe()
    sleepMs(300 + attempt * 200)
  }
}

function forceRemovePath(target: string): void {
  if (!existsSync(target)) return

  // Prefer wiping children first — Windows often locks the root dir handle.
  try {
    const st = statSync(target)
    if (st.isDirectory()) {
      for (const name of readdirSync(target)) {
        forceRemovePath(join(target, name))
      }
    }
  } catch {
    /* ignore and continue with root delete */
  }

  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
    if (!existsSync(target)) return
  } catch (error) {
    progress('supervisor', 'preflight.runtime_clear_retry', {
      path: target,
      error: String(error)
    })
  }

  if (process.platform === 'win32') {
    // Rename-away helps when a handle still references the old path.
    const parent = dirname(target)
    const trash = join(
      parent,
      target.endsWith('.runtime') || target.replace(/\\/g, '/').endsWith('/.runtime')
        ? `.runtime-trash-${Date.now()}-${Math.random().toString(16).slice(2)}`
        : `.trash-${Date.now()}-${Math.random().toString(16).slice(2)}`
    )
    try {
      renameSync(target, trash)
      spawnSync('cmd.exe', ['/d', '/s', '/c', `rmdir /s /q "${trash}"`], {
        windowsHide: true,
        stdio: 'ignore'
      })
      try {
        rmSync(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        /* ignore */
      }
      if (!existsSync(target)) return
    } catch {
      /* fall through */
    }
    spawnSync('cmd.exe', ['/d', '/s', '/c', `rmdir /s /q "${target}"`], {
      windowsHide: true,
      stdio: 'ignore'
    })
    return
  }

  spawnSync('rm', ['-rf', target], { encoding: 'utf8', stdio: 'ignore' })
}

function sleepMs(ms: number): void {
  if (ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* busy wait fallback */
    }
  }
}

function countEntries(root: string): number {
  try {
    return readdirSync(root).length
  } catch {
    try {
      return statSync(root).isDirectory() ? 1 : 0
    } catch {
      return 0
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
