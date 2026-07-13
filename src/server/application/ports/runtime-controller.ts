export interface RuntimeController {
  notifyPauseRequested(jobId: string): void
  closeThenRelease(runId: string, reason: string): Promise<void>
  stopAndRelease(runId: string, reason: string): Promise<void>
}
