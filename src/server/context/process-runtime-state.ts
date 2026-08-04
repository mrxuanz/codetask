/** Single host process runtime admission + execution loop ownership (Batch R2). */
export class RuntimeRegistry {
  private readonly inflightConversations = new Set<string>()
  private readonly inflightConversationOwners = new Map<string, string>()
  private readonly planningJobs = new Set<string>()
  private readonly planningOwners = new Map<string, string>()
  private readonly planningRunIds = new Map<string, string>()
  private readonly planningControl = new Map<string, 'running' | 'paused'>()

  /** @deprecated Prefer isConversationInflight — Thread naming is historical. */
  isThreadInflight(threadId: string): boolean {
    return this.isConversationInflight(threadId)
  }

  isConversationInflight(conversationId: string): boolean {
    return this.inflightConversations.has(conversationId)
  }

  hasInflightThreads(): boolean {
    return this.hasInflightConversations()
  }

  hasInflightConversations(): boolean {
    return this.inflightConversations.size > 0
  }

  /** @deprecated Prefer addInflightConversation */
  addInflightThread(threadId: string, username?: string): void {
    this.addInflightConversation(threadId, username)
  }

  addInflightConversation(conversationId: string, username?: string): void {
    this.inflightConversations.add(conversationId)
    if (username) {
      this.inflightConversationOwners.set(conversationId, username)
    }
  }

  /** @deprecated Prefer removeInflightConversation */
  removeInflightThread(threadId: string): void {
    this.removeInflightConversation(threadId)
  }

  removeInflightConversation(conversationId: string): void {
    this.inflightConversations.delete(conversationId)
    this.inflightConversationOwners.delete(conversationId)
  }

  countInflightForUser(username: string): number {
    let count = 0
    for (const owner of this.inflightConversationOwners.values()) {
      if (owner === username) count++
    }
    return count
  }

  isJobPlanning(jobId: string): boolean {
    return this.planningJobs.has(jobId)
  }

  hasInflightPlanning(): boolean {
    return this.planningJobs.size > 0
  }

  findActivePlanningId(exceptId?: string): string | null {
    for (const jobId of this.planningJobs) {
      if (exceptId && jobId === exceptId) continue
      return jobId
    }
    return null
  }

  findActivePlanningIdForUser(username: string, exceptId?: string): string | null {
    for (const jobId of this.planningJobs) {
      if (exceptId && jobId === exceptId) continue
      if (this.planningOwners.get(jobId) === username) return jobId
    }
    return null
  }

  tryStartJobPlanning(jobId: string, username?: string, runId?: string): boolean {
    if (this.planningJobs.has(jobId)) {
      // A durable retry/reconcile for the same logical job supersedes an older
      // run token. This keeps late finalizers fenced even if process-local
      // admission survived the prior run.
      if (username) this.planningOwners.set(jobId, username)
      if (runId) this.planningRunIds.set(jobId, runId)
      return false
    }
    const otherPlanning = this.findActivePlanningId(jobId)
    if (otherPlanning) return false
    this.planningJobs.add(jobId)
    if (username) {
      this.planningOwners.set(jobId, username)
    }
    if (runId) {
      this.planningRunIds.set(jobId, runId)
    }
    return true
  }

  endJobPlanning(jobId: string, runId?: string): boolean {
    const activeRunId = this.planningRunIds.get(jobId)
    if (runId && activeRunId && activeRunId !== runId) return false
    this.planningJobs.delete(jobId)
    this.planningOwners.delete(jobId)
    this.planningRunIds.delete(jobId)
    this.planningControl.delete(jobId)
    return true
  }

  setPlanningControl(jobId: string, control: 'running' | 'paused'): void {
    this.planningControl.set(jobId, control)
  }

  shouldStopPlanning(jobId: string): boolean {
    return this.planningControl.get(jobId) === 'paused'
  }

  clearPlanningControl(jobId: string): void {
    this.planningControl.delete(jobId)
  }
}
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

  /** Process-global active execution loop (capacity 1). */
  findActiveLoopJobId(exceptJobId?: string): string | null {
    for (const jobId of this.activeLoops) {
      if (exceptJobId && jobId === exceptJobId) continue
      return jobId
    }
    return null
  }

  tryStartLoop(jobId: string, username?: string): boolean {
    if (this.activeLoops.has(jobId)) {
      return false
    }
    // F2: execution pool capacity is process-global 1 — any active loop blocks a new one.
    const occupying = this.findActiveLoopJobId(jobId)
    if (occupying) return false
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
