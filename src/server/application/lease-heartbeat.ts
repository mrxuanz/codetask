export interface LeaseHeartbeatConfig {
  readonly heartbeatIntervalMs: number
  readonly staleThresholdMs: number
}

export class LeaseHeartbeatManager {
  private readonly heartbeats = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly config: LeaseHeartbeatConfig,
    private readonly onStale: (runId: string) => void
  ) {}

  startHeartbeat(runId: string, refreshFn: () => Promise<boolean>): void {
    this.stopHeartbeat(runId)

    const timer = setInterval(async () => {
      try {
        const ok = await refreshFn()
        if (!ok) {
          this.onStale(runId)
          this.stopHeartbeat(runId)
        }
      } catch {
        this.onStale(runId)
        this.stopHeartbeat(runId)
      }
    }, this.config.heartbeatIntervalMs)

    this.heartbeats.set(runId, timer)
  }

  stopHeartbeat(runId: string): void {
    const timer = this.heartbeats.get(runId)
    if (timer) {
      clearInterval(timer)
      this.heartbeats.delete(runId)
    }
  }

  stopAll(): void {
    for (const runId of this.heartbeats.keys()) {
      this.stopHeartbeat(runId)
    }
  }
}
