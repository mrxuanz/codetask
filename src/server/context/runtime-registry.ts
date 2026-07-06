export class RuntimeRegistry {
  private readonly inflightThreads = new Set<string>()
  private readonly planningJobs = new Set<string>()
  private readonly planningOwners = new Map<string, string>()

  isThreadInflight(threadId: string): boolean {
    return this.inflightThreads.has(threadId)
  }

  addInflightThread(threadId: string): void {
    this.inflightThreads.add(threadId)
  }

  removeInflightThread(threadId: string): void {
    this.inflightThreads.delete(threadId)
  }

  isJobPlanning(jobId: string): boolean {
    return this.planningJobs.has(jobId)
  }

  hasInflightPlanning(): boolean {
    return this.planningJobs.size > 0
  }

  findActivePlanningIdForUser(username: string, exceptId?: string): string | null {
    for (const jobId of this.planningJobs) {
      if (exceptId && jobId === exceptId) continue
      if (this.planningOwners.get(jobId) === username) return jobId
    }
    return null
  }

  tryStartJobPlanning(jobId: string, username?: string): boolean {
    if (this.planningJobs.has(jobId)) {
      return false
    }
    if (username) {
      const otherPlanning = this.findActivePlanningIdForUser(username, jobId)
      if (otherPlanning) return false
    }
    this.planningJobs.add(jobId)
    if (username) {
      this.planningOwners.set(jobId, username)
    }
    return true
  }

  endJobPlanning(jobId: string): void {
    this.planningJobs.delete(jobId)
    this.planningOwners.delete(jobId)
  }
}
