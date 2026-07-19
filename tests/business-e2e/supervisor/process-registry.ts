import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type TrackedProcess = {
  label: string
  pid: number
  startedAt: number
  caseRunId?: string
}

export class ProcessRegistry {
  private readonly processes = new Map<number, TrackedProcess>()

  constructor(private readonly pidsDir: string) {
    mkdirSync(pidsDir, { recursive: true })
  }

  track(entry: TrackedProcess): void {
    this.processes.set(entry.pid, entry)
    this.flush()
  }

  untrack(pid: number): void {
    this.processes.delete(pid)
    this.flush()
  }

  list(caseRunId?: string): TrackedProcess[] {
    const all = [...this.processes.values()]
    if (!caseRunId) return all
    return all.filter((item) => item.caseRunId === caseRunId)
  }

  stopExact(pid: number): void {
    const tracked = this.processes.get(pid)
    if (!tracked) return
    if (!isAlive(pid)) {
      this.untrack(pid)
      return
    }
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* ignore */
        }
      }
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && isAlive(pid)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
      if (isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
    this.untrack(pid)
  }

  stopCase(caseRunId: string): void {
    for (const item of this.list(caseRunId)) {
      this.stopExact(item.pid)
    }
  }

  stopAllExcept(keepPid?: number): void {
    for (const item of [...this.processes.values()]) {
      if (keepPid && item.pid === keepPid) continue
      this.stopExact(item.pid)
    }
  }

  private flush(): void {
    writeFileSync(
      join(this.pidsDir, 'registry.json'),
      JSON.stringify([...this.processes.values()], null, 2),
      'utf8'
    )
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
