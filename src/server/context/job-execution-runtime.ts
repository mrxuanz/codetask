export type JobControlState = 'running' | 'paused' | 'cancelling'

export interface JobExecutionRuntime {
  jobId: string
  username?: string
  control: JobControlState
  abortController: AbortController | null
}

export class JobExecutionRuntimeRegistry {
  private readonly runtimes = new Map<string, JobExecutionRuntime>()
  private readonly activeLoops = new Set<string>()

  get(jobId: string): JobExecutionRuntime | undefined {
    return this.runtimes.get(jobId)
  }

  isLoopActive(jobId: string): boolean {
    return this.activeLoops.has(jobId)
  }

  findActiveLoopJobIdForUser(username: string, exceptJobId?: string): string | null {
    for (const jobId of this.activeLoops) {
      if (exceptJobId && jobId === exceptJobId) continue
      const runtime = this.runtimes.get(jobId)
      if (runtime?.username === username) return jobId
    }
    return null
  }

  tryStartLoop(jobId: string, username?: string): boolean {
    if (this.activeLoops.has(jobId)) {
      return false
    }
    if (username) {
      const occupying = this.findActiveLoopJobIdForUser(username, jobId)
      if (occupying) return false
    }
    this.activeLoops.add(jobId)
    const runtime = this.ensureRuntime(jobId)
    runtime.control = 'running'
    if (username) {
      runtime.username = username
    }
    return true
  }

  endLoop(jobId: string): string | undefined {
    this.activeLoops.delete(jobId)
    const runtime = this.runtimes.get(jobId)
    const username = runtime?.username
    if (runtime && runtime.control !== 'paused') {
      this.runtimes.delete(jobId)
    }
    return username
  }

  attachAbortController(jobId: string, controller: AbortController): void {
    this.ensureRuntime(jobId).abortController = controller
  }

  clearAbortController(jobId: string): void {
    const runtime = this.runtimes.get(jobId)
    if (runtime) {
      runtime.abortController = null
    }
  }

  abortActiveTurn(jobId: string, reason?: unknown): void {
    this.runtimes.get(jobId)?.abortController?.abort(reason)
  }

  resumeExecution(jobId: string): void {
    const runtime = this.ensureRuntime(jobId)
    runtime.control = 'running'
    runtime.abortController = null
  }

  shouldStopExecution(jobId: string): 'pause' | 'cancel' | null {
    const runtime = this.runtimes.get(jobId)
    if (!runtime) return null
    if (runtime.control === 'cancelling') return 'cancel'
    if (runtime.control === 'paused') return 'pause'
    return null
  }

  setControl(jobId: string, control: JobControlState): void {
    this.ensureRuntime(jobId).control = control
  }

  ensureRuntime(jobId: string): JobExecutionRuntime {
    const existing = this.runtimes.get(jobId)
    if (existing) return existing
    const runtime: JobExecutionRuntime = {
      jobId,
      control: 'running',
      abortController: null
    }
    this.runtimes.set(jobId, runtime)
    return runtime
  }

  dropRuntime(jobId: string): void {
    this.activeLoops.delete(jobId)
    this.runtimes.delete(jobId)
  }

  dropAll(): void {
    for (const runtime of this.runtimes.values()) {
      try {
        runtime.abortController?.abort()
      } catch {
        // ignore
      }
    }
    this.activeLoops.clear()
    this.runtimes.clear()
  }
}
