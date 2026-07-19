import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { progress } from '../reports/progress'

/**
 * Preflight on every business-e2e start:
 * 1) kill leftover processes
 * 2) always wipe test DB + .runtime (no carry-over jobs/drafts)
 * --keep-runtime is ignored for wipe (debug copies must be made before rerun).
 */
export function runPreflightCleanup(options: {
  repoRoot: string
  keepRuntime?: boolean
}): void {
  const e2eRoot = join(options.repoRoot, 'tests/business-e2e')
  const runtimeRoot = join(e2eRoot, '.runtime')
  const scratchDirs = [runtimeRoot, join(e2eRoot, '.tmp'), join(e2eRoot, '.cache')]

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
    forceRemoveDir(dir)
    if (existsSync(dir)) {
      sleepMs(400)
      killLeftoverBusinessProcesses(runtimeRoot)
      forceRemoveDir(dir)
    }
    cleared.push({ path: dir, removed })
  }

  // Second pass: any leftover sqlite under business-e2e
  const leftoverDbs = wipeTestDatabases(e2eRoot)
  if (leftoverDbs.length > 0) {
    progress('supervisor', 'preflight.database_clear_retry', { removed: leftoverDbs })
  }

  if (existsSync(runtimeRoot)) {
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
      rmSync(file, { force: true })
      removed.push(file)
    } catch {
      spawnSync('rm', ['-f', file], { encoding: 'utf8' })
      removed.push(file)
    }
  }
  // Also drop data/bootstrap trees that hold app.db
  for (const dir of findNamedDirs(e2eRoot, new Set(['data', 'bootstrap', 'db']))) {
    forceRemoveDir(dir)
    removed.push(dir)
  }
  return removed
}

function findDbFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
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
  const walk = (dir: string, depth: number) => {
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
    'tests/business-e2e/supervisor/case-worker-main',
    'business-e2e/.runtime/runs'
  ]
  let signaled = 0
  for (const pattern of patterns) {
    const soft = spawnSync('pkill', ['-f', pattern], { encoding: 'utf8' })
    if (soft.status === 0) signaled += 1
  }
  sleepMs(400)
  for (const pattern of patterns) {
    const hard = spawnSync('pkill', ['-9', '-f', pattern], { encoding: 'utf8' })
    if (hard.status === 0) signaled += 1
  }
  sleepMs(200)
  progress('supervisor', 'preflight.processes_cleared', { patternsSignaled: signaled })
}

function killLeftoverOpencodeServe(): void {
  const patterns = [
    'opencode serve --hostname=127.0.0.1',
    'opencode serve --hostname 127.0.0.1',
    'opencode-ai/bin/opencode serve',
    'opencode serve'
  ]
  let signaled = 0
  for (const pattern of patterns) {
    const result = spawnSync('pkill', ['-f', pattern], { encoding: 'utf8' })
    if (result.status === 0) signaled += 1
  }
  sleepMs(500)
  const leftover = spawnSync('pgrep', ['-fl', 'opencode serve'], { encoding: 'utf8' })
  const still = (leftover.stdout ?? '').trim()
  if (still) {
    spawnSync('pkill', ['-9', '-f', 'opencode serve'], { encoding: 'utf8' })
    sleepMs(300)
  }
  const after = spawnSync('pgrep', ['-fl', 'opencode serve'], { encoding: 'utf8' })
  progress('supervisor', 'preflight.opencode_serve_cleared', {
    patternsSignaled: signaled,
    remaining: (after.stdout ?? '').trim() ? (after.stdout ?? '').trim().split('\n').length : 0
  })
}

function forceRemoveDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch (error) {
    spawnSync('rm', ['-rf', dir], { encoding: 'utf8' })
    progress('supervisor', 'preflight.runtime_clear_retry', {
      path: dir,
      error: String(error)
    })
  }
}

function sleepMs(ms: number): void {
  spawnSync('sleep', [String(ms / 1000)])
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
