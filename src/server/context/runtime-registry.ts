export class RuntimeRegistry {
  private readonly inflightThreads = new Set<string>()
  private readonly inflightThreadOwners = new Map<string, string>()
  private readonly planningJobs = new Set<string>()
  private readonly planningOwners = new Map<string, string>()
  private readonly planningRunIds = new Map<string, string>()
  private readonly planningControl = new Map<string, 'running' | 'paused'>()

  isThreadInflight(threadId: string): boolean {
    return this.inflightThreads.has(threadId)
  }

  hasInflightThreads(): boolean {
    return this.inflightThreads.size > 0
  }

  addInflightThread(threadId: string, username?: string): void {
    this.inflightThreads.add(threadId)
    if (username) {
      this.inflightThreadOwners.set(threadId, username)
    }
  }

  removeInflightThread(threadId: string): void {
    this.inflightThreads.delete(threadId)
    this.inflightThreadOwners.delete(threadId)
  }

  countInflightForUser(username: string): number {
    let count = 0
    for (const owner of this.inflightThreadOwners.values()) {
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
